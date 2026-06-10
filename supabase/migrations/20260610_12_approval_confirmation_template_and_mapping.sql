-- The "thank you for approving" confirmation template (on-time, neutral wording supplied by the
-- coordinator team), plus repointing confirm_reply so Approved / Approved+Mods draft THIS instead of
-- the design_approval chase series. Modification still uses design_modification (Revised Design
-- Preview). {{arrival_if_approved_now}} is the projected office-arrival date compose computes.
INSERT INTO public.dr_outreach_templates (reason, attempt_number, is_escalation, subject, body_html)
SELECT 'design_approval_confirmation'::outreach_reason, 1, false,
       'Design Approved - Patient {{patient_name}} is now in production',
       '<p>{{greeting}},</p>'
    || '<p>Thank you for approving the design for patient {{patient_name}}.</p>'
    || '<p>The case has now moved into production and is scheduled to be delivered to your office by <strong>{{arrival_if_approved_now}}</strong> pending no technical issues during production.</p>'
    || '<p>If you have any questions in the meantime, please don''t hesitate to reach out.</p>'
    || '<p>Best regards,<br/>{{signature}}</p>'
WHERE NOT EXISTS (
  SELECT 1 FROM public.dr_outreach_templates
  WHERE reason = 'design_approval_confirmation'::outreach_reason AND attempt_number = 1
);

-- Repoint the compose mapping inside confirm_reply.
CREATE OR REPLACE FUNCTION public.confirm_reply(p_reply_id uuid, p_decision text, p_coordinator_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_queue_id    UUID;
  v_case_number TEXT;
  v_account_no  TEXT;
  v_am          TEXT;
  v_due         DATE;
  v_arrival     DATE;
  v_is_late     BOOLEAN := false;
BEGIN
  IF p_decision NOT IN ('approved','modification','approved_with_mods','pricing_or_product_question','other') THEN
    RAISE EXCEPTION 'invalid decision: %', p_decision;
  END IF;

  UPDATE dr_outreach_replies
  SET human_classification = p_decision,
      coordinator_decision = p_decision,
      coordinator_id       = p_coordinator_id,
      decided_at           = CASE WHEN p_decision = 'other' THEN decided_at ELSE now() END
  WHERE id = p_reply_id
  RETURNING queue_id INTO v_queue_id;

  IF p_decision = 'other' THEN RETURN; END IF;

  IF v_queue_id IS NULL THEN RETURN; END IF;

  SELECT case_number, account_number INTO v_case_number, v_account_no
  FROM dr_outreach_queue WHERE id = v_queue_id;

  UPDATE dr_outreach_queue
  SET status = 'replied', replied_at = now(), updated_at = now()
  WHERE id = v_queue_id;

  IF p_decision = 'approved' THEN
    UPDATE "Case"
    SET dr_approval_count = COALESCE(dr_approval_count, 0) + 1,
        current_stage     = 'Dr Approved',
        updated_date      = now()
    WHERE case_id = v_case_number;
  ELSIF p_decision = 'modification' THEN
    UPDATE "Case"
    SET design_change_count = COALESCE(design_change_count, 0) + 1,
        current_stage       = 'Design Changes Requested',
        updated_date        = now()
    WHERE case_id = v_case_number;
  ELSIF p_decision = 'approved_with_mods' THEN
    UPDATE "Case"
    SET dr_approval_count   = COALESCE(dr_approval_count, 0)   + 1,
        design_change_count = COALESCE(design_change_count, 0) + 1,
        current_stage       = 'Design Changes Requested',
        updated_date        = now()
    WHERE case_id = v_case_number;
  ELSIF p_decision = 'pricing_or_product_question' THEN
    SELECT "Account Manager" INTO v_am FROM "Accounts" WHERE "Account Number" = v_account_no;
    UPDATE dr_outreach_queue
    SET status       = 'escalated_am',
        escalated_to = v_am,
        escalated_at = now(),
        updated_at   = now(),
        notes        = COALESCE(notes || E'\n', '') || 'Pricing/product question routed to AM ' || COALESCE(v_am, '(unassigned)')
    WHERE id = v_queue_id;
  END IF;

  -- Approved / Approved+Mods -> "thank you for approving" confirmation draft.
  -- Modification -> Revised Design Preview (design_modification).
  IF p_decision IN ('approved', 'approved_with_mods') THEN
    PERFORM compose_classification_draft(p_reply_id, 'design_approval_confirmation');
  ELSIF p_decision = 'modification' THEN
    PERFORM compose_classification_draft(p_reply_id, 'design_modification');
  END IF;

  IF p_decision IN ('approved', 'approved_with_mods') THEN
    SELECT "Doctor Due Date"::date INTO v_due
    FROM "Cases" WHERE "Case Number" = v_case_number;
    v_arrival := project_arrival_date(now(), 5, 2);
    v_is_late := v_due IS NOT NULL AND v_arrival > v_due;

    IF v_is_late THEN
      UPDATE dr_outreach_queue
      SET late_approval_arrival_date = v_arrival,
          late_approval_detected_at  = now(),
          notes = COALESCE(notes || E'\n', '') ||
                  'Late approval (no email sent): arrival ' || TO_CHAR(v_arrival, 'MM/DD/YYYY') ||
                  ' exceeds doctor due ' || TO_CHAR(v_due, 'MM/DD/YYYY')
      WHERE id = v_queue_id;
    END IF;
  END IF;
END $function$;
