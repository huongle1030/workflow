-- Claude-judged resolution of inbound doctor replies (Pending Replies auto-hide).
-- Instead of the blunt "any later lab comm = handled" heuristic (migration 20260608_02), the
-- resolve-replies edge function has Claude read the doctor's reply + our subsequent communications
-- and decide whether the reply was actually addressed. v_pending_inbound (migration 20260608_04)
-- then hides a card only when resolve_state = 'resolved'.
--
-- resolve_checked_labcomm_count records how many lab-side comms existed after the reply at the last
-- check, so the resolver only re-evaluates an 'unresolved' reply when a NEW lab comm arrives
-- (bounds API cost). 'resolved' replies are never re-checked.
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS resolve_state               text,
  ADD COLUMN IF NOT EXISTS resolve_reason              text,
  ADD COLUMN IF NOT EXISTS resolve_evidence            jsonb,
  ADD COLUMN IF NOT EXISTS resolve_model               text,
  ADD COLUMN IF NOT EXISTS resolve_checked_at          timestamptz,
  ADD COLUMN IF NOT EXISTS resolve_checked_labcomm_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dr_outreach_replies_resolve_state_chk') THEN
    ALTER TABLE public.dr_outreach_replies
      ADD CONSTRAINT dr_outreach_replies_resolve_state_chk
      CHECK (resolve_state IS NULL OR resolve_state IN ('resolved','unresolved'));
  END IF;
END $$;
