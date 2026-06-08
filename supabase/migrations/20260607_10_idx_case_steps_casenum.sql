-- Performance: index "Case Steps"."Case Number" so v_nest_worklist's rush + lasttech
-- CTEs do per-case index lookups instead of two full seq scans of the 3.4M-row table.
--
-- Without this, v_nest_worklist runs ~6s warm (far worse cold) and the anon REST read
-- hits PostgREST's statement_timeout (error 57014). "Case Steps" only had PARTIAL
-- indexes on "Case Number" (WHERE Status='C' / Status IN ('R','I')), which the planner
-- can't use for the view's unqualified Case-Number joins. A plain btree fixes it.

CREATE INDEX IF NOT EXISTS idx_case_steps_casenum
  ON public."Case Steps" ("Case Number");
