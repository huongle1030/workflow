-- Nest worklist — add case-detail columns for the tile click-through modal.
--
-- Supersedes 20260607_08_v_nest_worklist.sql (CREATE OR REPLACE appends new trailing
-- columns; the existing columns/order are unchanged). Adds, per case:
--   received_date   -- "Cases"."Received Date"
--   days_in_lab     -- whole days since received (Pacific), the "how long at the lab" metric
--   invoice_total   -- sum of "Line Items"."Price Net" (matches wip_cases.invoice_total)
--   last_tech       -- technician on the most recent COMPLETED step (the step before the
--                      current nest step). "Case Steps" mixes real + projected/duplicate
--                      rows, so we take the latest row with a real Tech Name and a
--                      Finish Date <= now(), excluding the system '%-Ship' actors
--                      (OC-Ship / OI-Ship — these are ship pseudo-techs, not people).
--   last_tech_step  -- that step's name (context for the modal)
--   last_tech_at    -- that step's finish date (Pacific)
--
-- Mill/Print classifier, rush/hot/hold and priority_rank are unchanged from _08.

CREATE OR REPLACE VIEW public.v_nest_worklist AS
WITH base AS (
  SELECT
    c."Case Number"                                                   AS case_number,
    c."Pan Number"                                                    AS pan_number,
    c."Doctor Due Date"                                              AS doctor_due_date,
    (c."Doctor Due Date" AT TIME ZONE 'America/Los_Angeles')::date    AS doctor_due_date_only,
    c."Received Date"                                                AS received_date,
    c."Business Unit"                                                AS business_unit,
    c."Current Step"                                                 AS current_step,
    c."Primary Product"                                             AS primary_product,
    c."Case Status"                                                 AS case_status,
    COALESCE(c."Hold Flag", 0)                                      AS hold_flag,
    COALESCE(c."Hold Days", 0)                                      AS hold_days,
    c."Hold Reason"                                                 AS hold_reason,
    p."Finishing Material"                                          AS finishing_material,
    p."Product Category"                                            AS product_category,
    lower(concat_ws(' ', c."Primary Product", c."Current Step", p."Finishing Material")) AS norm
  FROM "Cases" c
  LEFT JOIN "Products" p ON p."Product Number" = c."Primary Product Number"
  WHERE c."Case Status" IN ('WIP', 'Hold')
    AND c."Current Step" ILIKE 'Nest%'
),
flags AS (
  SELECT b.*,
    COALESCE(
      b.norm ~ 'print'
      OR b.current_step ILIKE '%model%'
      OR b.norm ~ 'try.?in|night ?guard|surgical guide|stackable',
      false
    ) AS print_strong,
    COALESCE(
      b.norm ~ 'zirconia|emax|disilicate|pressed|pfm|pfz|feldspath|veneer|inlay|onlay|monolithic|milled|\ymill\y|\ywax\y|\ybar\y|crown'
      OR b.finishing_material IN (
        'Zirconia', 'Lithium Disilicate', 'Metal', 'Composite', 'Feldspathic',
        'Lithium Disilicate + Metal', 'Lithium Disilicate + Zirconia', 'Zirconia + Metal',
        'Nanoceramic', 'Vitallium', 'Chrome Cobalt', 'Alloy'
      ),
      false
    ) AS mill_strong
  FROM base b
),
classified AS (
  SELECT f.*,
    CASE
      WHEN f.print_strong AND NOT f.mill_strong THEN 'print'
      WHEN f.mill_strong AND NOT f.print_strong THEN 'mill'
      WHEN f.current_step ILIKE '%print%' OR f.current_step ILIKE '%model%' THEN 'print'
      ELSE 'mill'
    END AS method,
    NOT (f.print_strong <> f.mill_strong) AS method_uncertain
  FROM flags f
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
  cl.business_unit,
  cl.current_step,
  cl.primary_product,
  cl.finishing_material,
  cl.product_category,
  cl.case_status,
  cl.method,
  cl.method_uncertain,
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
  -- case-detail columns for the click-through modal
  cl.received_date,
  ((now() AT TIME ZONE 'America/Los_Angeles')::date - cl.received_date) AS days_in_lab,
  COALESCE(inv.invoice_total, 0)                                   AS invoice_total,
  lt.last_tech,
  lt.last_tech_step,
  (lt.last_tech_finished AT TIME ZONE 'America/Los_Angeles')::date AS last_tech_at
FROM classified cl
LEFT JOIN rush r      ON r.case_number  = cl.case_number
LEFT JOIN hot  h      ON h.case_number  = cl.case_number
LEFT JOIN inv         ON inv.case_number = cl.case_number
LEFT JOIN lasttech lt ON lt.case_number  = cl.case_number;

GRANT SELECT ON public.v_nest_worklist TO anon, authenticated, service_role;
