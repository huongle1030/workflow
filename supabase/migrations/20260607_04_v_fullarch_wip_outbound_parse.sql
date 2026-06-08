-- Sonnet-driven Pending Outbound tracking — Part 4: surface parse state in the view.
--
-- Rebuilds v_fullarch_wip_outbound (on top of 20260605_04) to LEFT JOIN case_parse_state and:
--   * hide cases the doctor already approved / approved-small-fix / moved to production
--     (WHERE COALESCE(show_in_pending_outbound, true) -- a not-yet-parsed case stays visible).
--   * surface the per-reason attempt counts, the verdict, initial_design_in_progress, and
--     most_recent_unapproved_reason so renderOutboundCard can show the right-hand stamp + the
--     expanded 7-reason breakdown.
-- Every pre-existing row field is preserved so the card keeps rendering unchanged.

CREATE OR REPLACE VIEW public.v_fullarch_wip_outbound AS
WITH wip AS (
  SELECT c.*
  FROM "Cases" c
  WHERE c."Business Unit" = 'Full Arch'
    AND c."Case Status"   = 'WIP'
    AND EXISTS (
      SELECT 1
      FROM "Case Steps" s
      WHERE s."Case Number" = c."Case Number"
        AND s."Step" IN ('Doctor Design Approval - Full Arch', 'Dr. STL Approval Needed')
    )
),
pend AS (
  SELECT DISTINCT ON (q.case_number)
    q.case_number,
    att.id            AS attempt_id,
    att.queue_id,
    att.attempt_number,
    att.created_at    AS proposed_at,
    att.to_email,
    att.subject,
    att.body_html,
    q.reason
  FROM dr_outreach_attempts att
  JOIN dr_outreach_queue q ON q.id = att.queue_id
  WHERE att.status = 'pending_approval'
    AND q.case_number IN (SELECT "Case Number" FROM wip)
  ORDER BY q.case_number, att.created_at DESC
),
rev AS (
  SELECT li."Case Number" AS case_number, sum(li."Price Net") AS revenue
  FROM "Line Items" li
  WHERE li."Case Number" IN (SELECT "Case Number" FROM wip)
  GROUP BY li."Case Number"
)
SELECT
  pend.attempt_id,
  pend.queue_id,
  pend.attempt_number,
  pend.proposed_at,
  COALESCE(pend.to_email, a."Primary Email")                  AS to_email,
  pend.subject,
  pend.body_html,
  c."Case Number"                                             AS case_number,
  c."Pan Number"                                              AS pan_number,
  c."Account Number"                                          AS account_number,
  COALESCE(pend.reason, 'design_approval'::outreach_reason)   AS reason,
  a."First Name"                                              AS dr_first_name,
  a."Last Name"                                               AS dr_last_name,
  a."Dr Pref"                                                 AS dr_pref,
  a."Practice Name"                                           AS practice_name,
  a."Account Manager"                                         AS account_manager,
  c."Hold Reason"                                             AS hold_reason,
  c."Current Step"                                            AS current_step,
  c."Doctor Due Date"                                         AS doctor_due_date,
  NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name,
  xl.viewer_url                                              AS exocad_viewer_url,
  NULL::timestamptz                                          AS last_activity_at,
  NULL::integer                                              AS days_since_last_activity,
  false                                                      AS recent_doctor_reply,
  0::bigint                                                  AS replies_14d,
  0::bigint                                                  AS notes_14d,
  0::bigint                                                  AS sends_14d,
  COALESCE(mi.issue_summary_short, c."Hold Reason")          AS issue_summary,
  project_ship_date(now())                                   AS projected_ship_date,
  c."Doctor Due Date"::date                                  AS doctor_due_date_only,
  CASE WHEN c."Doctor Due Date" IS NULL THEN NULL::integer
       ELSE project_ship_date(now()) - c."Doctor Due Date"::date END AS days_late_if_approved_now,
  CASE WHEN c."Doctor Due Date" IS NULL THEN false
       ELSE project_ship_date(now()) > c."Doctor Due Date"::date END AS will_miss_due_date,
  ap.design_notes                                            AS account_preferences,
  ap.derived_from_accounts                                   AS prefs_auto,
  (ap.pref_summaries -> COALESCE(pend.reason, 'design_approval'::outreach_reason)::text) ->> 'headline'::text AS prefs_summary_headline,
  (ap.pref_summaries -> COALESCE(pend.reason, 'design_approval'::outreach_reason)::text) ->> 'detail'::text   AS prefs_summary_detail,
  COALESCE(rev.revenue, 0::numeric)                          AS case_revenue,
  a."Strategic Partner"                                      AS strategic_partner,
  tri.evidence_at,
  tri.evidence_kind,
  'pending_approval'::text                                   AS triage_bucket,
  lc.occurred_at                                             AS most_recent_comm_at,
  lc.medium                                                  AS most_recent_comm_medium,
  lc.direction                                               AS most_recent_comm_direction,
  lc.source_type                                             AS most_recent_comm_source_type,
  lc.subject                                                 AS most_recent_comm_subject,
  lc.body_text                                               AS most_recent_comm_body,
  lc.actor                                                   AS most_recent_comm_actor,
  lc.counterparty                                            AS most_recent_comm_counterparty,
  lr.cc_recipients                                           AS most_recent_comm_cc,
  lr.received_at                                             AS most_recent_comm_cc_at,
  c."Case Status"                                            AS case_status,
  c."Business Unit"                                          AS business_unit,
  (pend.attempt_id IS NOT NULL)                              AS has_draft,
  -- ----- Sonnet parse state (case_parse_state) -----
  ps.approval_state                                          AS approval_state,
  ps.most_recent_unapproved_reason                           AS most_recent_unapproved_reason,
  COALESCE(ps.initial_design_in_progress, false)             AS initial_design_in_progress,
  (ps.case_number IS NOT NULL)                               AS parsed,
  ps.parsed_at                                               AS parsed_at,
  COALESCE(ps.design_approval_attempt_count, 0)              AS design_approval_attempt_count,
  COALESCE(ps.design_modification_count, 0)                  AS design_modification_count,
  COALESCE(ps.missing_info, 0)                               AS missing_info_count,
  COALESCE(ps.waiting_on_parts, 0)                           AS waiting_on_parts_count,
  COALESCE(ps.late_approval_notice, 0)                       AS late_approval_notice_count,
  COALESCE(ps.reschedule_check, 0)                           AS reschedule_check_count,
  COALESCE(ps.scan_submission_ack, 0)                        AS scan_submission_ack_count
