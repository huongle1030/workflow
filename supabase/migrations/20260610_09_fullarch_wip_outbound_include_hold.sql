-- Pending Outbound was scoped to Full Arch cases at Case Status = 'WIP' only. ABS parks Full Arch
-- cases on Hold "for Doctor Design Approval" while waiting on the doctor — exactly the population the
-- Pending Classification buttons act on — so those drafts never surfaced here (e.g. 2026-73748:
-- Full Arch / Hold / "Doctor Design Approval - Full Arch"). Broaden the WIP CTE to
-- Case Status IN ('WIP','Hold') while still requiring the design-approval step. Only this one
-- predicate changes; everything else is the prior definition verbatim.
CREATE OR REPLACE VIEW public.v_fullarch_wip_outbound AS
 WITH wip AS (
         SELECT c_1."Case Status",
            c_1."Case Number",
            c_1."Account Number",
            c_1."Patient First Name",
            c_1."Patient Last Name",
            c_1."Pan Number",
            c_1."Received Date Timestamp",
            c_1."Received Date",
            c_1."Required Out Of Lab Date",
            c_1."Original RX Date",
            c_1."Doctor Due Date",
            c_1."Ship Date",
            c_1."Invoice Date",
            c_1."Tracking Date",
            c_1."Tracking Number",
            c_1."Carrier",
            c_1."Carrier Days",
            c_1."Location",
            c_1."Primary Product",
            c_1."Primary Product Number",
            c_1."Recipe",
            c_1."Remake Fault",
            c_1."Remake Reason",
            c_1."External Remake Flag" AS "Remake Flag",
            c_1."Hold Count",
            c_1."Hold Days",
            c_1."Hold Reason",
            c_1."Hold Flag",
            c_1."Hold Release Date",
            c_1."Invoice Notes",
            c_1."Turnaround Time",
            c_1."Manufacturing Days",
            c_1."Order Id",
            c_1."Invoice Date Timestamp",
            c_1."Business Unit L1",
            c_1."Business Unit",
            c_1."AR Date",
            c_1."Hubspot Ticket ID",
            c_1."Analog Digital",
            c_1."Consolidated SKU",
            c_1."Current Step",
            c_1."Current Step Consolidated",
            c_1."Step Flagging Join Key",
            c_1."Step Flagging Key",
            c_1."Projected Ship Date",
            c_1."Days Until Projected Ship",
            c_1."Redate",
            c_1."Initial Flag",
            c_1."Reschedule Flag"
           FROM "Cases" c_1
          WHERE c_1."Business Unit" = 'Full Arch'::text
            AND c_1."Case Status" = ANY (ARRAY['WIP'::text, 'Hold'::text])
            AND (EXISTS ( SELECT 1
                   FROM "Case Steps" s
                  WHERE s."Case Number" = c_1."Case Number" AND (s."Step" = ANY (ARRAY['Doctor Design Approval - Full Arch'::text, 'Dr. STL Approval Needed'::text]))))
        ), pend AS (
         SELECT DISTINCT ON (q.case_number) q.case_number,
            att.id AS attempt_id,
            att.queue_id,
            att.attempt_number,
            att.created_at AS proposed_at,
            att.to_email,
            att.subject,
            att.body_html,
            q.reason
           FROM dr_outreach_attempts att
             JOIN dr_outreach_queue q ON q.id = att.queue_id
          WHERE att.status = 'pending_approval'::attempt_status AND (q.case_number IN ( SELECT wip."Case Number"
                   FROM wip))
          ORDER BY q.case_number, att.created_at DESC
        ), rev AS (
         SELECT li."Case Number" AS case_number,
            sum(li."Price Net") AS revenue
           FROM "Line Items" li
          WHERE (li."Case Number" IN ( SELECT wip."Case Number"
                   FROM wip))
          GROUP BY li."Case Number"
        )
 SELECT pend.attempt_id,
    pend.queue_id,
    pend.attempt_number,
    pend.proposed_at,
    COALESCE(pend.to_email, a."Primary Email") AS to_email,
    pend.subject,
    pend.body_html,
    c."Case Number" AS case_number,
    c."Pan Number" AS pan_number,
    c."Account Number" AS account_number,
    COALESCE(pend.reason, 'design_approval'::outreach_reason) AS reason,
    a."First Name" AS dr_first_name,
    a."Last Name" AS dr_last_name,
    a."Dr Pref" AS dr_pref,
    a."Practice Name" AS practice_name,
    a."Account Manager" AS account_manager,
    c."Hold Reason" AS hold_reason,
    c."Current Step" AS current_step,
    c."Doctor Due Date" AS doctor_due_date,
    NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name,
    xl.viewer_url AS exocad_viewer_url,
    NULL::timestamp with time zone AS last_activity_at,
    NULL::integer AS days_since_last_activity,
    false AS recent_doctor_reply,
    0::bigint AS replies_14d,
    0::bigint AS notes_14d,
    0::bigint AS sends_14d,
    COALESCE(mi.issue_summary_short, c."Hold Reason") AS issue_summary,
    project_ship_date(now()) AS projected_ship_date,
    c."Doctor Due Date"::date AS doctor_due_date_only,
        CASE
            WHEN c."Doctor Due Date" IS NULL THEN NULL::integer
            ELSE project_ship_date(now()) - c."Doctor Due Date"::date
        END AS days_late_if_approved_now,
        CASE
            WHEN c."Doctor Due Date" IS NULL THEN false
            ELSE project_ship_date(now()) > c."Doctor Due Date"::date
        END AS will_miss_due_date,
    ap.design_notes AS account_preferences,
    ap.derived_from_accounts AS prefs_auto,
    (ap.pref_summaries -> COALESCE(pend.reason, 'design_approval'::outreach_reason)::text) ->> 'headline'::text AS prefs_summary_headline,
    (ap.pref_summaries -> COALESCE(pend.reason, 'design_approval'::outreach_reason)::text) ->> 'detail'::text AS prefs_summary_detail,
    COALESCE(rev.revenue, 0::numeric) AS case_revenue,
    a."Strategic Partner" AS strategic_partner,
    tri.evidence_at,
    tri.evidence_kind,
    'pending_approval'::text AS triage_bucket,
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
    c."Case Status" AS case_status,
    c."Business Unit" AS business_unit,
    pend.attempt_id IS NOT NULL AS has_draft,
    ps.approval_state,
    ps.most_recent_unapproved_reason,
    COALESCE(ps.initial_design_in_progress, false) AS initial_design_in_progress,
    ps.case_number IS NOT NULL AS parsed,
    ps.parsed_at,
    COALESCE(ps.design_approval_attempt_count, 0) AS design_approval_attempt_count,
    COALESCE(ps.design_modification_count, 0) AS design_modification_count,
    COALESCE(ps.missing_info, 0) AS missing_info_count,
    COALESCE(ps.waiting_on_parts, 0) AS waiting_on_parts_count,
    COALESCE(ps.late_approval_notice, 0) AS late_approval_notice_count,
    COALESCE(ps.reschedule_check, 0) AS reschedule_check_count,
    COALESCE(ps.scan_submission_ack, 0) AS scan_submission_ack_count
   FROM wip c
     LEFT JOIN "Accounts" a ON a."Account Number" = c."Account Number"
     LEFT JOIN pend ON pend.case_number = c."Case Number"
     LEFT JOIN case_exocad_links xl ON xl.case_number = c."Case Number"
     LEFT JOIN case_missing_info_summaries mi ON mi.case_number = c."Case Number"
     LEFT JOIN account_preferences ap ON ap.account_number = c."Account Number"
     LEFT JOIN rev ON rev.case_number = c."Case Number"
     LEFT JOIN case_parse_state ps ON ps.case_number = c."Case Number"
     LEFT JOIN LATERAL ( SELECT count(*) AS comm_count,
            max(cc.occurred_at) AS evidence_at,
            (array_agg(cc.channel_source ORDER BY cc.occurred_at DESC))[1] AS evidence_kind
           FROM case_communications cc
          WHERE cc.case_number = c."Case Number") tri ON true
     LEFT JOIN LATERAL ( SELECT cc.occurred_at,
            cc.medium,
            cc.direction,
            cc.source_type,
            cc.subject,
            cc.body_text,
            cc.actor,
            cc.counterparty
           FROM case_communications cc
          WHERE cc.case_number = c."Case Number"
          ORDER BY cc.occurred_at DESC
         LIMIT 1) lc ON true
     LEFT JOIN LATERAL ( SELECT r2.cc_recipients,
            r2.received_at
           FROM dr_outreach_replies r2
             LEFT JOIN dr_outreach_queue q2 ON q2.id = r2.queue_id
          WHERE COALESCE(r2.case_number, q2.case_number) = c."Case Number" AND r2.cc_recipients IS NOT NULL AND array_length(r2.cc_recipients, 1) > 0
          ORDER BY r2.received_at DESC
         LIMIT 1) lr ON true
  WHERE COALESCE(ps.show_in_pending_outbound, true);
