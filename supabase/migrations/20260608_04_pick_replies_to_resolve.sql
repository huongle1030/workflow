-- Candidate inbound replies for the Claude resolve check (resolve-replies edge function).
-- Returns undecided replies, not from us, linked to a case, not already 'resolved', that have at
-- least one later LAB-side comm (note / phone call / outbound) AND need a (re)check: never checked,
-- or a new lab comm has arrived since the last check (resolve_checked_labcomm_count < current count).
-- 'resolved' replies are excluded so they're never re-evaluated.
CREATE OR REPLACE FUNCTION public.pick_replies_to_resolve(p_limit integer DEFAULT 15)
RETURNS TABLE(reply_id uuid, case_number text, subject text, body_text text,
              received_at timestamptz, labcomm_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.id AS reply_id,
         COALESCE(r.case_number, q.case_number) AS case_number,
         r.subject, r.body_text, r.received_at,
         lc.cnt AS labcomm_count
  FROM dr_outreach_replies r
  LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS cnt
    FROM case_communications cc
    WHERE cc.case_number = COALESCE(r.case_number, q.case_number)
      AND cc.occurred_at > r.received_at
      AND (cc.medium = 'note' OR cc.channel_source = 'phone_call' OR cc.direction = 'outbound')
  ) lc
  WHERE r.decided_at IS NULL
    AND lower(r.from_email) NOT LIKE '%@skdla.com'
    AND COALESCE(r.case_number, q.case_number) IS NOT NULL
    AND r.resolve_state IS DISTINCT FROM 'resolved'
    AND lc.cnt > 0
    AND (r.resolve_checked_at IS NULL OR r.resolve_checked_labcomm_count < lc.cnt)
  ORDER BY r.received_at
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$$;
