-- Auto-reply for inbound iOS-scan submissions — Part 6.
--
-- pg_cron tick for classify-scan-submission (every 10 min), mirroring the
-- suggest-case-number job (20260601_04). Batched (25) + idempotent (the function only
-- picks rows where scan_ack_at IS NULL), so it drains any backlog then idles on the trickle.
SELECT cron.schedule('classify-scan-submission', '*/10 * * * *', $$
  SELECT net.http_post(
    url     := 'https://asdunkqodixbhbohxtuq.functions.supabase.co/classify-scan-submission',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{"batch":25}'::jsonb)
$$);
