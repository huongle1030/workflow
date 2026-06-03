-- Auto-reply for inbound iOS-scan submissions — Part 4.
--
-- compose_scan_ack(reply_id) builds the templated acknowledgment draft for an inbound
-- scan-submission email and drops it into Pending Outbound for coordinator approval.
-- Patterned on compose_pending_attempt() but CASE-LESS and addressed to the doctor who
-- emailed (to_email = reply.from_email) instead of the account's Primary Email.
--
-- Requires the sender to match an Accounts row (so the queue keeps a valid
-- account_number and v_pending_outbound's INNER JOIN "Accounts" still holds). When no
-- account matches it raises; the caller (edge function) records that and skips the draft.
CREATE OR REPLACE FUNCTION public.compose_scan_ack(p_reply_id uuid)
RETURNS dr_outreach_attempts
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reply    dr_outreach_replies;
  v_acc      RECORD;
  v_account  TEXT;
  v_tpl      dr_outreach_templates;
  v_greeting TEXT;
  v_sender   TEXT;
  v_ctx      JSONB;
  v_subject  TEXT;
  v_body     TEXT;
  v_queue_id UUID;
  v_attempt  dr_outreach_attempts;
BEGIN
  SELECT * INTO v_reply FROM dr_outreach_replies WHERE id = p_reply_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reply % not found', p_reply_id; END IF;
  IF v_reply.from_email IS NULL OR LENGTH(TRIM(v_reply.from_email)) = 0 THEN
    RAISE EXCEPTION 'reply % has no from_email to reply to', p_reply_id;
  END IF;

  -- Resolve the sender to an account (case-insensitive exact match, no % wildcards).
  SELECT * INTO v_acc FROM "Accounts"
   WHERE "Primary Email" ILIKE v_reply.from_email
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no account matches sender % — cannot compose case-less ack', v_reply.from_email;
  END IF;
  v_account := v_acc."Account Number";

  SELECT * INTO v_tpl FROM dr_outreach_templates
   WHERE reason = 'scan_submission_ack' AND attempt_number = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'scan_submission_ack/1 template not found (run _02)'; END IF;

  -- Greeting: no case → no provider lookup; use account last name / practice.
  -- (Mirrors the account-name guards in compose_pending_attempt.)
  IF v_acc."Last Name" IS NOT NULL
     AND v_acc."Last Name" !~ '^\d'
     AND v_acc."Last Name" NOT ILIKE '%onboarded%'
     AND v_acc."Last Name" NOT ILIKE '%clearchoice%'
     AND v_acc."Last Name" NOT ILIKE '%aspen%'
     AND v_acc."Last Name" NOT ILIKE '%incisive%'
     AND LENGTH(v_acc."Last Name") < 40 THEN
    v_greeting := 'Hello Dr. ' || v_acc."Last Name";
  ELSIF v_acc."Practice Name" IS NOT NULL THEN
    v_greeting := 'Hi ' || v_acc."Practice Name" || ' team';
  ELSE
    v_greeting := 'Hello Doctor';
  END IF;

  -- Choose the From mailbox the same way pick_sender_mailbox() does, but keyed on the
  -- resolved account (there is no case): ClearChoice practices → clearchoice@skdla.com,
  -- everyone else (Aspen / Aspen Beacon / general) → implants@skdla.com. This mirrors
  -- which shared mailbox the doctor would have emailed.
  IF COALESCE(v_acc."Strategic Partner", '') ILIKE '%clearchoice%'
     OR COALESCE(v_acc."Practice Name", '') ILIKE '%clearchoice%'
     OR COALESCE(v_acc."Practice Name", '') ~ '^7[0-9]{3}' THEN
    v_sender := 'clearchoice@skdla.com';
  ELSE
    v_sender := 'implants@skdla.com';
  END IF;

  v_ctx := jsonb_build_object(
    'greeting',      v_greeting,
    'dr_first_name', COALESCE(v_acc."First Name", ''),
    'dr_last_name',  COALESCE(v_acc."Last Name", v_acc."Practice Name", ''),
    'dr_pref',       COALESCE(v_acc."Dr Pref", 'Dr.'),
    'practice_name', COALESCE(v_acc."Practice Name", ''),
    'signature',     'Spectrum Killian<br/><a href="mailto:' || v_sender || '">' || v_sender || '</a>'
  );

  v_subject := strip_special_dashes(render_template(v_tpl.subject,   v_ctx));
  v_body    := strip_special_dashes(render_template(v_tpl.body_html, v_ctx));

  -- Open a CLOSED case-less queue row for this ack. It must NOT be 'open', or
  -- pick_due_for_send() (which selects open queues with no active attempt) would
  -- re-pick it on a later dr-outreach-tick and compose/send follow-ups — we want a
  -- one-shot acknowledgment. 'closed' is terminal; the send path reads the attempt
  -- directly by status='queued', so a closed queue does not block the send.
  INSERT INTO dr_outreach_queue (
    case_number, account_number, reason, status, attempt_count, next_followup_at, notes
  ) VALUES (
    NULL, v_account, 'scan_submission_ack', 'closed', 0, now(),
    'Auto scan-submission ack for reply ' || p_reply_id::text
  )
  RETURNING id INTO v_queue_id;

  -- Compose the pending draft, addressed to the doctor who emailed in the scan.
  INSERT INTO dr_outreach_attempts (
    queue_id, attempt_number, template_id, to_email, subject, body_html, status, sender_mailbox
  ) VALUES (
    v_queue_id, 1, v_tpl.id, v_reply.from_email, v_subject, v_body,
    'pending_approval'::attempt_status, v_sender
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END $function$;
