-- Pending Classification: NO button may send an outbound email. escalate_reply_for_call previously
-- queued a phone-call-escalation email to the Account Manager (attempt 99 -> dr-outreach-tick sends).
-- That email INSERT is removed. The escalation is still RECORDED: the reply is marked
-- 'escalated_call' and the queue is set to 'escalated_am' (escalated_to = the AM) with a note, so the
-- hand-off is tracked in the UI/queue — it just no longer auto-emails anyone.
CREATE OR REPLACE FUNCTION public.escalate_reply_for_call(p_reply_id uuid, p_coordinator_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reply        dr_outreach_replies;
  v_case_number  text;
  v_account_no   text;
  v_am           text;
BEGIN
  SELECT * INTO v_reply FROM dr_outreach_replies WHERE id = p_reply_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_case_number := v_reply.case_number;
  IF v_case_number IS NULL AND v_reply.queue_id IS NOT NULL THEN
    SELECT case_number INTO v_case_number FROM dr_outreach_queue WHERE id = v_reply.queue_id;
  END IF;
  IF v_case_number IS NULL THEN
    RAISE EXCEPTION 'Cannot escalate: reply has no linked case';
  END IF;

  SELECT account_number INTO v_account_no FROM dr_outreach_queue WHERE id = v_reply.queue_id;
  IF v_account_no IS NULL THEN
    SELECT "Account Number" INTO v_account_no FROM "Cases" WHERE "Case Number" = v_case_number LIMIT 1;
  END IF;
  SELECT "Account Manager" INTO v_am FROM "Accounts" WHERE "Account Number" = v_account_no;

  UPDATE dr_outreach_replies
  SET coordinator_decision = 'escalated_call',
      coordinator_id = COALESCE(coordinator_id, p_coordinator_id),
      decided_at = now()
  WHERE id = p_reply_id;

  IF v_reply.queue_id IS NOT NULL THEN
    UPDATE dr_outreach_queue
    SET status       = 'escalated_am'::outreach_status,
        escalated_to = v_am,
        escalated_at = now(),
        updated_at   = now(),
        notes        = COALESCE(notes || E'\n', '') ||
                       'Phone-call escalation (no email sent): time-sensitive reply triaged ' || TO_CHAR(now(), 'MM/DD/YYYY HH24:MI')
    WHERE id = v_reply.queue_id;
  END IF;
END $function$;
