-- Run the reply-resolver every 5 minutes (same pattern as the parse-case-comms cron). Drains a batch
-- of candidate replies via the resolve-replies edge function; unresolved replies are re-checked only
-- when a new lab-side comm arrives (pick_replies_to_resolve gates on resolve_checked_labcomm_count).
SELECT cron.schedule(
  'resolve-replies',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://asdunkqodixbhbohxtuq.functions.supabase.co/resolve-replies',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{"batch":15}'::jsonb)
  $$
);
