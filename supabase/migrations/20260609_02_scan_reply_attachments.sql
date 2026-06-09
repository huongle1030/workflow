-- Scan Submission tab: capture inbound email attachment metadata so the Sonnet
-- classifier can require a real patient-scan attachment, and the card can show it.
--
-- Background: dr_outreach_replies only stored from/subject/body — no attachment info.
-- The new scan-submission rule keys off whether the email actually ATTACHES a patient
-- scan (a file named after the case or patient). The inbound webhook (dr-outreach-reply)
-- is the only place that knows which mailbox a message lives in, so it now fetches the
-- attachment list from Microsoft Graph at ingest and writes it here as jsonb:
--   [{ "name": "...", "contentType": "...", "size": 12345 }, ...]   (inline images dropped)
-- NULL = pre-deploy row (never captured) or Graph fetch failed; [] = no attachments.
--
-- Two changes:
--   1. attachments jsonb column on dr_outreach_replies.
--   2. v_pending_outbound_triage gains scan_reply_attachments (appended at the END so
--      CREATE OR REPLACE keeps the existing column list/order intact).

-- 1) ---------------------------------------------------------------------------------------
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS attachments jsonb;

-- 2) ---------------------------------------------------------------------------------------
-- Identical to 20260605_02's view except the scanr LATERAL also selects sr.attachments and
-- one new trailing column (scan_reply_attachments) is appended after scan_reply_at.
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
            WHEN po.reason = 'scan_submission_ack' THEN 'outbound_only'::text
            ELSE 'pending_approval'::text
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
    lr.received_at AS most_recent_comm_cc_at,
    scanr.from_email AS scan_reply_from,
    scanr.subject AS scan_reply_subject,
    scanr.body_text AS scan_reply_body,
    scanr.received_at AS scan_reply_at,
    scanr.attachments AS scan_reply_attachments
   FROM v_pending_outbound po
     CROSS JOIN LATERAL ( SELECT count(*) AS comm_count,
            max(cc.occurred_at) AS evidence_at,
            (array_agg(cc.channel_source ORDER BY cc.occurred_at DESC))[1] AS evidence_kind
           FROM case_communications cc
          WHERE cc.case_number = po.case_number) tri
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
          LIMIT 1) lr ON true
     LEFT JOIN LATERAL ( SELECT sr.from_email,
            sr.subject,
            sr.body_text,
            sr.received_at,
            sr.attachments
           FROM dr_outreach_replies sr
          WHERE sr.scan_ack_attempt_id = po.attempt_id
          ORDER BY sr.received_at DESC
          LIMIT 1) scanr ON true;
