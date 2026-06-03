-- Auto-reply for inbound iOS-scan submissions — Part 8.
--
-- Supersedes the Part 4 compose_scan_ack: the account is now OPTIONAL (we still draft
-- when the sender isn't in Accounts) and the From mailbox is routed by the sender's
-- email domain first (clearchoice.com -> clearchoice@skdla.com, else implants@skdla.com),
-- which best reflects "where the doctor emailed". Greeting falls back to a generic
-- "Hello Doctor" when no account / usable name is known. Queue row is created CLOSED so
-- pick_due_for_send() never re-picks it for follow-ups (one-shot ack).
CREATE OR REPLACE FUNCTION public.compose_scan_ack(p_reply_id uuid)
RETURNS dr_outreach_attempts
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reply    dr_outreach_replies;
  v_acc      RECORD;
  v_account  TEXT;
  v_domain   TEXT;
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

  -- Optional account resolution (nicer greeting + mailbox hint). May find nothing.
  SELECT * INTO v_acc FROM "Accounts"
   WHERE "Primary Email" ILIKE v_reply.from_email
   LIMIT 1;
  v_account := v_acc."Account Number";   -- NULL when no account matched
  v_domain  := lower(split_part(v_reply.from_email, '@', 2));

  SELECT * INTO v_tpl FROM dr_outreach_templates
   WHERE reason = 'scan_submission_ack' AND attempt_number = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'scan_submission_ack/1 template not found (run _02)'; END IF;

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

  IF v_domain LIKE '%clearchoice%'
     OR COALESCE(v_acc."Strategic Partner", '') ILIKE '%clearchoice%'
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

  INSERT INTO dr_outreach_queue (
    case_number, account_number, reason, status, attempt_count, next_followup_at, notes
  ) VALUES (
    NULL, v_account, 'scan_submission_ack', 'closed', 0, now(),
    'Auto scan-submission ack for reply ' || p_reply_id::text
  )
  RETURNING id INTO v_queue_id;

  INSERT INTO dr_outreach_attempts (
    queue_id, attempt_number, template_id, to_email, subject, body_html, status, sender_mailbox
  ) VALUES (
    v_queue_id, 1, v_tpl.id, v_reply.from_email, v_subject, v_body,
    'pending_approval'::attempt_status, v_sender
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END $function$;