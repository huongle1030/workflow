-- Quality Control — Internal Remake form: extra captured + auto-populated fields.
--
-- The Internal Remake form (filled by dept_lead) gains: the technician who worked on the product,
-- the case step where the issue occurred, and several case facts auto-populated when the case number
-- is entered (ship date, doctor due date, received date, start date, time-in-lab, total invoice).
-- Internal Remake submissions are stored in mrb_cases (see src/qc/data.js createMrbEntry).
-- mrb_cases.technician already exists; add the rest.

ALTER TABLE public.mrb_cases
  ADD COLUMN IF NOT EXISTS issue_step       text,
  ADD COLUMN IF NOT EXISTS total_invoice    numeric,
  ADD COLUMN IF NOT EXISTS time_in_lab_days integer,
  ADD COLUMN IF NOT EXISTS start_date       date,
  ADD COLUMN IF NOT EXISTS received_date    date;

-- One-call case lookup for the Internal Remake form. SECURITY DEFINER so the publishable/anon key
-- can read the (quoted, space-named) master tables through it without broad direct grants. Returns
-- the auto-populate facts plus the case's ordered, de-duplicated production steps for the
-- "step where the issue occurred" dropdown.
CREATE OR REPLACE FUNCTION public.qc_case_lookup(p_case_number text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (
    SELECT * FROM "Cases" WHERE "Case Number" = p_case_number LIMIT 1
  ),
  steps AS (
    SELECT s."Step" AS step,
           min(s."Seq No")      AS seq,
           min(s."Start Date")  AS start_date,
           max(s."Finish Date") AS finish_date,
           (array_agg(s."Tech Name" ORDER BY s."Seq No"))[1] AS tech
    FROM "Case Steps" s
    WHERE s."Case Number" = p_case_number
    GROUP BY s."Step"
  ),
  inv AS (
    SELECT sum("Price Net") AS total FROM "Line Items" WHERE "Case Number" = p_case_number
  ),
  first_start AS (
    SELECT min("Start Date") AS d FROM "Case Steps" WHERE "Case Number" = p_case_number
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM c)
      THEN jsonb_build_object('found', false, 'case_number', p_case_number)
    ELSE jsonb_build_object(
      'found',            true,
      'case_number',      (SELECT "Case Number" FROM c),
      'business_unit',    (SELECT "Business Unit" FROM c),
      'ship_date',        (SELECT ("Ship Date")::date FROM c),
      'dr_due_date',      (SELECT ("Doctor Due Date")::date FROM c),
      'received_date',    (SELECT "Received Date" FROM c),
      'start_date',       (SELECT d::date FROM first_start),
      'time_in_lab_days', (
        SELECT CASE
          WHEN (SELECT "Received Date" FROM c) IS NULL THEN NULL
          ELSE COALESCE((SELECT ("Ship Date")::date FROM c), current_date) - (SELECT "Received Date" FROM c)
        END
      ),
      'total_invoice',    COALESCE((SELECT total FROM inv), 0),
      'steps', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'step', step, 'seq', seq,
                 'start_date', start_date, 'finish_date', finish_date, 'tech', tech
               ) ORDER BY seq)
        FROM steps
      ), '[]'::jsonb)
    )
  END;
$$;

GRANT EXECUTE ON FUNCTION public.qc_case_lookup(text) TO anon, authenticated, service_role;
