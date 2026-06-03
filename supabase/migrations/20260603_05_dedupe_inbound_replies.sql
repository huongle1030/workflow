-- Dedupe inbound replies — stop duplicate scan-ack drafts.
--
-- dr-outreach-reply inserted a new dr_outreach_replies row for EVERY Graph change
-- notification, with no idempotency guard. Microsoft Graph delivers notifications
-- at-least-once (it re-fires the same message seconds apart), and the same email also
-- lands in multiple watched mailboxes (implants@, clearchoice@, MS_SENDER) — each a
-- separate notification with a DIFFERENT graph_message_id. Both paths created duplicate
-- reply rows, and classify-scan-submission then drafted one scan-ack per row, so a single
-- doctor email surfaced as 2–3 identical drafts in Pending Outbound.
--
-- internetMessageId (the RFC-822 Message-ID header) is stable across BOTH duplication
-- sources: same value on every re-delivery and in every mailbox copy. Make it the
-- idempotency key. NULLs are distinct in a Postgres unique index, so the pre-existing
-- rows (which never stored this value) coexist fine; the guard only constrains new rows.
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS internet_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS dr_outreach_replies_internet_msg_id_key
  ON public.dr_outreach_replies (internet_message_id);
