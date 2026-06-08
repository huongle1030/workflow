-- Nest worklist — drives the new "Nest" mode (Mill / Print nesting boards).
--
-- One row per case that is currently sitting at a NESTING step, split by whether the
-- case is headed for MILLING or PRINTING, with the flags the board needs to prioritize
-- and filter. The app reads this view with the publishable (anon) key over PostgREST,
-- so it is granted to anon/authenticated like the other v_* worklist views.
--
-- Scope (confirmed with the user):
--   * Case Status IN ('WIP','Hold)   -- held cases keep their nest step; the Hold filter needs them
--   * Current Step ILIKE 'Nest%'     -- the nesting queue (e.g. 'Nest 2 - C&B', 'Nest - Digital Print',
--                                       'Nest - Full Arch', 'Nest Model 3 - C&B', ...)
--
-- Mill vs Print classifier (heuristic on product + step + finishing material — material ALONE is
-- unreliable because PMMA spans milled pucks AND 3D-printed dentures). This is the canonical rule;
-- the front-end trusts `method`/`method_uncertain` from this view (keep any FE fallback in lockstep):
--   PRINT  when the text mentions print/printed/3D print, the step is a "...Model..." nest (models are
--          printed), or it's a try-in / nightguard / surgical guide / stackable.
--   MILL   when the text mentions zirconia/emax/(lithium )disilicate/pressed/PFM/PFZ/feldspathic/veneer/
--          inlay/onlay/monolithic/milled/mill/wax/bar/crown, or the finishing material is a milled one.
--   Anything that matches BOTH or NEITHER is still placed (best guess by step) but `method_uncertain`
--   is set true -> the tile shows a RED ASTERISK so a human can verify the routing.
--
-- Priority (consumed by the board; top-left = highest): is_rush > is_hot > doctor_due_date asc.
--   is_rush -> the case's current step has Rush Order = 1.
--   is_hot  -> the case is on the active hot list OR is due today (Pacific).

CREATE OR REPLACE VIEW public.v_nest_worklist AS
WITH base AS (
  SELECT
    c."Case Number"                                                   AS case_number,
    c."Pan Number"                                                    AS pan_number,
    c."Doctor Due Date"                                              AS doctor_due_date,
    (c."Doctor Due Date" AT TIME ZONE 'America/Los_Angeles')::date    AS doctor_due_date_only,
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
    NOT (f.print_strong <> f.mill_strong) AS method_uncertain   -- uncertain unless exactly one side is strong
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
  END                                                             AS priority_rank
FROM classified cl
LEFT JOIN rush r ON r.case_number = cl.case_number
LEFT JOIN hot  h ON h.case_number = cl.case_number;

GRANT SELECT ON public.v_nest_worklist TO anon, authenticated, service_role;
