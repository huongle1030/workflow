-- Surface human_classification in the Pending Classification feed, directly next to
-- ai_classification. Identical to the prior definition otherwise. Note 'other' replies now
-- stay in this feed (confirm_reply leaves decided_at NULL for 'other' — see 20260610_04),
-- so the UI can render the "Other" tag from human_classification while keeping the card
-- actionable.
--
-- DROP + CREATE (not CREATE OR REPLACE): inserting human_classification mid-list reorders the
-- view's columns, which CREATE OR REPLACE rejects. Verified no objects depend on this view.
DROP VIEW IF EXISTS public.v_pending_inbound;
CREATE VIEW public.v_pending_inbound AS
 SELECT r.id AS reply_id,
    r.received_at,
    r.from_email,
    r.subject,
    r.body_text,
    r.ai_classification,
    r.human_classification,
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
    a."Strategic Partner" AS strategic_partner,
    r.cc_recipients
   FROM dr_outreach_replies r
     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
     LEFT JOIN "Accounts" a ON a."Account Number" = q.account_number
     LEFT JOIN "Cases" c ON c."Case Number" = COALESCE(r.case_number, q.case_number)
  WHERE r.decided_at IS NULL
    AND lower(r.from_email) !~~ '%@skdla.com'::text
    AND r.resolve_state IS DISTINCT FROM 'resolved'::text
  ORDER BY r.received_at;
