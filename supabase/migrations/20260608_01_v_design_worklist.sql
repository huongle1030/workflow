-- Design-department worklist — drives the "Design Dept" board in the Design Approvals mode.
--
-- "In the design department" = the case's CURRENT step maps to Department 1 = 'Design' in
-- the "Production Step IDs" lookup (27 steps: Prepare Files, Scan, Design, Design Bar,
-- Verification Jig, Custom Tray, QC Design — across Full Arch / Crown & Bridge / etc.).
-- Confirmed from the Production Step IDs table (Department 1 column).
--
-- Same shape/enrichments as v_nest_worklist (rush/hot/hold priority, material, last tech,
-- invoice, days-at-lab, click-modal fields) MINUS the mill/print classifier. Adds
-- step_consolidated + product_line (Department 0) for display + a Step filter.
--
-- Read by the publishable/anon key, so granted to anon/authenticated. The supporting
-- partial index keeps the anon read well under the 3s statement_timeout.

CREATE INDEX IF NOT EXISTS idx_cases_wiphold_step
  ON public."Cases" ("Current Step")
  WHERE "Case Status" IN ('WIP', 'Hold');

CREATE OR REPLACE VIEW public.v_design_worklist AS
WITH design_steps AS (
  SELECT DISTINCT "Step" AS step
  FROM "Production Step IDs"
  WHERE "Department 1" = 'Design'
),
base AS (
  SELECT
    c."Case Number"                                                AS case_number,
    c."Pan Number"                                                 AS pan_number,
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
  (lt.last_tech_finished AT TIME ZONE 'America/Los_Angeles')::date AS last_tech_at
FROM base cl
LEFT JOIN rush r      ON r.case_number  = cl.case_number
LEFT JOIN hot  h      ON h.case_number  = cl.case_number
LEFT JOIN inv         ON inv.case_number = cl.case_number
LEFT JOIN lasttech lt ON lt.case_number  = cl.case_number;

GRANT SELECT ON public.v_design_worklist TO anon, authenticated, service_role;
