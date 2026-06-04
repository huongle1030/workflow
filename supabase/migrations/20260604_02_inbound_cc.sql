-- Capture and surface the CC recipients of inbound doctor replies.
--
-- Coordinators want to see who else an inbound email was CC'd to. The Graph reply
-- handler (dr-outreach-reply) now stores msg.ccRecipients into dr_outreach_replies.cc_recipients;
-- this exposes that column on the two views the Pending tabs read.
--
-- Pure additive change. New columns are appended at the END of each view's column list so
-- CREATE OR REPLACE keeps the existing column order valid.

ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS cc_recipients text[];

-- v_pending_inbound: append cc_recipients so Pending Replies can show the CC list.
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
  WHERE r.decided_at IS NULL AND lower(r.from_email) !~~ '%@skdla.com'::text
  ORDER BY r.received_at;

-- v_pending_outbound_triage: expose the CC list of the most recent inbound reply on the
-- case so the "Most Recent Communication" sub-card can show who that email was CC'd to.
-- Sourced from dr_outreach_replies (case_communications has no CC and is maintained
-- out-of-repo). New columns appended at the end.
CREATE OR REPLACE VIEW public.v_pending_outbound_triage AS
 SELECT po.attempt_id,
    po.queue_id,
    po.attempt_number,
    po.proposed_at,
    po.to_email,
    po.subject,
    po.body_html,
    po.case_number,
    po.pan_number,
    po.account_number,
    po.reason,
    po.dr_first_name,
    po.dr_last_name,
    po.dr_pref,
    po.practice_name,
    po.account_manager,
    po.hold_reason,
    po.current_step,
    po.doctor_due_date,
    po.patient_name,
    po.exocad_viewer_url,
    po.last_activity_at,
    po.days_since_last_activity,
    po.recent_doctor_reply,
    po.replies_14d,
    po.notes_14d,
    po.sends_14d,
    po.issue_summary,
    po.projected_ship_date,
    po.doctor_due_date_only,
    po.days_late_if_approved_now,
    po.will_miss_due_date,
    po.account_preferences,
    po.prefs_auto,
    po.prefs_summary_headline,
    po.prefs_summary_detail,
    po.case_revenue,
    po.strategic_partner,
    po.last_outreach_note_at,
    po.outreach_note_count,
    po.most_recent_outreach_note,
    po.most_recent_outreach_author,
    tri.evidence_at,
    tri.evidence_kind,
        CASE
            WHEN tri.confirmed THEN 'pending_approval'::text
            WHEN tri.any_contact THEN 'pending_approval_unsure'::text
            ELSE 'outbound_only'::text
        END AS triage_bucket,
    lc.occurred_at AS most_recent_comm_at,
    lc.medium AS most_recent_comm_medium,
    lc.direction AS most_recent_comm_direction,
    lc.source_type AS most_recent_comm_source_type,
    lc.subject AS most_recent_comm_subject,
    lc.body_text AS most_recent_comm_body,
    lc.actor AS most_recent_comm_actor,
    lc.counterparty AS most_recent_comm_counterparty,
    lr.cc_recipients AS most_recent_comm_cc,
    lr.received_at AS most_recent_comm_cc_at
   FROM v_pending_outbound po
     CROSS JOIN LATERAL ( SELECT bool_or(cc.channel_source = ANY (ARRAY['system_email'::text, 'shared_mailbox_email'::text])) AS confirmed,
            bool_or(cc.medium = ANY (ARRAY['email'::text, 'phone'::text])) AS any_contact,
            max(cc.occurred_at) AS evidence_at,
            (array_agg(cc.channel_source ORDER BY cc.occurred_at DESC))[1] AS evidence_kind
           FROM case_communications cc
          WHERE cc.case_number = po.case_number AND cc.occurred_at >= po.proposed_at AND (cc.medium = ANY (ARRAY['email'::text, 'phone'::text]))) tri
     LEFT JOIN LATERAL ( SELECT cc.occurred_at,
            cc.medium,
            cc.direction,
            cc.source_type,
            cc.subject,
            cc.body_text,
            cc.actor,
            cc.counterparty
           FROM case_communications cc
          WHERE cc.case_number = po.case_number
          ORDER BY cc.occurred_at DESC
          LIMIT 1) lc ON true
     LEFT JOIN LATERAL ( SELECT r2.cc_recipients,
            r2.received_at
           FROM dr_outreach_replies r2
             LEFT JOIN dr_outreach_queue q2 ON q2.id = r2.queue_id
          WHERE COALESCE(r2.case_number, q2.case_number) = po.case_number
            AND r2.cc_recipients IS NOT NULL
            AND array_length(r2.cc_recipients, 1) > 0
          ORDER BY r2.received_at DESC
          LIMIT 1) lr ON true;
