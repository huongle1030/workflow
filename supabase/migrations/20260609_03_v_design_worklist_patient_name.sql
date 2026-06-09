-- Add patient_name to the Design Dept board (v_design_worklist).
--
-- The Design Approval board tiles (and the case-detail modal) now surface the
-- patient name. Only change vs 20260609_01 is the new patient_name column in the
-- base CTE + final SELECT; everything else is identical.

CREATE OR REPLACE VIEW public.v_design_worklist AS
WITH design_steps AS (
  SELECT DISTINCT "Step" AS step
  FROM "Production Step IDs"
  WHERE "Department 1" = 'Design'
     OR "Step Consolidated" = 'Design Approval'
),
base AS (
  SELECT
    c."Case Number"                                                AS case_number,
    c."Pan Number"                                                 AS pan_number,
    NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name,
    c."Doctor Due Date"                                           AS doctor_due_date,
    (c."Doctor Due Date" AT TIME ZONE 'America/Los_Angeles')::date AS doctor_due_date_only,
    c."Received Date"                                             AS received_date,
    c."Business Unit"                                             AS business_unit,
    c."Current Step"                                              AS current_step,
    ps.step_consolidated,
    ps.product_line,
    c."Primary Product"                                          AS primary_product,
    c."Case Status"                                              AS case_status,
    COALESCE(c."Hold Flag", 0)                                   AS hold_flag,
    COALESCE(c."Hold Days", 0)                                   AS hold_days,
    c."Hold Reason"                                              AS hold_reason,
    p."Finishing Material"                                       AS finishing_material,
    p."Product Category"                                         AS product_category
  FROM "Cases" c
  LEFT JOIN "Products" p ON p."Product Number" = c."Primary Product Number"
  LEFT JOIN LATERAL (
    SELECT psi."Step Consolidated" AS step_consolidated, psi."Department 0" AS product_line
    FROM "Production Step IDs" psi
    WHERE psi."Step" = c."Current Step"
    LIMIT 1
  ) ps ON true
  WHERE c."Case Status" IN ('WIP', 'Hold')
    AND c."Current Step" IN (SELECT step FROM design_steps)
),
rush AS (
  SELECT cs."Case Number" AS case_number, max(cs."Rush Order") AS rush_order
  FROM "Case Steps" cs
  JOIN base b ON b.case_number = cs."Case Number" AND cs."Step" = b.current_step
  GROUP BY cs."Case Number"
),
hot AS (
  SELECT DISTINCT case_number
  FROM hot_list_cases
  WHERE status IN ('pending', 'open', 'accepted')
),
inv AS (
  SELECT li."Case Number" AS case_number, sum(li."Price Net") AS invoice_total
  FROM "Line Items" li
  WHERE li."Case Number" IN (SELECT case_number FROM base)
  GROUP BY li."Case Number"
),
lasttech AS (
  SELECT DISTINCT ON (s."Case Number")
    s."Case Number" AS case_number,
    s."Tech Name"   AS last_tech,
    s."Step"        AS last_tech_step,
    s."Finish Date" AS last_tech_finished
  FROM "Case Steps" s
  WHERE s."Case Number" IN (SELECT case_number FROM base)
    AND s."Tech Name" IS NOT NULL
    AND s."Tech Name" NOT ILIKE '%-Ship'
    AND s."Finish Date" IS NOT NULL
    AND s."Finish Date" <= now()
  ORDER BY s."Case Number", s."Finish Date" DESC, s."Seq No" DESC
)
SELECT
  cl.case_number,
  cl.pan_number,
  cl.doctor_due_date,
  cl.doctor_due_date_only,
  cl.received_date,
  cl.business_unit,
  cl.current_step,
  cl.step_consolidated,
  cl.product_line,
  cl.primary_product,
  cl.finishing_material,
  cl.product_category,
  cl.case_status,
  (COALESCE(r.rush_order, 0) = 1)                                   AS is_rush,
  (h.case_number IS NOT NULL
    OR cl.doctor_due_date_only = (now() AT TIME ZONE 'America/Los_Angeles')::date) AS is_hot,
  (cl.hold_flag = 1)                                               AS is_on_hold,
  cl.hold_days,
  cl.hold_reason,
  CASE
    WHEN COALESCE(r.rush_order, 0) = 1 THEN 0
    WHEN h.case_number IS NOT NULL
      OR cl.doctor_due_date_only = (now() AT TIME ZONE 'America/Los_Angeles')::date THEN 1
    ELSE 2
  END                                                             AS priority_rank,
  ((now() AT TIME ZONE 'America/Los_Angeles')::date - cl.received_date) AS days_in_lab,
  COALESCE(inv.invoice_total, 0)                                   AS invoice_total,
  lt.last_tech,
  lt.last_tech_step,
  (lt.last_tech_finished AT TIME ZONE 'America/Los_Angeles')::date AS last_tech_at,
  cl.patient_name
FROM base cl
LEFT JOIN rush r      ON r.case_number  = cl.case_number
LEFT JOIN hot  h      ON h.case_number  = cl.case_number
LEFT JOIN inv         ON inv.case_number = cl.case_number
LEFT JOIN lasttech lt ON lt.case_number  = cl.case_number;

GRANT SELECT ON public.v_design_worklist TO anon, authenticated, service_role;
