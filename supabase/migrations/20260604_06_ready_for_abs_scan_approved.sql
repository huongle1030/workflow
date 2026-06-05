-- "Ready for ABS Scan" should list cases the DOCTOR HAS APPROVED that are still sitting at the
-- "Doctor Design Approval - Full Arch" step -- i.e. ABS's worklist of cases to scan off.
--
-- The existing v_aox_design_approval_due shows the OPPOSITE (cases still waiting / not approved)
-- and is also consumed by the draft enqueuer, so we must NOT repurpose it. This adds a separate
-- view for the UI tab. It reuses the same dda_cases / waiting_at / Accounts pattern, then
-- INNER-joins the canonical doctor-approval signal v_combined_approved_cases (coordinator-approved
-- outreach + ABS-advanced + Case Coord 'Dr Approved'), normalizing the case number to match.
--
-- Cases approved via the 'abs_advanced' source have by definition already left the step, so the
-- inner join with dda_cases (still at the step) naturally drops them.

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
          WHERE c."Current Step" = 'Doctor Design Approval - Full Arch'::text
            AND (c."Case Status" = ANY (ARRAY['WIP'::text, 'Hold'::text]))
        ), waiting_at AS (
         SELECT DISTINCT ON (cs."Case Number") cs."Case Number" AS case_number,
            cs."Start Date" AS waiting_since
           FROM "Case Steps" cs
             JOIN dda_cases d_1 ON d_1.case_number = cs."Case Number"
          WHERE cs."Step" = 'Doctor Design Approval - Full Arch'::text
            AND (cs."Status" = ANY (ARRAY['S'::text, 'B'::text]))
          ORDER BY cs."Case Number", cs."Start Date" DESC
        ), approved AS (
         -- Scan the (heavy) combined-approved view ONCE and collapse to one row per
         -- normalized case number (most recent approval wins). Joining this as a
         -- correlated LATERAL instead re-ran the whole view per case (~14s); this is a
         -- single pass + hash join.
         SELECT cac.case_number AS norm_case_number,
            max(cac.approved_on) AS approved_on,
            (array_agg(cac.source ORDER BY cac.approved_on DESC NULLS LAST))[1] AS source
           FROM v_combined_approved_cases cac
          GROUP BY cac.case_number
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
     JOIN approved ap
       ON ap.norm_case_number = regexp_replace(TRIM(BOTH FROM d.case_number), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text);
