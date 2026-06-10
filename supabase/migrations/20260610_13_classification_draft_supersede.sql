-- Previously compose_classification_draft no-op'd if ANY pending_approval draft already existed on
-- the queue. That left stale "Design Approval Needed" chase drafts (composed by the proactive
-- dr-outreach cron) in Pending Outbound even after the doctor replied and a coordinator classified
-- the reply Approved (e.g. case 2026-70110). The doctor has now responded, so any open chase draft is
-- obsolete — supersede it (mark auto_canceled) and compose the classification-driven template in its
-- place. Idempotent: re-classifying just cancels the prior classification draft and recomposes.
CREATE OR REPLACE FUNCTION public.compose_classification_draft(
  p_reply_id uuid,
  p_reason text
)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_queue_id uuid;
  v_next     integer;
  v_attempt  dr_outreach_attempts;
BEGIN
  SELECT queue_id INTO v_queue_id FROM dr_outreach_replies WHERE id = p_reply_id;
  IF v_queue_id IS NULL THEN RETURN NULL; END IF;

  -- Supersede any open draft on this queue (stale chase nudge or a prior classification draft).
  UPDATE dr_outreach_attempts
  SET status      = 'auto_canceled'::attempt_status,
      review_note = left(COALESCE(review_note || ' | ', '') || 'Superseded by ' || p_reason || ' classification draft', 1000)
  WHERE queue_id = v_queue_id AND status = 'pending_approval'::attempt_status;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM dr_outreach_attempts WHERE queue_id = v_queue_id;

  v_attempt := compose_attempt_with_reason(v_queue_id, v_next, p_reason, 1);
  RETURN v_attempt;
END $function$;
