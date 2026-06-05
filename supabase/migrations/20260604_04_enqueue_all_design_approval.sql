-- Widen the design-approval enqueuer so EVERY eligible Full-Arch case gets a draft.
--
-- Previously enqueue_due_outreach() called enqueue_aox_design_approval_recent(24), which only
-- enqueued cases that entered "Doctor Design Approval - Full Arch" within the last 24 hours.
-- Any case that sat longer than 24h before pickup never got a draft and was stranded in the
-- "Ready for ABS Scan" view. Coordinators want a draft for every eligible case.
--
-- The fix makes the time window optional (p_window_hours IS NULL => no recency gate) and has the
-- orchestrator pass NULL. Eligibility is still bounded by v_aox_design_approval_due (which already
-- excludes approved, already-queued, and emailed-in-last-7-days cases), and the NOT EXISTS dedup
-- guard still prevents duplicate open queue rows. Safe to run now: v_aox_design_approval_due
-- currently returns 0 rows, so there is no backlog burst -- this is a forward-looking guarantee.

CREATE OR REPLACE FUNCTION public.enqueue_aox_design_approval_recent(p_window_hours integer DEFAULT 24)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v_inserted INT;
BEGIN
  INSERT INTO dr_outreach_queue
    (case_number, account_number, reason, status, attempt_count, next_followup_at)
  SELECT
    v.case_number,
    v.account_number,
    'design_approval'::outreach_reason,
    'open',
    0,
    now()
  FROM v_aox_design_approval_due v
  WHERE (p_window_hours IS NULL
         OR v.waiting_since >= now() - (p_window_hours || ' hours')::interval)
    AND NOT EXISTS (
      SELECT 1 FROM dr_outreach_queue q
      WHERE q.case_number = v.case_number
        AND q.reason = 'design_approval'
        AND q.status = 'open'
    );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END $function$;

CREATE OR REPLACE FUNCTION public.enqueue_due_outreach()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM close_advanced_aox_cases();
  -- NULL window => enqueue every eligible Full-Arch design-approval case, not just the last 24h.
  RETURN enqueue_aox_design_approval_recent(NULL);
END $function$;
