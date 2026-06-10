-- confirm_reply, reworked for the Pending Classification redesign:
--   * Always stamps human_classification with the button the coordinator clicked.
--   * Approved /
--     Approved+Mods      -> composes a design_approval draft into Pending Outbound (same template).
--     Modification       -> composes a design_modification draft into Pending Outbound.
--     (Drafts are 'pending_approval' — nothing sends until a human clicks Approve & Send.
--      compose_classification_draft no-ops if a draft already exists, so repeat clicks are safe.)
--   * Pricing/Product Q  -> routes the queue to the Account Manager (unchanged); the reply is
--                           tagged + decided, so it leaves Pending Classification and surfaces on
--                           the Account Manager tab (v_account_manager_actions).
--   * Other              -> tagged ONLY. decided_at stays NULL so the card REMAINS in Pending
--                           Classification for later handling (per product decision 2026-06-10).
-- Still never sends mail from this tab (the 2026-06-08 guard holds): drafts are review-gated.
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

  -- Tag the human classification always. 'other' is left undecided (decided_at NULL) so it stays
  -- in Pending Classification; every other decision is finalized (decided_at = now()) and drops out.
  UPDATE dr_outreach_replies
  SET human_classification = p_decision,
      coordinator_decision = p_decision,
      coordinator_id       = p_coordinator_id,
      decided_at           = CASE WHEN p_decision = 'other' THEN decided_at ELSE now() END
  WHERE id = p_reply_id
  RETURNING queue_id INTO v_queue_id;

  -- 'other' is purely a tag for now — no queue/case side effects.
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

  -- Pending Classification "make a card" buttons: drop a ready-to-review draft into Pending
  -- Outbound. Approved and Approved+Mods share the design_approval template; Modification uses
  -- design_modification.
  IF p_decision IN ('approved', 'approved_with_mods') THEN
    PERFORM compose_classification_draft(p_reply_id, 'design_approval');
  ELSIF p_decision = 'modification' THEN
    PERFORM compose_classification_draft(p_reply_id, 'design_modification');
  END IF;

  -- Late-approval DETECTION ONLY (no email) — see 20260608_09. The auto-queued late_approval_notice
  -- email was removed 2026-06-08 so classification buttons never send outbound mail.
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
