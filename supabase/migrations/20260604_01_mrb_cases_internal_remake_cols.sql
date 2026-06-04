-- Internal Remake submissions (Quality Control mode) insert into the existing
-- public.mrb_cases table. That table is the MRB review workflow (defect ->
-- disposition -> root cause); it lacks the four scheduling/routing fields the
-- Internal Remake form collects, so add them as nullable columns. Non-destructive
-- to the existing MRB review app. mrb_cases already has RLS off + public grants,
-- so the suite's publishable key can insert. See prd/PRD_quality_control_mode.md.

ALTER TABLE public.mrb_cases
  ADD COLUMN IF NOT EXISTS logged_by    text,     -- "Your Name" (submitter)
  ADD COLUMN IF NOT EXISTS ship_date    date,
  ADD COLUMN IF NOT EXISTS dr_due_date  date,
  ADD COLUMN IF NOT EXISTS needs_expert boolean;  -- true -> notify experts; false -> Final QC
