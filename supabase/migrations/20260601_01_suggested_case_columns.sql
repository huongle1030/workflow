-- AI-suggested case number for unmatched Pending Replies (admin-only)
-- Part 1 — additive suggestion columns on dr_outreach_replies.
--
-- These are kept DISTINCT from the real `case_number` so the "Needs case lookup"
-- tag is unaffected. `suggested_at` doubles as the idempotency guard: the cron
-- tick only picks up rows where it is NULL. A NULL `suggested_case_number` with a
-- non-null `suggested_at` means "Claude ran but found nothing."
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS suggested_case_number text,
  ADD COLUMN IF NOT EXISTS suggested_confidence  numeric,      -- 0.0–1.0
  ADD COLUMN IF NOT EXISTS suggested_reasoning   text,         -- one-sentence "why"
  ADD COLUMN IF NOT EXISTS suggested_candidates  jsonb,        -- full candidate list Claude considered (audit)
  ADD COLUMN IF NOT EXISTS suggested_at          timestamptz,  -- set once processed (also = "don't reprocess")
  ADD COLUMN IF NOT EXISTS suggested_model       text;         -- e.g. 'claude-haiku-4-5-20251001'

-- Partial index for the cron's pickup query (unmatched + unprocessed).
CREATE INDEX IF NOT EXISTS idx_dr_replies_suggest_pending
  ON public.dr_outreach_replies (received_at DESC)
  WHERE case_number IS NULL AND suggested_at IS NULL;

-- Trigram indexes so the RPC's ILIKE '%name%' over Cases (~282K rows) stays fast.
CREATE INDEX IF NOT EXISTS idx_cases_patient_first_trgm
  ON public."Cases" USING gin ("Patient First Name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cases_patient_last_trgm
  ON public."Cases" USING gin ("Patient Last Name" gin_trgm_ops);
