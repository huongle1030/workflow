-- Auto-reply for inbound iOS-scan submissions — Part 3.
--
-- A scan-submission acknowledgment has NO case yet, but dr_outreach_queue.case_number
-- is NOT NULL. Relax it so compose_scan_ack() can open a case-less queue row.
--
-- This is the ONLY schema change needed for the draft to surface in Pending Outbound:
--   * v_pending_outbound already LEFT JOINs "Cases" on q.case_number, so a NULL case
--     flows through with blank patient/case fields (no view edit required).
--   * v_pending_outbound_triage's LATERAL joins key on po.case_number; a NULL simply
--     yields no evidence rows, so the draft lands in the 'outbound_only' bucket — i.e.
--     the Pending Outbound tab — exactly where we want it.
--   * account_number stays NOT NULL: compose_scan_ack resolves the sender to an
--     Accounts row and requires it (so the view's INNER JOIN "Accounts" still holds).
ALTER TABLE public.dr_outreach_queue
  ALTER COLUMN case_number DROP NOT NULL;

-- The sender (dr-outreach-tick) logs every send via record_outbox_outbound(), which
-- inserts into dr_outreach_abs_outbox with the queue's case_number. For a case-less ack
-- that is NULL, and the column is NOT NULL — the insert would throw AFTER the email was
-- already sent, flipping the attempt to 'failed'. Relax it so the send + log succeed.
-- (No FK/CHECK on this column, so dropping NOT NULL is sufficient.)
ALTER TABLE public.dr_outreach_abs_outbox
  ALTER COLUMN case_number DROP NOT NULL;
