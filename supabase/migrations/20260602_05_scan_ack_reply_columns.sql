-- Auto-reply for inbound iOS-scan submissions — Part 5.
--
-- Additive classification/idempotency columns on dr_outreach_replies, mirroring the
-- suggested_* pattern from 20260601_01. `scan_ack_at` doubles as the idempotency guard:
-- the classify-scan-submission cron tick only picks up rows where it is NULL. A row with
-- scan_is_submission=false (and no scan_ack_attempt_id) means "Claude ran, not a scan
-- submission." A row with scan_is_submission=true but NULL scan_ack_attempt_id means it
-- was a submission but no account matched the sender, so no draft was composed.
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS scan_ack_at         timestamptz,  -- set once processed (also = "don't reprocess")
  ADD COLUMN IF NOT EXISTS scan_is_submission  boolean,      -- Claude's verdict
  ADD COLUMN IF NOT EXISTS scan_ack_confidence numeric,      -- 0.0–1.0
  ADD COLUMN IF NOT EXISTS scan_ack_reasoning  text,         -- one-sentence "why"
  ADD COLUMN IF NOT EXISTS scan_ack_model      text,         -- e.g. 'claude-haiku-4-5-20251001'
  ADD COLUMN IF NOT EXISTS scan_ack_attempt_id uuid;         -- the composed draft, when one was created

-- Partial index for the cron's pickup query (unprocessed replies).
CREATE INDEX IF NOT EXISTS idx_dr_replies_scan_ack_pending
  ON public.dr_outreach_replies (received_at DESC)
  WHERE scan_ack_at IS NULL;
