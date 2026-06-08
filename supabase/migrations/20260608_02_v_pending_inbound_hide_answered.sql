-- Pending Replies: auto-drop replies that have already been answered.
--
-- v_pending_inbound previously showed every reply with decided_at IS NULL — so a reply stayed in the
-- Pending Replies tab until a coordinator clicked a classification button, even when the case had
-- clearly already been handled (a follow-up case note, an outbound email back to the office, or a
-- logged phone call). This adds a NOT EXISTS guard: a pending reply is hidden once the SAME case has
-- a later LAB-SIDE communication after the reply arrived — i.e. any case_communications row with
-- occurred_at > received_at that is a note, a phone call, or an outbound message. Inbound doctor
-- emails are intentionally NOT a "response" (they're excluded), and unmatched replies (no linked
-- case) are unaffected, so they stay in the queue for manual linking.
--
-- View-only change: nothing is written, no counters move, decided_at stays NULL. Reverting this
-- migration (restoring the prior WHERE) brings the hidden replies straight back. The
-- case_communications(case_number, occurred_at DESC) index (case_communications_case_time_idx)
-- backs the EXISTS lookup.

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
    -- Already answered: a later note / phone call / outbound on the same case.
    AND NOT EXISTS (
      SELECT 1
      FROM case_communications cc
      WHERE cc.case_number = COALESCE(r.case_number, q.case_number)
        AND cc.occurred_at > r.received_at
        AND (cc.medium = 'note' OR cc.channel_source = 'phone_call' OR cc.direction = 'outbound')
    )
  ORDER BY r.received_at;
