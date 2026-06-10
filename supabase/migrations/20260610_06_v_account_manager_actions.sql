-- Feeds the new "Account Manager" sub-tab (right of Pending Classification). One card per reply a
-- coordinator routed to the AM from Pending Classification — i.e. tagged Pricing/Product Q or
-- Escalate (Call) — that hasn't been resolved yet. No email is drafted for these; the tab is purely
-- a visibility worklist of what the AM still needs to action.
--   human_classification = 'pricing_or_product_question'  -> render a yellow "Pricing/Product Q" flag
--   human_classification = 'escalated_call'               -> render a red "CALL" flag
CREATE OR REPLACE VIEW public.v_account_manager_actions AS
 SELECT r.id AS reply_id,
    r.human_classification,
    r.received_at,
    r.decided_at,
    r.from_email,
    r.subject,
    r.body_text,
    r.ai_summary,
    r.cc_recipients,
    COALESCE(r.case_number, q.case_number) AS case_number,
    q.account_number,
    q.reason,
    a."Last Name" AS dr_last_name,
    a."Dr Pref" AS dr_pref,
    a."Practice Name" AS practice_name,
    a."Account Manager" AS account_manager,
    a."Strategic Partner" AS strategic_partner,
    NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name,
    c."Current Step" AS current_step,
    c."Hold Reason" AS hold_reason,
    c."Doctor Due Date"::date AS doctor_due_date_only
   FROM dr_outreach_replies r
     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
     LEFT JOIN "Accounts" a ON a."Account Number" = q.account_number
     LEFT JOIN "Cases" c ON c."Case Number" = COALESCE(r.case_number, q.case_number)
  WHERE r.human_classification IN ('pricing_or_product_question', 'escalated_call')
    AND r.resolve_state IS DISTINCT FROM 'resolved'::text
  ORDER BY r.decided_at DESC NULLS LAST, r.received_at DESC;
