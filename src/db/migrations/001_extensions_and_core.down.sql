-- 001_extensions_and_core.down.sql
-- Undoes 001_extensions_and_core.sql.
--
-- Drops the tables created by 001. Objects from later migrations that depend on
-- these (embeddings, suggestions, jobs) must be rolled back first.

DROP TABLE IF EXISTS image_metadata;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS posts;

DROP FUNCTION IF EXISTS set_updated_at();

-- Extensions are left installed: other databases on the same server may rely
-- on them, and CREATE EXTENSION IF NOT EXISTS is cheap and idempotent.
