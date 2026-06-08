-- Pending Classification buttons must NEVER send an outbound email. confirm_reply previously
-- auto-queued a late_approval_notice email to the doctor on 'approved'/'approved_with_mods' when the
-- approval landed past the due date (the dr-outreach-tick cron then sent it). That email INSERT into
-- dr_outreach_attempts is removed here. We still RECORD that the approval was late (queue metadata +
-- note) for reporting / the Reschedule tab, but nothing is sent.
--
-- Buttons audited 2026-06-08: Approved / Approved+Mods (this fix), Modification, Pricing/Product Q,
-- Other, Link to case, Use this case #, No matching case => none send email. The only remaining email
-- path from this tab is "Escalate (Call)" (escalate_reply_for_call), which notifies the Account
-- Manager by design.
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
  SET coordinator_decision = p_decision,
      coordinator_id       = p_coordinator_id,
      decided_at           = now()
  WHERE id = p_reply_id
  RETURNING queue_id INTO v_queue_id;

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

  -- Late-approval DETECTION ONLY (no email). The auto-queued late_approval_notice email to the
  -- doctor was removed 2026-06-08 so classification buttons never send outbound mail.
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
