-- Thread approved outbound email into the doctor's existing conversation.
--
-- dr-outreach-reply already derives which shared mailbox (clearchoice@/implants@) each
-- inbound doctor email lives in, but never persisted it. send-attempt + dr-outreach-tick
-- now look up the most recent inbound reply for a queue and, when one exists, send the
-- approved draft as a Graph reply (createReply) FROM that same mailbox so it lands in the
-- same Outlook conversation thread. Graph's reply endpoint must run from the mailbox where
-- the message physically resides, so we need to store it here. Rows ingested before this
-- migration have mailbox = NULL and simply fall back to the standalone new-message path.
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS mailbox text;

-- Backs the "most recent inbound reply for this queue that we can reply to" lookup.
CREATE INDEX IF NOT EXISTS idx_dr_replies_queue_recent
  ON public.dr_outreach_replies (queue_id, received_at DESC)
  WHERE graph_message_id IS NOT NULL;
