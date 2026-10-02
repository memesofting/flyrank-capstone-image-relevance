# ADR 002 — Temporary embedding dimension of 768

- Status: accepted (temporary, must be revisited in Phase 2)
- Date: 2026-10-02
- Phase: 1

## Context

`image_embeddings.embedding` and `post_embeddings.embedding` are `vector(N)`
columns with an HNSW cosine index. Postgres requires the dimension to be written
into the column type at creation time, so `N` has to be chosen before the
embedding model exists.

The embedding model is an explicit Phase 2/3 decision and is not yet made. The
candidate options from the project constraints are:

| Option | Dimensions |
|---|---|
| Gemini `text-embedding-004` | 768 |
| Gemini `gemini-embedding-001` | 3072 (supports truncation to 768/1536/2048) |
| Ollama `nomic-embed-text` | 768 |
| Ollama `mxbai-embed-large` | 1024 |

Two of the four candidates are 768, and 768 is the de-facto standard output size
for sentence-transformer-class models generally.

## Decision

Declare `vector(768)` in migration `002`, and centralise the number in
`src/config/constants.js` as `EMBEDDING_DIMENSION` so it is stated once.

## Consequences

**Good**

- The schema is fully migratable and testable in Phase 1, and the HNSW index
  can be created and verified now rather than discovered to be wrong in Phase 3.
- Most likely matches the eventual model, so the migration may never need
  changing.

**Bad**

- If Phase 2 selects a 1024- or 3072-dimension model, the column type must
  change and the HNSW index must be rebuilt.

**This is a known, accepted, and reversible risk.** It is deliberately not
hidden: `EMBEDDING_DIMENSION` carries an explicit comment marking it temporary,
and this ADR records the constraint so the change is a planned step in Phase 2
rather than a surprise. Changing it later is a single `ALTER TABLE ... TYPE
vector(1024) USING ...` plus an index rebuild, performed in a normal migration —
the runner supports exactly that (ADR 001).

Vectors must also be normalised before insertion so HNSW cosine distance and the
reported similarity score agree.

## Verification

`tests/integration/api.test.js` asserts that both embedding columns exist and
that both HNSW indexes were created, so the placeholder is at least verified to
be structurally correct.