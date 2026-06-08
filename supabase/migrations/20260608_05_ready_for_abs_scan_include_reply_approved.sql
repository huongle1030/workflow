-- Ready for ABS Scan now also recognizes cases the doctor approved via the Pending Replies
-- "Approved" button (dr_outreach_replies.coordinator_decision = 'approved').
--
-- This adds a 4th approval signal INSIDE THIS VIEW ONLY — v_combined_approved_cases and the
-- Approved KPI tile it feeds are intentionally NOT changed (so the KPI doesn't shift). Behavior:
--   * GROUP BY normalized case number => a case already in Ready via another source (abs_advanced /
--     casecoord / outreach draft-approval) is NOT duplicated.
--   * The source label prefers any NON-reply source: array_agg(... ORDER BY (source='reply_approved'))
--     puts reply_approved last, so a pre-existing recognition is preserved and the button only adds
--     cases that weren't already in the list.
--   * Only coordinator_decision = 'approved' qualifies (NOT 'approved_with_mods', which sets the case
--     to "Design Changes Requested" — a redesign, not ready to scan).
-- A case still only appears when it's also parked at Current Step 'Doctor Design Approval - Full Arch'
-- (Case Status WIP/Hold), same as before.
CREATE OR REPLACE VIEW public.v_aox_ready_for_abs_scan AS
 WITH dda_cases AS (
         SELECT c."Case Number" AS case_number,
            c."Account Number" AS account_number,
            c."Doctor Due Date" AS doctor_due_date,
            c."Hold Reason" AS hold_reason,
            c."Current Step" AS current_step,
            c."Pan Number" AS pan_number,
            c."Case Status" AS case_status,
            NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name
           FROM "Cases" c
          WHERE c."Current Step" = 'Doctor Design Approval - Full Arch'::text AND (c."Case Status" = ANY (ARRAY['WIP'::text, 'Hold'::text]))
        ), waiting_at AS (
         SELECT DISTINCT ON (cs."Case Number") cs."Case Number" AS case_number,
            cs."Start Date" AS waiting_since
           FROM "Case Steps" cs
             JOIN dda_cases d_1 ON d_1.case_number = cs."Case Number"
          WHERE cs."Step" = 'Doctor Design Approval - Full Arch'::text AND (cs."Status" = ANY (ARRAY['S'::text, 'B'::text]))
          ORDER BY cs."Case Number", cs."Start Date" DESC
        ), approved AS (
         SELECT u.norm_case_number,
            max(u.approved_on) AS approved_on,
            (array_agg(u.source ORDER BY (u.source = 'reply_approved'::text), u.approved_on DESC NULLS LAST))[1] AS source
           FROM (
                 SELECT cac.case_number AS norm_case_number, cac.approved_on, cac.source
                   FROM v_combined_approved_cases cac
                 UNION ALL
                 SELECT regexp_replace(TRIM(BOTH FROM COALESCE(r.case_number, q.case_number)), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text) AS norm_case_number,
                        r.decided_at::date AS approved_on,
                        'reply_approved'::text AS source
                   FROM dr_outreach_replies r
                     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
                  WHERE r.coordinator_decision = 'approved'::text
                    AND r.decided_at IS NOT NULL
                    AND COALESCE(r.case_number, q.case_number) IS NOT NULL
                ) u
          GROUP BY u.norm_case_number
        )
 SELECT d.case_number,
    COALESCE(w.waiting_since, now()) AS waiting_since,
    d.account_number,
    d.doctor_due_date,
    d.hold_reason,
    d.current_step,
    d.pan_number,
    d.patient_name,
    a."First Name" AS dr_first_name,
    a."Last Name" AS dr_last_name,
    a."Dr Pref" AS dr_pref,
    a."Practice Name" AS practice_name,
    a."Primary Email" AS dr_email,
    a."Account Manager" AS account_manager,
    ap.approved_on,
    ap.source AS approved_source
   FROM dda_cases d
     LEFT JOIN waiting_at w ON w.case_number = d.case_number
     JOIN "Accounts" a ON a."Account Number" = d.account_number
     JOIN approved ap ON ap.norm_case_number = regexp_replace(TRIM(BOTH FROM d.case_number), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text);
