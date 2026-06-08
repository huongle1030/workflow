-- Extends 20260608_05: Ready for ABS Scan now also includes cases approved via the Pending Replies
-- "Approved + Mods" button (coordinator_decision='approved_with_mods'), tagged source
-- 'reply_approved_mods' so the front-end labels the Approved column "Approved + Mods, contact
-- designer" (renderReady in src/main.js). Still view-only — v_combined_approved_cases / the Approved
-- KPI are untouched.
--
-- Source-label precedence (array_agg ORDER BY CASE): reply_approved_mods FIRST (the "contact
-- designer" action must surface even if the case is also approved another way), then non-button
-- sources (abs_advanced/casecoord/outreach), then plain reply_approved LAST (a plain approval never
-- overrides a pre-existing recognition). GROUP BY normalized case number => no duplicate rows. Only
-- 'approved' and 'approved_with_mods' qualify (NOT 'modification', which is a pure redesign).
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
            (array_agg(u.source ORDER BY
                CASE u.source
                  WHEN 'reply_approved_mods' THEN 0
                  WHEN 'reply_approved'      THEN 2
                  ELSE 1
                END,
                u.approved_on DESC NULLS LAST))[1] AS source
           FROM (
                 SELECT cac.case_number AS norm_case_number, cac.approved_on, cac.source
                   FROM v_combined_approved_cases cac
                 UNION ALL
                 SELECT regexp_replace(TRIM(BOTH FROM COALESCE(r.case_number, q.case_number)), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text) AS norm_case_number,
                        r.decided_at::date AS approved_on,
                        CASE WHEN r.coordinator_decision = 'approved_with_mods'::text
                             THEN 'reply_approved_mods'::text ELSE 'reply_approved'::text END AS source
                   FROM dr_outreach_replies r
                     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
                  WHERE r.coordinator_decision IN ('approved'::text, 'approved_with_mods'::text)
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
