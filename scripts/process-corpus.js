#!/usr/bin/env node
/**
 * Corpus batch processor — `npm run process:corpus`.
 *
 * Runs the full Phase 2 flow over the corpus:
 *
 *   manifest -> ingest -> enqueue -> vision jobs -> embeddings -> cost report
 *
 * Runs from a CLI rather than an HTTP route so that multi-minute AI work can
 * never be started by, or block, a web request.
 *
 * Flags:
 *   --limit=N        process at most N images (default: MAX_IMAGE_BATCH_SIZE)
 *   --stage=STAGE    vision | embed | all      (default: all)
 *   --dry-run        ingest and enqueue, make no provider calls, spend nothing
 *   --no-ingest      skip ingestion, process whatever is already queued
 *   --reset          delete existing jobs first, so a run starts from zero
 *   --max-jobs=N     stop after N job executions (default 500)
 *   --model=NAME     override the vision model for this run
 *   --no-fallback    fail rather than trying the fallback model
 *
 * Exit codes:
 *   0  every queued job completed (or nothing was left to do)
 *   1  at least one job failed permanently, or the budget guard refused work
 *   2  bad usage or an unusable configuration
 */

import { closePool, query } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { PROMPT_VERSION } from '../src/config/constants.js';
import { createEmbeddingProvider, createVisionProvider } from '../src/ai/providers/createProvider.js';
import { registerPhase2Handlers } from '../src/jobs/jobHandlers/index.js';
import { runUntilEmpty } from '../src/jobs/jobRunner.js';
import { checkBudget, formatUsd, projectBatchCostUsd } from '../src/ai/cost/budgetGuard.js';
import * as aiCallsRepository from '../src/repositories/aiCalls.repository.js';
import * as imagesRepository from '../src/repositories/images.repository.js';
import {
  DEFAULT_MODEL_VERSION,
  EMBEDDING_OPERATION,
  VISION_OPERATION,
} from '../src/services/vision.service.js';
import {
  enqueueEmbeddingsForAnalysedImages,
  ingestCorpus,
} from '../src/services/imageIngestion.service.js';

function parseArgs(argv) {
  const args = {
    limit: null,
    stage: 'all',
    dryRun: false,
    ingest: true,
    reset: false,
    maxJobs: 500,
    model: null,
    noFallback: false,
    modelPool: [],
  };

  for (const raw of argv) {
    const [flag, value] = raw.split('=');

    switch (flag) {
      case '--limit':
        args.limit = Number(value);
        break;
      case '--stage':
        args.stage = value ?? 'all';
        break;
      case '--max-jobs':
        args.maxJobs = Number(value);
        break;
      case '--model':
        args.model = value ?? null;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--no-ingest':
        args.ingest = false;
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--no-fallback':
        args.noFallback = true;
        break;
      case '--model-pool':
        args.modelPool = String(value ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
        break;
      default:
        throw new UsageError(`unknown flag: ${raw}`);
    }
  }

  if (!['vision', 'embed', 'all'].includes(args.stage)) {
    throw new UsageError(`--stage must be vision, embed or all (got "${args.stage}")`);
  }

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new UsageError('--limit must be a positive integer');
  }

  return args;
}

class UsageError extends Error {}

