-- Supersedes the blunt heuristic from 20260608_02. Pending Replies (v_pending_inbound) now hides a
-- reply ONLY when the resolve-replies edge function (Claude Sonnet) has read the doctor's reply + our
-- subsequent communications and marked dr_outreach_replies.resolve_state = 'resolved'.
--   * resolve_state = 'resolved'   -> hidden (Claude confirmed it was answered)
--   * resolve_state = 'unresolved' -> VISIBLE (Claude judged it still open)
--   * resolve_state IS NULL        -> VISIBLE (not yet checked, or output was unparseable)
-- The "later lab comm" heuristic now only SELECTS candidates to send to Claude (see
-- pick_replies_to_resolve); it no longer hides anything on its own.
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
    a."Strategic Partner" AS strategic_partner,
    r.cc_recipients
   FROM dr_outreach_replies r
     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
     LEFT JOIN "Accounts" a ON a."Account Number" = q.account_number
     LEFT JOIN "Cases" c ON c."Case Number" = COALESCE(r.case_number, q.case_number)
  WHERE r.decided_at IS NULL
    AND lower(r.from_email) !~~ '%@skdla.com'::text
    AND r.resolve_state IS DISTINCT FROM 'resolved'
  ORDER BY r.received_at;
