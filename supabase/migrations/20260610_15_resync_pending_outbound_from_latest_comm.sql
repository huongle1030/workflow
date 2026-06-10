-- Keep every Pending Outbound draft aligned to the NEXT ACTION implied by the case's most recent
-- doctor communication. Mapping (effective classification = human_classification, else ai):
--   approved / approved_with_mods -> design_approval_confirmation  (thank-you)
--   modification                  -> design_modification           (Revised Design Preview)
--   anything else / no reply      -> NULL  (leave the existing draft untouched)
-- Drafts are pending_approval only; nothing sends without a human Approve & Send. compose
-- supersedes the prior draft on that queue. Coordinator-edited / already-reviewed drafts are never
-- clobbered. pick_due_for_send skips queues that already have a pending draft, so this never fights
-- the chase cron.

CREATE OR REPLACE FUNCTION public.classification_to_template_reason(p_class text)
 RETURNS outreach_reason
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_class
    WHEN 'approved'           THEN 'design_approval_confirmation'::outreach_reason
    WHEN 'approved_with_mods' THEN 'design_approval_confirmation'::outreach_reason
    WHEN 'modification'       THEN 'design_modification'::outreach_reason
    ELSE NULL
  END
$function$;

-- Re-draft one case's Pending Outbound draft to match its latest communication. Returns true if it
-- changed something. No-op when: no actionable classification, no existing draft, draft already
-- correct, or the draft has been hand-edited/reviewed by a coordinator.
CREATE OR REPLACE FUNCTION public.resync_pending_outbound_draft(p_case_number text)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_class   text;
  v_reason  outreach_reason;
  v_att_id  uuid;
  v_queue   uuid;
  v_tpl_rsn outreach_reason;
  v_edited  text;
  v_reviewer text;
  v_review  text;
  v_next    integer;
BEGIN
  -- Effective classification of the most recent doctor reply on this case.
  SELECT COALESCE(r.human_classification, r.ai_classification) INTO v_class
  FROM dr_outreach_replies r
  LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
  WHERE COALESCE(r.case_number, q.case_number) = p_case_number
  ORDER BY r.received_at DESC
  LIMIT 1;

  v_reason := classification_to_template_reason(v_class);
  IF v_reason IS NULL THEN RETURN FALSE; END IF;

  -- Newest pending draft for this case (across queues).
  SELECT att.id, att.queue_id, t.reason, att.edited_body_html, att.reviewer_id, att.review_action
    INTO v_att_id, v_queue, v_tpl_rsn, v_edited, v_reviewer, v_review
  FROM dr_outreach_attempts att
  JOIN dr_outreach_queue q ON q.id = att.queue_id
  LEFT JOIN dr_outreach_templates t ON t.id = att.template_id
  WHERE q.case_number = p_case_number AND att.status = 'pending_approval'::attempt_status
  ORDER BY att.created_at DESC
  LIMIT 1;

  IF v_att_id IS NULL THEN RETURN FALSE; END IF;                         -- no draft to resync
  IF v_edited IS NOT NULL OR v_reviewer IS NOT NULL OR v_review IS NOT NULL THEN
    RETURN FALSE;                                                        -- don't clobber human work
  END IF;
  IF v_tpl_rsn = v_reason THEN RETURN FALSE; END IF;                     -- already correct

  UPDATE dr_outreach_attempts
  SET status = 'auto_canceled'::attempt_status,
      review_note = left(COALESCE(review_note || ' | ', '') || 'Resynced to ' || v_reason::text || ' (latest communication)', 1000)
  WHERE queue_id = v_queue AND status = 'pending_approval'::attempt_status;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM dr_outreach_attempts WHERE queue_id = v_queue;

  PERFORM compose_attempt_with_reason(v_queue, v_next, v_reason::text, 1);
  RETURN TRUE;
END $function$;

-- Sweep every case that currently has a Pending Outbound draft and resync it. Returns the number
-- of drafts changed. Safe to run on a cron — steady state is a no-op.
CREATE OR REPLACE FUNCTION public.resync_all_pending_outbound_drafts()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v_case text; v_changed int := 0;
BEGIN
  FOR v_case IN
    SELECT DISTINCT q.case_number
    FROM dr_outreach_attempts att
    JOIN dr_outreach_queue q ON q.id = att.queue_id
    WHERE att.status = 'pending_approval'::attempt_status AND q.case_number IS NOT NULL
  LOOP
    BEGIN
      IF resync_pending_outbound_draft(v_case) THEN v_changed := v_changed + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad case shouldn't abort the whole sweep.
      NULL;
    END;
  END LOOP;
  RETURN v_changed;
END $function$;
