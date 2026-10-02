-- Carry per-job input on the job row itself.
--
-- An embedding job embeds the caption produced by ONE specific vision analysis.
-- Without recording which one, the handler has to guess — and the only way to
-- guess is "take the most recent row", which silently changes meaning once a
-- second prompt version or model exists. That is exactly the situation Phase 4
-- will create when it compares prompt revisions, so the reference belongs in the
-- job, not in a lookup order.
--
-- Observable in the failure this fixes: with two analysis generations in the
-- table, embedding whichever row happened to sort last would produce vectors
-- that cannot be traced back to the analysis the precision figure was computed
-- from.
ALTER TABLE jobs
  ADD COLUMN payload JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN jobs.payload IS
  'Per-job input the handler needs, e.g. which image_metadata row to embed. '
  'Defaulted to {} so existing rows stay valid.';

CREATE INDEX jobs_payload_gin ON jobs USING GIN (payload jsonb_path_ops);
