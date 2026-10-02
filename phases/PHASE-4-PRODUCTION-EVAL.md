# Phase 4 — Production Layer, Review and Evaluation

## Goal

Harden the system, expose the review workflow, build the labeled evaluation set, measure top-1 precision, and finish submission documentation.

Phase gate:

> Evaluation precision is measured and submission documentation is complete.

## 1. Review API

Implement:

```http
GET  /api/suggestions
GET  /api/suggestions/:id
POST /api/suggestions/:id/approve
POST /api/suggestions/:id/reject
```

The inspection endpoint must show:

- candidate image,
- post,
- semantic similarity,
- vision confidence,
- detected subject/category,
- guard decision,
- explanation.

## 2. Evaluation dataset

Create at least 10 labeled cases.

Each case maps:

```text
post -> expected correct image
```

Persist them in `eval_cases` or a reproducible dataset file.

## 3. Evaluation command

Implement:

```bash
npm run eval
```

Output:

```text
Evaluation
----------
Total posts: 10
Correct top-1: 9
Top-1 precision: 0.90
```

The README must contain the same measured number.

## 4. Threshold tuning

Use the evaluation dataset to tune:

- semantic similarity threshold,
- minimum vision confidence,
- subject mismatch rules.

Do not tune only against the happy path.

Include hard negatives:

- fox vs wolf,
- dog vs wolf,
- similar background,
- generic animal image,
- low-confidence classification.

Record the selected thresholds and the evidence behind them.

## 5. Cost report

Provide a command or report showing:

```text
vision calls
embedding calls
total calls
estimated cost
failures
retries
```

Even when the provider is free-tier, calls must be attributed.

## 6. Production hardening

Verify:

- validation returns 4xx,
- retries are idempotent,
- secrets are not logged,
- jobs can fail without corrupting data,
- database transactions protect multi-step writes,
- vector indexes exist,
- health endpoint works.

Suggested:

```http
GET /health
```

Response:

```json
{
  "status": "ok",
  "database": "ok"
}
```

## 7. Documentation

Complete:

- `README.md`
- `EVIDENCE.md`
- `BUILDLOG.md`
- `capstone.yaml`
- `.env.example`

README must include:

- problem,
- architecture diagram,
- setup,
- database setup,
- seed command,
- batch command,
- evaluation command,
- API examples,
- measured top-1 precision,
- limitations.

## 8. Evidence

Every capstone requirement needs one concrete proof.

Acceptable evidence:

- command output,
- curl transcript,
- test output,
- log line,
- database query result.

Never write:

```text
"Requirement completed."
```

without proof.

## 9. Final acceptance probes

Run all six:

1. Batch corpus → schema-valid tags + low-confidence flag.
2. Fox post → fox first.
3. Force wolf → guard rejects with explanation.
4. No suitable image → no confident match.
5. Evaluation → top-1 precision.
6. Cost log → every AI/embedding call recorded.

## Final gate

Only call the project complete when:

- [ ] all acceptance probes pass
- [ ] README matches actual behavior
- [ ] top-1 precision is measured
- [ ] EVIDENCE.md has proof
- [ ] BUILDLOG.md is honest
- [ ] no secrets are committed
- [ ] main branch runs from clean checkout