/** Plain lines on purpose: this is operator-facing CLI output, not JSON logs. */
const say = (line = '') => process.stdout.write(`${line}\n`);

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function heading(text) {
  say();
  say(text);
  say('='.repeat(text.length));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = args.limit ?? env.MAX_IMAGE_BATCH_SIZE ?? 50;

  heading('FlyRank Phase 2 — corpus vision pipeline');

  if (args.dryRun) {
    say('DRY RUN: ingesting and enqueueing only. No provider calls, no spend.');
  }

  // --- providers -----------------------------------------------------------
  const { provider: firstVisionProvider, primaryModel, fallbackModel } = createVisionProvider({
    model: args.model,
  });

  // Run-level model resolution.
  //
  // The free tier allows 20 generateContent requests per MODEL per day, and
  // gemini-3.8-flash is already exhausted, so the primary cannot always run.
  // A batch must not silently mix models, though: image_metadata is keyed per
  // model, so a half-3.8 / half-3.5 corpus looks like two separate corpora to
  // Phase 4's precision measurement, and nothing in the rows says which run
  // produced which.
  //
  // So the run commits to one model. Candidates are tried in order, and the
  // next is only used when the previous produced nothing at all — a single
  // quota wall costs one request, not the whole budget. If some images were
  // already analysed, the run stops rather than mixing.
  // An explicit pool. The free tier allows roughly 20 generateContent requests
  // per model per day, so 61 images cannot be analysed on one model in one day —
  // this is a hard external limit, not a configuration choice. --model-pool
  // walks a list of models, using each until its quota runs out, and every
  // image_metadata row records which model produced it.
  //
  // The trade-off is real and deliberate: captions then come from more than one
  // model, so Phase 4's precision figure is not a single-model measurement. It
  // is opt-in and never the default, because run-level consistency is the better
  // default and the pool is the tool for when the quota makes that impossible.
  const candidateModels = args.modelPool?.length
    ? args.modelPool
    : args.noFallback
      ? [primaryModel]
      : [primaryModel, fallbackModel].filter(Boolean);

  const { provider: embeddingProvider, model: embeddingModel } = createEmbeddingProvider();

  let visionProvider = firstVisionProvider;
  say(`vision model     : ${candidateModels.join(' then ')}`);
  if (candidateModels.length > 1) {
    say(`                   (resolved once per run; a batch never mixes models)`);
  }
  say(`embedding model  : ${embeddingProvider.name}/${embeddingModel}`);
  say(`prompt version   : ${PROMPT_VERSION}`);
  say(`model version    : ${DEFAULT_MODEL_VERSION}`);
  say(`max images       : ${limit}`);

  registerPhase2Handlers({ visionProvider, embeddingProvider });

  // --- reset ---------------------------------------------------------------
  if (args.reset) {
    const { rows } = await query(
      `DELETE FROM jobs WHERE type IN ($1, $2) RETURNING id`,
      [VISION_OPERATION, EMBEDDING_OPERATION],
    );
    say(`reset: deleted ${rows.length} existing job(s)`);
  }

  // --- budget guard --------------------------------------------------------
  const projected = projectBatchCostUsd({
    imageCount: limit,
    model: visionProvider.model,
  });

  heading('Budget check');
  say(`projected worst-case vision cost: ${formatUsd(projected)}`);

  if (!args.dryRun) {
    const status = await checkBudget({ projectedBatchCostUsd: projected });

    say(`spent today : ${formatUsd(status.dailySpendUsd)}${status.dailyLimitUsd === null ? '' : ` of ${formatUsd(status.dailyLimitUsd)}`}`);
    say(`this month  : ${formatUsd(status.monthlySpendUsd)}${status.monthlyLimitUsd === null ? '' : ` of ${formatUsd(status.monthlyLimitUsd)}`}`);

    if (!status.allowed) {
      say();
      say('BUDGET REFUSED:');
      for (const reason of status.reasons) {
        say(`  - ${reason}`);
      }
      return 1;
    }

    say('within budget');
  }

  // --- ingest --------------------------------------------------------------
  if (args.ingest) {
    heading('Ingestion');

    const summary = await ingestCorpus({
      model: visionProvider.model,
      maxImages: limit,
    });

    say(`manifest entries seen : ${summary.seen}`);
    say(`new image rows        : ${summary.inserted}`);
    say(`reused existing rows  : ${summary.reused}`);
    say(`vision jobs enqueued  : ${summary.enqueued}`);
    say(`already analysed       : ${summary.alreadyAnalysed} (skipped, not re-derived)`);

    if (summary.rejected > 0) {
      say(`REJECTED              : ${summary.rejected}`);
      for (const problem of summary.problems) {
        say(`  - ${problem.id}: ${problem.reason}`);
      }
    }
  }

  if (args.dryRun) {
    heading('Queued work');
    const counts = await imagesRepository.countImagesByStatus();
    for (const row of counts) {
      say(`images ${row.status.padEnd(12)} ${row.total}`);
    }
    say();
    say('Dry run complete. Nothing was sent to any provider.');
    return 0;
  }

  // --- run -----------------------------------------------------------------
  let quotaStopped = false;

  const totals = { completed: 0, retried: 0, failed: 0, deferred: 0, waited: 0 };

  if (args.stage === 'vision' || args.stage === 'all') {
    heading('Vision analysis');

    for (const [index, model] of candidateModels.entries()) {
      if (index > 0) {
        say();
        say(`switching to fallback model: ${model}`);
      } else {
        say(`[vision] starting with ${visionProvider.name}/${model}`);
      }

      // Re-register so the handler is bound to the model this run committed to.
      // The handler passes visionProvider.model into analyseImage, which is what
      // lands in image_metadata.model and into the job idempotency key.
      if (index > 0) {
        visionProvider = createVisionProvider({ model }).provider;
        registerPhase2Handlers({ visionProvider, embeddingProvider });
      }

      const summary = await runUntilEmpty({
        type: VISION_OPERATION,
        maxJobs: args.maxJobs,
        checkBudget: () => checkBudget(),
        onProgress: (info) => {
          if (info.event === 'retry') {
            say(`[vision] job=${info.job.id} status=retry attempt=${info.job.attempts} in ${info.delayMs}ms`);
          } else if (info.event === 'wait') {
            say(`[vision] rate limited; waiting ${formatDuration(info.delayMs)}`);
          } else if (info.event === 'deferred') {
            say(`[vision] job=${info.job.id} status=deferred wait=${formatDuration(info.delayMs)}`);
          } else if (info.event === 'failed') {
            say(`[vision] job=${info.job.id} status=failed error=${info.error?.message ?? info.error}`);
          }
        },
      });

      totals.completed += summary.completed;
      totals.retried += summary.retried;
      totals.failed += summary.failed;
      totals.deferred += summary.deferred;
      totals.waited += summary.waited;
      say(`[vision] completed=${summary.completed} retried=${summary.retried} rate-limited=${summary.waited} deferred=${summary.deferred} failed=${summary.failed}`);

      if (!summary.stoppedByQuota) {
        break;
      }

      quotaStopped = true;

      if (index === candidateModels.length - 1) {
        break;
      }

      // In pool mode a quota wall is the expected reason to move on, even after
      // successful work: the next model has its own daily allowance. Every row
      // records the model that produced it, so the corpus stays attributable.
      if (args.modelPool.length === 0) {
        // Default behaviour: refuse to mix models within one corpus without an
        // explicit --model-pool.
        if (summary.completed > 0 || summary.failed > 0) {
          say();
          say('not switching models mid-corpus: this run already wrote analysis rows.');
          say('Re-run later, when the quota window has reset, to continue with the');
          say('fallback. Unstarted images remain PENDING.');
          say('Use --model-pool=a,b to deliberately span several models instead.');
          break;
        }
      }
    }
  }

  if (args.stage === 'embed' || args.stage === 'all') {
    heading('Caption embeddings');

    const { enqueued, skipped } = await enqueueEmbeddingsForAnalysedImages({
      model: embeddingProvider.model,
    });
    say(`embedding jobs enqueued: ${enqueued} (already embedded: ${skipped})`);

    const summary = await runUntilEmpty({
      type: EMBEDDING_OPERATION,
      maxJobs: args.maxJobs,
      checkBudget: () => checkBudget(),
      onProgress: (info) => {
        if (info.event === 'retry') {
          say(`[embed] job=${info.job.id} status=retry attempt=${info.job.attempts}`);
        } else if (info.event === 'deferred') {
          say(`[embed] job=${info.job.id} status=deferred wait=${formatDuration(info.delayMs)}`);
        } else if (info.event === 'failed') {
          say(`[embed] job=${info.job.id} status=failed error=${info.error?.message ?? info.error}`);
        }
      },
    });

    totals.completed += summary.completed;
    totals.retried += summary.retried;
    totals.failed += summary.failed;
    totals.deferred += summary.deferred;
    say(`[embed] completed=${summary.completed} retried=${summary.retried} deferred=${summary.deferred} failed=${summary.failed}`);

    if (summary.stoppedByQuota) {
      quotaStopped = true;
    }
  }

  // --- report --------------------------------------------------------------
  heading('Results');

  const statuses = await imagesRepository.countImagesByStatus();
  for (const row of statuses) {
    say(`images ${row.status.padEnd(12)} ${row.total}`);
  }

  const metadata = await imagesRepository.summariseImageMetadata({});
  say();
  say('validation status:');
  for (const row of metadata) {
    say(
      `  ${row.validation_status.padEnd(15)} ${String(row.total).padStart(3)} images  `
        + `avg confidence ${row.avg_confidence ?? 'n/a'}`,
    );
  }

  const embeddings = await imagesRepository.countImageEmbeddings();
  say();
  say(`image embeddings: ${embeddings}`);

  heading('Cost');
  const callTotals = await aiCallsRepository.summariseAiCalls();
  say(`ai_calls rows   : ${callTotals.total_calls} (${callTotals.successful_calls} ok, ${callTotals.failed_calls} failed)`);
  say(`input tokens    : ${callTotals.input_units}`);
  say(`output tokens   : ${callTotals.output_units}`);
  say(`estimated cost  : ${formatUsd(callTotals.estimated_cost_usd)}`);

  const byModel = await aiCallsRepository.summariseAiCallsByModel();
  say();
  say('by provider/model/operation:');
  for (const row of byModel) {
    say(
      `  ${row.provider}/${row.model} ${row.operation}`.padEnd(52)
        + `${String(row.calls).padStart(4)} calls  ${formatUsd(row.estimated_cost_usd)}`
        + (row.failures > 0 ? `  (${row.failures} failed)` : ''),
    );
  }

  say();
  say(`totals: completed=${totals.completed} retried=${totals.retried} rate-limited=${totals.waited} deferred=${totals.deferred} failed=${totals.failed}`);

  if (quotaStopped) {
    say();
    say('PAUSED: the provider free-tier quota is exhausted.');
    say('This is a rate limit, not a failure. Work already completed is saved;');
    say('unstarted images are still PENDING and will be picked up by the next run.');
    say('No attempt budget was spent, so no image was marked FAILED for this.');
    return 1;
  }

  if (totals.failed > 0) {
    say();
    say('Some images have no schema-valid analysis. They are marked FAILED and');
    say('their raw responses remain in ai_calls for inspection.');
    return 1;
  }

  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    process.stderr.write(`\n${error instanceof UsageError ? '' : 'FAILED: '}${error.message}\n`);
    if (error instanceof UsageError) {
      process.stderr.write('\nUsage: npm run process:corpus -- [--limit=N] [--stage=vision|embed|all]\n');
      process.stderr.write('       [--dry-run] [--no-ingest] [--reset] [--max-jobs=N] [--model=NAME]\n');
      process.stderr.write('       [--no-fallback]\n');
    }
    await closePool().catch(() => {});
    process.exit(error instanceof UsageError ? 2 : 1);
  });