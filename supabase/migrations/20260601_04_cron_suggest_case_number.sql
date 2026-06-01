-- Part 5 — pg_cron tick for suggest-case-number (every 10 min), mirroring the
-- classify-comms-ai job. Batched (25) + idempotent (the function only picks rows
-- where suggested_at IS NULL), so it drains the ~145-row backlog within ~1 hour
-- then idles on the trickle.
SELECT cron.schedule('suggest-case-number', '*/10 * * * *', $$
  SELECT net.http_post(
    url     := 'https://asdunkqodixbhbohxtuq.functions.supabase.co/suggest-case-number',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{"batch":25}'::jsonb)
$$);
