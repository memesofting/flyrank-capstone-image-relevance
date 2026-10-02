#!/usr/bin/env node
/**
 * AI cost report — `npm run costs`.
 *
 * Makes requirement "costs are visible" concrete. Reports every ai_calls row
 * aggregated by provider/model/operation, plus a per-window budget comparison.
 *
 * Flags:
 *   --limit=N     how many individual calls to list (default 20, 0 for none)
 *   --window=W    today | month | all   (default: all)
 *   --failures    only FAILED calls
 *   --json        machine-readable output
 */

import { closePool } from '../src/db/pool.js';
import * as aiCallsRepository from '../src/repositories/aiCalls.repository.js';
import { checkBudget, formatUsd } from '../src/ai/cost/budgetGuard.js';

// INTERVAL values (not SQL), applied as `NOW() + $1::interval` in the repository.
const WINDOW_INTERVALS = {
  today: '1 day',
  month: '1 month',
  all: null,
};

function parseArgs(argv) {
  const args = { limit: 20, window: 'all', failuresOnly: false, json: false };

  for (const raw of argv) {
    const [flag, value] = raw.split('=');
    if (flag === '--limit') args.limit = Number(value);
    else if (flag === '--window') args.window = value ?? 'all';
    else if (flag === '--failures') args.failuresOnly = true;
    else if (flag === '--json') args.json = true;
    else throw new Error(`unknown flag: ${raw}`);
  }

  if (!Object.hasOwn(WINDOW_INTERVALS, args.window)) {
    throw new Error(`--window must be one of: ${Object.keys(WINDOW_INTERVALS).join(', ')}`);
  }

  return args;
}

const say = (line = '') => process.stdout.write(`${line}\n`);
const pad = (value, width) => String(value).padEnd(width);
const padStart = (value, width) => String(value).padStart(width);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const windowInterval = WINDOW_INTERVALS[args.window];

  const totals = await aiCallsRepository.summariseAiCalls({ windowInterval });
  const byModel = await aiCallsRepository.summariseAiCallsByModel({ windowInterval });
  const budget = await checkBudget();

  if (args.json) {
    say(JSON.stringify({ window: args.window, totals, byModel, budget }, null, 2));
    return 0;
  }

  say(`AI cost report (window: ${args.window})`);
  say('='.repeat(60));

  say(`calls          : ${totals.total_calls}  (${totals.successful_calls} ok, ${totals.failed_calls} failed)`);
  say(`models used    : ${totals.distinct_models}`);
  say(`input units    : ${totals.input_units}`);
  say(`output units   : ${totals.output_units}`);
  say(`estimated cost : ${formatUsd(totals.estimated_cost_usd)}`);

  say();
  say('by provider / model / operation:');
  say(
    `${pad('PROVIDER/MODEL', 34)}${pad('OPERATION', 20)}`
      + `${padStart('CALLS', 6)}${padStart('FAILED', 8)}${padStart('INPUT', 10)}${padStart('COST', 14)}`,
  );
  say('-'.repeat(92));

  for (const row of byModel) {
    say(
      pad(`${row.provider}/${row.model}`, 34)
        + pad(row.operation, 20)
        + padStart(row.calls, 6)
        + padStart(row.failures, 8)
        + padStart(row.input_units, 10)
        + padStart(formatUsd(row.estimated_cost_usd), 14),
    );
  }

  if (byModel.length === 0) {
    say('  (no AI calls recorded yet)');
  }

  say();
  say('budget:');
  say(`  today : ${formatUsd(budget.dailySpendUsd)}`
    + (budget.dailyLimitUsd === null ? ' (no limit configured)' : ` of ${formatUsd(budget.dailyLimitUsd)}`));
  say(`  month : ${formatUsd(budget.monthlySpendUsd)}`
    + (budget.monthlyLimitUsd === null ? ' (no limit configured)' : ` of ${formatUsd(budget.monthlyLimitUsd)}`));
  say(`  status: ${budget.allowed ? 'within budget' : 'REFUSED'}`);
  for (const reason of budget.reasons) {
    say(`    - ${reason}`);
  }

  if (args.limit > 0) {
    const calls = await aiCallsRepository.listAiCalls({
      limit: args.limit,
      status: args.failuresOnly ? 'FAILED' : undefined,
    });

    say();
    say(`recent calls${args.failuresOnly ? ' (failures only)' : ''}:`);

    for (const call of calls) {
      const cost = formatUsd(call.estimated_cost_usd);
      say(
        `  ${call.created_at.toISOString()}  ${pad(`${call.provider}/${call.model}`, 32)}`
          + `${pad(call.operation, 20)}${padStart(call.status, 9)}${padStart(cost, 13)}`,
      );
      if (call.error) {
        say(`      error: ${call.error}`);
      }
    }

    if (calls.length === 0) {
      say('  (none)');
    }
  }

  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    process.stderr.write(`FAILED: ${error.message}\n`);
    await closePool().catch(() => {});
    process.exit(1);
  });