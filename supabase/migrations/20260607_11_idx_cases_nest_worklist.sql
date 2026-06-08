-- Performance: partial index covering exactly the v_nest_worklist population so the
-- view's base CTE does an index scan (~417 rows) instead of a parallel seq scan of the
-- ~286k-row "Cases" table. Together with idx_case_steps_casenum (migration _10) this
-- takes the view from ~6s to <100ms, keeping the anon REST read (statement_timeout=3s)
-- safe even on a cold cache.
--
-- The predicate matches the view's WHERE exactly so the planner can use it.

CREATE INDEX IF NOT EXISTS idx_cases_nest_worklist
  ON public."Cases" ("Case Number")
  WHERE "Case Status" IN ('WIP', 'Hold') AND "Current Step" ILIKE 'Nest%';
