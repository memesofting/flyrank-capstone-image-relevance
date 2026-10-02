-- 002_embeddings_and_suggestions.down.sql
-- Undoes 002_embeddings_and_suggestions.sql.
--
-- DROP TABLE removes that table's indexes and triggers with it, including the
-- HNSW vector indexes and the unique indexes that provide idempotency.

DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS suggestions;
DROP TABLE IF EXISTS post_embeddings;
DROP TABLE IF EXISTS image_embeddings;
