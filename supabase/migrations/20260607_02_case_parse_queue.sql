-- Sonnet-driven Pending Outbound tracking — Part 2: hybrid trigger + work queue.
--
-- Triggering is hybrid (per spec): a Postgres trigger on case_communications INSERT enqueues the
-- case id into a lightweight work queue; a frequent cron worker (parse-case-comms edge function)
-- drains the queue and calls Sonnet, re-parsing the FULL history each run. We never call Sonnet
-- inline on the insert.
--
-- The trigger only enqueues cases the Pending Outbound view actually cares about (Full Arch + WIP
-- with a doctor-design-approval step), so the 170k+ background note/email inserts on out-of-scope
-- cases don't flood the queue or burn Sonnet calls.

CREATE TABLE IF NOT EXISTS public.case_parse_queue (
  case_number   text PRIMARY KEY,
  status        text NOT NULL DEFAULT 'pending',   -- pending | processing | done | error
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  picked_at     timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text
);

CREATE INDEX IF NOT EXISTS case_parse_queue_status_idx
  ON public.case_parse_queue (status, enqueued_at);

-- Enqueue (or re-arm) a case for re-parse. SECURITY DEFINER so the UI / RPCs can call it under the
-- anon/authenticated role. Used by the trigger, by confirm_reply (modification button), and by any
-- manual "re-parse this case" path.
CREATE OR REPLACE FUNCTION public.enqueue_case_parse(p_case_number text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.case_parse_queue (case_number, status, enqueued_at)
  VALUES (p_case_number, 'pending', now())
  ON CONFLICT (case_number) DO UPDATE
    SET status = 'pending', enqueued_at = now(), last_error = NULL;
$$;

-- Trigger function: on a new communication, enqueue the case IF it is in the Pending Outbound scope.
CREATE OR REPLACE FUNCTION public.enqueue_case_parse_from_comm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.case_number IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "Cases" c
    WHERE c."Case Number" = NEW.case_number
      AND c."Business Unit" = 'Full Arch'
      AND c."Case Status"   = 'WIP'
      AND EXISTS (
        SELECT 1 FROM "Case Steps" s
        WHERE s."Case Number" = c."Case Number"
          AND s."Step" IN ('Doctor Design Approval - Full Arch', 'Dr. STL Approval Needed')
      )
  ) THEN
    PERFORM public.enqueue_case_parse(NEW.case_number);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_case_parse ON public.case_communications;
CREATE TRIGGER trg_enqueue_case_parse
  AFTER INSERT ON public.case_communications
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_case_parse_from_comm();

-- Worker pick: atomically claim up to p_limit pending cases (concurrency-safe). The edge function
-- calls this, parses each, then apply_case_parse_result() marks the row done.
CREATE OR REPLACE FUNCTION public.pick_cases_for_parse(p_limit integer DEFAULT 15)
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.case_parse_queue q
  SET status = 'processing', picked_at = now(), attempts = q.attempts + 1
  WHERE q.case_number IN (
    SELECT case_number
    FROM public.case_parse_queue
    WHERE status = 'pending'
    ORDER BY enqueued_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.case_number;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_case_parse(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pick_cases_for_parse(integer) TO service_role;

-- Seed: enqueue every case currently in the Pending Outbound worklist so the first cron ticks
-- backfill the whole tab. Idempotent.
INSERT INTO public.case_parse_queue (case_number, status, enqueued_at)
SELECT DISTINCT case_number, 'pending', now()
FROM public.v_fullarch_wip_outbound
WHERE case_number IS NOT NULL
ON CONFLICT (case_number) DO NOTHING;
