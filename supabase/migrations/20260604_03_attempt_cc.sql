-- Outbound CC: let coordinators type addresses to CC on a Pending Outbound / Approval draft
-- and have those people actually receive the email when it sends.
--
-- cc_emails is read by BOTH send paths:
--   * send-attempt edge function (immediate "Approve & Send")
--   * dr-outreach-tick cron (the "Edit Then Send" path only queues; the cron sends it)
-- so the CC list must live on the attempt row, not just be passed inline to one sender.
--
-- The frontend writes CC with the publishable (anon) key, so persistence goes through a
-- SECURITY DEFINER RPC rather than a direct table write (see memory: data-layer-uses-publishable-key).

ALTER TABLE public.dr_outreach_attempts
  ADD COLUMN IF NOT EXISTS cc_emails text[];

CREATE OR REPLACE FUNCTION public.set_attempt_cc(p_attempt_id uuid, p_cc_emails text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.dr_outreach_attempts
     SET cc_emails = NULLIF(p_cc_emails, '{}'::text[])
   WHERE id = p_attempt_id;
$$;

GRANT EXECUTE ON FUNCTION public.set_attempt_cc(uuid, text[]) TO anon, authenticated, service_role;
