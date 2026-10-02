# API Contract

Base path:

```text
/api
```

## Posts

### Create post

```http
POST /api/posts
Content-Type: application/json
```

Request:

```json
{
  "title": "The Behavior of Red Foxes",
  "content": "Red foxes are..."
}
```

Response:

```json
{
  "id": "uuid",
  "title": "The Behavior of Red Foxes",
  "status": "CREATED"
}
```

### Get post

```http
GET /api/posts/:id
```

### Get ranked images for post

```http
GET /api/posts/:id/images
```

Response shape:

```json
{
  "postId": "uuid",
  "status": "MATCHED",
  "results": [
    {
      "imageId": "uuid",
      "rank": 1,
      "semanticSimilarity": 0.91,
      "guardStatus": "ACCEPTED",
      "reason": "..."
    }
  ]
}
```

If nothing clears the guard:

```json
{
  "postId": "uuid",
  "status": "NO_CONFIDENT_MATCH",
  "results": [],
  "reasons": [
    "Similarity below threshold",
    "Candidate subject mismatch"
  ]
}
```

## Images

### Upload image

```http
POST /api/images
Content-Type: multipart/form-data
```

Fields:

```text
image=<binary>
```

Response:

```json
{
  "id": "uuid",
  "status": "PENDING",
  "jobId": "uuid"
}
```

The request must not wait for vision inference.

### Get image

```http
GET /api/images/:id
```

Returns image metadata and processing status.

## Jobs

### Get job

```http
GET /api/jobs/:id
```

Response:

```json
{
  "id": "uuid",
  "type": "IMAGE_UNDERSTANDING",
  "status": "PROCESSING",
  "progress": 60,
  "attempts": 1
}
```

## Suggestions

### List suggestions

```http
GET /api/suggestions?postId=<uuid>
```

### Inspect suggestion

```http
GET /api/suggestions/:id
```

Must expose enough information to explain:

- similarity,
- vision confidence,
- detected subject/category,
- guard status,
- guard reason.

## Reviews

### Approve

```http
POST /api/suggestions/:id/approve
Content-Type: application/json
```

```json
{
  "notes": "Correct image for the post."
}
```

### Reject

```http
POST /api/suggestions/:id/reject
Content-Type: application/json
```

```json
{
  "notes": "This is a wolf, not a fox."
}
```

## Evaluation

### Run evaluation

```http
POST /api/evaluation/run
```

For a small capstone, this may instead be a CLI command.

Recommended CLI:

```bash
npm run eval
```

Output:

```text
Top-1 precision: 0.90
Correct: 9
Total: 10
```

## Error format

All client errors should have a consistent shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "title is required",
    "details": []
  }
}
```

Use 4xx for bad client input.

Do not convert validation errors into 500 responses.

## Idempotency

For operations that can be retried:

```http
Idempotency-Key: <unique-key>
```

or derive an internal idempotency key from entity + operation + model version.

Repeated requests must not create duplicate AI jobs or duplicate logical embeddings.

---

# Phase 1 implementation (as built)

The design above is the target. Phase 1 ships a subset of it, plus the
implementation conventions the rest of the API must follow. Full rationale for
the reduced scope: `docs/adr/003-phase1-api-scope.md`.

## Endpoints implemented in Phase 1

| Method | Path | Success | Purpose |
|---|---|---|---|
| `GET` | `/health` | 200 | liveness; does not touch the database |
| `GET` | `/health/ready` | 200 | readiness; runs `SELECT 1` with a timeout |
| `POST` | `/api/posts` | 201 | create a post |
| `GET` | `/api/posts` | 200 | list posts (`limit`, `offset`, `total`) |
| `GET` | `/api/posts/:id` | 200 | fetch one post by UUID |

### `GET /health`

Liveness only. Intentionally independent of PostgreSQL so that a database
outage does not mark the process unhealthy and get it killed.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 12.44
}
```

### `GET /health/ready`

Returns 200 when the database answers within `HEALTHCHECK_TIMEOUT_MS`
(default 2000), 503 otherwise.

