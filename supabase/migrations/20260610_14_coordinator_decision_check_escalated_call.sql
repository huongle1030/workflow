-- The coordinator_decision check constraint never included the values that escalate_reply_for_call
-- ('escalated_call') and mark_reply_no_case ('no_matching_case') write, so both buttons threw
-- 23514 check-constraint violations. Widen the allowed set to cover every decision the app writes.
ALTER TABLE public.dr_outreach_replies
  DROP CONSTRAINT IF EXISTS dr_outreach_replies_coordinator_decision_check;

ALTER TABLE public.dr_outreach_replies
  ADD CONSTRAINT dr_outreach_replies_coordinator_decision_check
  CHECK (coordinator_decision = ANY (ARRAY[
    'approved'::text,
    'modification'::text,
    'approved_with_mods'::text,
    'pricing_or_product_question'::text,
    'other'::text,
    'escalated_call'::text,
    'no_matching_case'::text
  ]));
