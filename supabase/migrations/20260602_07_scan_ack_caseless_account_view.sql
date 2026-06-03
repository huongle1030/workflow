-- Auto-reply for inbound iOS-scan submissions — Part 7.
--
-- Coverage change: a scan submission from a sender NOT found in Accounts (common for
-- ClearChoice / Aspen doctors emailing from individual addresses) should still get a
-- draft. So allow account-less ack queue rows and surface them in Pending Outbound.
--
--   * dr_outreach_queue.account_number -> nullable (case-less ack with unknown account).
--   * v_pending_outbound: change the Accounts join from INNER to LEFT so account-less
--     drafts still appear. Done as a dynamic rewrite of the LIVE view definition
--     (verified: exactly one 'JOIN "Accounts" a ON' occurrence) to avoid hand-copying
--     the ~100-line view. Output columns are unchanged, so the dependent
--     v_pending_outbound_triage stays valid without a recreate.
ALTER TABLE public.dr_outreach_queue
  ALTER COLUMN account_number DROP NOT NULL;

DO $mig$
DECLARE v_def text;
BEGIN
  SELECT pg_get_viewdef('public.v_pending_outbound'::regclass, true) INTO v_def;
  IF position('LEFT JOIN "Accounts" a ON' IN v_def) > 0 THEN
    RAISE NOTICE 'v_pending_outbound already LEFT JOINs Accounts; skipping.';
    RETURN;
  END IF;
  v_def := replace(v_def,
    'JOIN "Accounts" a ON a."Account Number" = q.account_number',
    'LEFT JOIN "Accounts" a ON a."Account Number" = q.account_number');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_pending_outbound AS ' || v_def;
END $mig$;