-- Editable, multi-recipient "To" on outbound draft cards + a "Select draft" (regenerate) action.
--
-- 1) to_emails: lets coordinators redirect a Pending Outbound / Scan Submission draft to a
--    different recipient, or to SEVERAL recipients, instead of the single composed to_email.
--    Additive + backward-compatible: every compose RPC keeps writing the scalar to_email, and
--    when to_emails is null/empty that scalar stays the source of truth. Read by BOTH send paths
--    (send-attempt edge function + dr-outreach-tick cron), so it must live on the attempt row.
--    Mirrors the cc_emails design in 20260604_03_attempt_cc.sql.
--
-- 2) recompose_attempt_with_reason: backs the "Select draft" button — supersede the current
--    pending draft on a queue and recompose it from a chosen template reason, reusing the proven
--    supersede+compose pattern from compose_classification_draft (20260610_13).
--
-- The frontend writes with the publishable (anon) key, so persistence goes through SECURITY
-- DEFINER RPCs rather than direct table writes.

ALTER TABLE public.dr_outreach_attempts
  ADD COLUMN IF NOT EXISTS to_emails text[];

-- Set (or clear) the To recipient list on an attempt. Keeps the scalar to_email synced to the
-- first recipient so the scan-ack @aspendental.com job-aid check and the record_outbox_outbound
-- audit (both of which read to_email) stay correct. Passing null/empty clears the override; the
-- existing to_email is left untouched in that case so the row never loses its recipient.
CREATE OR REPLACE FUNCTION public.set_attempt_to(p_attempt_id uuid, p_to_emails text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.dr_outreach_attempts
     SET to_emails = NULLIF(p_to_emails, '{}'::text[]),
         to_email  = COALESCE((NULLIF(p_to_emails, '{}'::text[]))[1], to_email)
   WHERE id = p_attempt_id;
$$;

GRANT EXECUTE ON FUNCTION public.set_attempt_to(uuid, text[]) TO anon, authenticated, service_role;

-- "Select draft": replace the current proposed draft with a fresh one from a chosen template
-- reason. Supersedes the open pending_approval draft on the attempt's queue (mark auto_canceled)
-- and composes the base (attempt 1) template for p_reason in the next free attempt slot. Idempotent
-- — re-selecting just cancels the prior draft and recomposes. Returns the new attempt row.
CREATE OR REPLACE FUNCTION public.recompose_attempt_with_reason(
  p_attempt_id uuid,
  p_reason text
)
RETURNS dr_outreach_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_queue_id uuid;
  v_next     integer;
  v_attempt  dr_outreach_attempts;
BEGIN
  SELECT queue_id INTO v_queue_id FROM dr_outreach_attempts WHERE id = p_attempt_id;
  IF v_queue_id IS NULL THEN RETURN NULL; END IF;

  -- Supersede any open draft on this queue (the one being replaced, plus any other stale draft).
  UPDATE dr_outreach_attempts
  SET status      = 'auto_canceled'::attempt_status,
      review_note = left(COALESCE(review_note || ' | ', '') || 'Superseded by manual draft re-selection (' || p_reason || ')', 1000)
  WHERE queue_id = v_queue_id AND status = 'pending_approval'::attempt_status;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM dr_outreach_attempts WHERE queue_id = v_queue_id;

  v_attempt := compose_attempt_with_reason(v_queue_id, v_next, p_reason, 1);
  RETURN v_attempt;
END $function$;

GRANT EXECUTE ON FUNCTION public.recompose_attempt_with_reason(uuid, text) TO anon, authenticated, service_role;