FROM wip c
  LEFT JOIN "Accounts" a            ON a."Account Number" = c."Account Number"
  LEFT JOIN pend                    ON pend.case_number   = c."Case Number"
  LEFT JOIN case_exocad_links xl    ON xl.case_number     = c."Case Number"
  LEFT JOIN case_missing_info_summaries mi ON mi.case_number = c."Case Number"
  LEFT JOIN account_preferences ap  ON ap.account_number = c."Account Number"
  LEFT JOIN rev                     ON rev.case_number    = c."Case Number"
  LEFT JOIN case_parse_state ps     ON ps.case_number     = c."Case Number"
  LEFT JOIN LATERAL (
    SELECT count(*) AS comm_count,
           max(cc.occurred_at) AS evidence_at,
           (array_agg(cc.channel_source ORDER BY cc.occurred_at DESC))[1] AS evidence_kind
    FROM case_communications cc
    WHERE cc.case_number = c."Case Number"
  ) tri ON true
  LEFT JOIN LATERAL (
    SELECT cc.occurred_at, cc.medium, cc.direction, cc.source_type,
           cc.subject, cc.body_text, cc.actor, cc.counterparty
    FROM case_communications cc
    WHERE cc.case_number = c."Case Number"
    ORDER BY cc.occurred_at DESC
    LIMIT 1
  ) lc ON true
  LEFT JOIN LATERAL (
    SELECT r2.cc_recipients, r2.received_at
    FROM dr_outreach_replies r2
      LEFT JOIN dr_outreach_queue q2 ON q2.id = r2.queue_id
    WHERE COALESCE(r2.case_number, q2.case_number) = c."Case Number"
      AND r2.cc_recipients IS NOT NULL
      AND array_length(r2.cc_recipients, 1) > 0
    ORDER BY r2.received_at DESC
    LIMIT 1
  ) lr ON true
-- Hide cases the doctor already approved / approved-small-fix / moved to production. A case that
-- has not been parsed yet (ps.* NULL) defaults to visible so nothing silently disappears.
WHERE COALESCE(ps.show_in_pending_outbound, true);

GRANT SELECT ON public.v_fullarch_wip_outbound TO anon, authenticated, service_role;
