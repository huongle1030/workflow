-- Add the single most-recent communication (any medium — email / phone / note)
-- per case to v_pending_outbound_triage so the Pending Outbound / Pending
-- Approval cards can show its full details in the "Most Recent Note" sub-card.
--
-- Only SENT communications land in case_communications (unsent pending/rejected
-- drafts are not communications), so this never echoes back the draft itself.
--
-- New columns are appended at the end so CREATE OR REPLACE stays valid.
CREATE OR REPLACE VIEW v_pending_outbound_triage AS
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
    lc.counterparty AS most_recent_comm_counterparty
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
          LIMIT 1) lc ON true;
