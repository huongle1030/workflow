-- Sonnet-driven Pending Outbound tracking — Part 6: cron worker.
--
-- pg_cron tick for parse-case-comms (every 5 min), mirroring classify-scan-submission
-- (20260602_06). The function drains a batch from case_parse_queue (pending rows) and calls Sonnet
-- on each, so this both backfills the seeded backlog and idles on the trickle the INSERT trigger
-- enqueues. Idempotent: each parse is a full recompute and the worker only picks 'pending' rows.

SELECT cron.schedule('parse-case-comms', '*/5 * * * *', $$
  SELECT net.http_post(
    url     := 'https://asdunkqodixbhbohxtuq.functions.supabase.co/parse-case-comms',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{"batch":15}'::jsonb)
$$);
