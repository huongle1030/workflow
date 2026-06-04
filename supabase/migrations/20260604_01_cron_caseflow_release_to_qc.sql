-- CaseFlow: auto-release outsourced cases to QC after the overnight hold.
--
-- When a case is sent to an outsource partner the client stamps
-- aox_review.qcReleaseAt = 4:00am the FOLLOWING day (stored as an absolute
-- timestamp). This server-side job is the backstop for the client-side sweep
-- (src/caseflow/app.js releaseOutsourcedToQc): it moves any 'Outsourcing' case
-- whose release time has passed into 'QC', even when no one has the app open.
--
-- Idempotent + safe to re-run. Mirrors the existing pg_cron jobs
-- (20260601_04, 20260602_06) but runs SQL directly instead of an edge function
-- since the move is a plain UPDATE (no external call needed).

CREATE OR REPLACE FUNCTION public.caseflow_release_outsourced_to_qc()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n integer;
BEGIN
  WITH moved AS (
    UPDATE public.caseflow_cases
    SET stage  = 'QC',
        events = COALESCE(events, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                   'text', 'Auto-released to QC (overnight outsource hold elapsed)',
                   'by',   'System',
                   'at',   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    WHERE stage = 'Outsourcing'
      AND NULLIF(aox_review->>'qcReleaseAt', '') IS NOT NULL
      AND (aox_review->>'qcReleaseAt')::timestamptz <= now()
    RETURNING 1
  )
  SELECT count(*) INTO n FROM moved;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION public.caseflow_release_outsourced_to_qc() TO anon, authenticated, service_role;

-- Every 5 minutes. Release times are always at 4:00am local (whole-hour
-- timezones align with a */5 tick), so cases move at ~4:00am with ≤5min slack.
SELECT cron.schedule('caseflow-release-outsourced-to-qc', '*/5 * * * *', $$
  SELECT public.caseflow_release_outsourced_to_qc()
$$);