```json
{ "status": "ok", "database": "ok" }
```

### `POST /api/posts`

Request body — both fields required, no additional properties permitted:

```json
{
  "title": "The Behavior of Red Foxes",
  "content": "Red foxes are small omnivorous canids that live in woodland."
}
```

Response `201`:

```json
{
  "id": "1f0f6b4a-1b8e-4a4c-9c6a-6f3f0d0a1234",
  "title": "The Behavior of Red Foxes",
  "slug": "the-behavior-of-red-foxes",
  "content": "Red foxes are small omnivorous canids that live in woodland.",
  "createdAt": "2026-10-02T10:00:00.000Z",
  "updatedAt": "2026-10-02T10:00:00.000Z",
  "status": "CREATED"
}
```

The create response is the read response plus `status`.

The slug is derived from the title, never supplied by the client. On collision a
short UUID suffix is appended, so creating two posts with the same title yields
`the-behavior-of-red-foxes` and `the-behavior-of-red-foxes-1f0f6b4a`. A UNIQUE
constraint on `posts.slug` makes this safe under concurrency.

### `GET /api/posts`

Query parameters: `limit` (default 50, max 100), `offset` (default 0).
Out-of-range values return 400, not 500.

```json
{
  "posts": [
    {
      "id": "…",
      "title": "…",
      "slug": "…",
      "content": "…",
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "total": 12,
  "limit": 50,
  "offset": 0
}
```

List items carry the same fields as `GET /api/posts/:id` and are ordered
`created_at DESC, id DESC`, so pagination is stable when two posts share a
timestamp. A single serializer (`toPostResponse`) builds all three post
responses, so the shapes cannot drift apart — asserted by a test.

### `GET /api/posts/:id`

`id` must be a UUID. A non-UUID is a 400 `VALIDATION_ERROR` (malformed input); a
well-formed UUID with no row is a 404 `NOT_FOUND` (missing resource).

## Error format

Every error, without exception:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body: title",
    "details": [ { "path": "title", "message": "Required" } ]
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | request failed Zod validation |
| `NOT_FOUND` | 404 | resource does not exist, or unknown route |
| `SERVICE_UNAVAILABLE` | 503 | readiness probe could not reach the database |
| `INTERNAL_ERROR` | 500 | unexpected failure — logged, never detailed to the client |

Rules honoured by the implementation:

- A validation failure never becomes a 500.
- A stack trace is never included in a response body.
- `details` is always present and always an array, empty when not applicable, so
  a client parses one shape in every environment. `details` is built only from
  Zod issue messages about the caller's own request, so exposing it is safe;
  internal failure text is withheld separately by replacing the message with
  `Internal server error`.
- Unknown fields are rejected rather than silently dropped, so a client cannot
  believe it set a field that was discarded.
- `errorHandler` is the only code that writes an error response body.
  `notFoundHandler` throws an `AppError` instead of calling `res.json()` itself,
  so an unmatched route cannot drift into a different shape. Asserted by a test.
- Every error is logged server-side with the method, path, status, code, and the
  original error object.

## Conventions for the remaining endpoints

The endpoint contract above must be completed as the project expands. Anything
that adds an AI call must also:

- keep the call inside a background job, never inside a request handler;
- return the persisted job id, so progress is pollable;
- make the operation idempotent — see the `Idempotency` section above;
- record provider, model, operation, entity id, tokens, estimated cost,
  timestamp, and success/failure in `ai_calls`.

## Deviations from `docs/API.md`

1. The `Idempotency-Key` header is not implemented in Phase 1. It becomes
   mandatory with the first retried AI operation, in Phase 2, when there is
   actually a retry to deduplicate. Post creation is idempotency-key-free by
   design and simply allows duplicate posts, which is harmless.
2. No `status` envelope field is added to non-post responses beyond what is
   shown; the envelope is defined per-resource as endpoints are built, to avoid
   inventing a shape that Phase 2 would immediately contradict.
