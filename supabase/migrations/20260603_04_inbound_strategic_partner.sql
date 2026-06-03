-- Expose strategic_partner on v_pending_inbound so the frontend can hide replies by partner
-- (e.g. temporarily hiding SKDLA-TRI Dental while that program isn't being worked yet). The
-- view already LEFT JOINs Accounts as `a`; we just surface the column (appended at the end so
-- CREATE OR REPLACE keeps existing column order). Pure additive change — no behavior change.
CREATE OR REPLACE VIEW public.v_pending_inbound AS
 SELECT r.id AS reply_id,
    r.received_at,
    r.from_email,
    r.subject,
    r.body_text,
    r.ai_classification,
    r.ai_confidence,
    r.ai_summary,
    r.match_method,
    r.match_confidence,
    COALESCE(r.case_number, q.case_number) AS case_number,
    q.account_number,
    q.reason,
    a."Last Name" AS dr_last_name,
    a."Practice Name" AS practice_name,
    NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name,
    reply_needs_escalation(r.ai_summary, r.subject, r.body_text) AS needs_escalation,
    r.suggested_case_number,
    r.suggested_confidence,
    r.suggested_reasoning,
    a."Strategic Partner" AS strategic_partner
   FROM dr_outreach_replies r
     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
     LEFT JOIN "Accounts" a ON a."Account Number" = q.account_number
     LEFT JOIN "Cases" c ON c."Case Number" = COALESCE(r.case_number, q.case_number)
  WHERE r.decided_at IS NULL AND lower(r.from_email) !~~ '%@skdla.com'::text
  ORDER BY r.received_at;
