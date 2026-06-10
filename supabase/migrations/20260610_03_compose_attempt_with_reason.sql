-- Compose a Pending Outbound draft from an EXPLICIT template reason, decoupled from the
-- queue's own reason. Used by the Pending Classification buttons (Approved / Approved+Mods /
-- Modification) to drop a ready-to-review email draft into Pending Outbound.
--
-- compose_attempt_with_reason() is a near-exact clone of compose_pending_attempt(), with two
-- differences:
--   * the template is looked up by (p_reason, p_tpl_attempt_number) instead of the queue's reason
--   * the inserted attempt row's attempt_number is p_row_attempt_number (the next free slot on
--     the queue), so it never collides with prior real outreach attempts.
-- All recipient/greeting/context/render logic is identical to compose_pending_attempt.
CREATE OR REPLACE FUNCTION public.compose_attempt_with_reason(
  p_queue_id uuid,
  p_row_attempt_number integer,
  p_reason text,
  p_tpl_attempt_number integer
)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_q             dr_outreach_queue;
  v_tpl           dr_outreach_templates;
  v_acc           RECORD;
  v_case          RECORD;
  v_exocad        TEXT;
  v_provider      TEXT;
  v_provider_last TEXT;
  v_greeting      TEXT;
  v_is_clearchoice BOOLEAN;
  v_rx_html       TEXT;
  v_missing_html  TEXT;
  v_issue_summary TEXT;
  v_patient_name  TEXT;
  v_patient_hash  TEXT;
  v_ctx           JSONB;
  v_recipient     TEXT;
  v_subject       TEXT;
  v_body          TEXT;
  v_attempt       dr_outreach_attempts;
  v_exocad_block  TEXT;
  v_due           date;
  v_approve_by    date;
  v_arrival_now   date;
  v_timeline_msg  TEXT;
  v_sender        text;
BEGIN
  SELECT * INTO v_q FROM dr_outreach_queue WHERE id = p_queue_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'queue % not found', p_queue_id; END IF;

  -- reason is the outreach_reason enum; cast the text param so the comparison resolves.
  SELECT * INTO v_tpl FROM dr_outreach_templates
  WHERE reason = p_reason::outreach_reason AND attempt_number = p_tpl_attempt_number;
  IF NOT FOUND THEN RAISE EXCEPTION 'template %/% not found', p_reason, p_tpl_attempt_number; END IF;

  SELECT * INTO v_acc  FROM "Accounts" WHERE "Account Number" = v_q.account_number;
  SELECT * INTO v_case FROM "Cases"    WHERE "Case Number"    = v_q.case_number;
  SELECT viewer_url INTO v_exocad FROM case_exocad_links WHERE case_number = v_q.case_number;

  v_is_clearchoice := COALESCE(v_acc."Practice Name", '') ILIKE '%clearchoice%'
                   OR COALESCE(v_acc."Strategic Partner", '') ILIKE '%clearchoice%';

  v_provider := get_case_provider(v_q.case_number);
  IF v_provider IS NOT NULL THEN
    v_provider_last := (regexp_match(v_provider, '(\S+)\s*$'))[1];
  END IF;

  IF v_provider_last IS NOT NULL THEN
    v_greeting := 'Hello Dr. ' || v_provider_last;
  ELSIF v_is_clearchoice THEN
    v_greeting := 'Hi ' || v_acc."Practice Name" || ' team';
  ELSIF v_acc."Last Name" IS NOT NULL
        AND v_acc."Last Name" !~ '^\d'
        AND v_acc."Last Name" NOT ILIKE '%onboarded%'
        AND v_acc."Last Name" NOT ILIKE '%clearchoice%'
        AND v_acc."Last Name" NOT ILIKE '%aspen%'
        AND v_acc."Last Name" NOT ILIKE '%incisive%'
        AND LENGTH(v_acc."Last Name") < 40 THEN
    v_greeting := 'Hello Dr. ' || v_acc."Last Name";
  ELSE
    v_greeting := 'Hi ' || COALESCE(v_acc."Practice Name", 'team') || ' team';
  END IF;

  v_patient_name := NULLIF(TRIM(v_case."Patient First Name" || ' ' || v_case."Patient Last Name"), '');
  IF v_is_clearchoice AND v_patient_name IS NOT NULL THEN
    v_patient_hash := (regexp_match(v_patient_name, '([A-Z0-9]{3,5}-[A-Z0-9]{3,5})\s*$'))[1];
    IF v_patient_hash IS NOT NULL THEN v_patient_name := v_patient_hash; END IF;
  END IF;
  v_patient_name := COALESCE(v_patient_name, 'your patient');

  v_exocad_block := CASE
    WHEN v_exocad IS NOT NULL THEN
      '<p style="margin:14px 0;"><a href="' || v_exocad || '" style="display:inline-block;background:#2A7FB8;color:#ffffff;padding:11px 24px;border-radius:4px;text-decoration:none;font-weight:bold;letter-spacing:1px;">View Design in exocad WebView</a></p>'
      || '<p style="font-size:11px;color:#64748B;margin-top:-8px;">Direct link: <a href="' || v_exocad || '">' || v_exocad || '</a></p>'
    ELSE ''
  END;

  v_rx_html      := format_rx_bullets(v_q.case_number);
  v_missing_html := format_missing_info_details(v_q.case_number, v_case."Hold Reason");

  SELECT COALESCE(
    (SELECT issue_summary_short FROM case_missing_info_summaries WHERE case_number = v_q.case_number),
    (SELECT issue_summary_short FROM case_rx_summaries           WHERE case_number = v_q.case_number),
    v_case."Hold Reason"
  ) INTO v_issue_summary;

  v_due := v_case."Doctor Due Date"::date;
  IF v_due IS NOT NULL THEN
    v_approve_by  := compute_approval_by_date(v_due, 5, 2);
    v_arrival_now := project_arrival_date(now(), 5, 2);
    IF v_approve_by >= CURRENT_DATE THEN
      v_timeline_msg :=
        '<p>To deliver by your requested due date of <strong>' || TO_CHAR(v_due, 'MM/DD/YYYY') ||
        '</strong>, we need your approval by <strong>' || TO_CHAR(v_approve_by, 'MM/DD/YYYY') || '</strong>. ' ||
        'After approval, please allow 5 business days for manufacturing and 2 business days for shipping (7 business days total).</p>';
    ELSE
      v_timeline_msg :=
        '<p>Your requested due date of <strong>' || TO_CHAR(v_due, 'MM/DD/YYYY') ||
        '</strong> has passed for our standard turnaround. If we receive your approval today, the case is ' ||
        'estimated to arrive at your office on <strong>' || TO_CHAR(v_arrival_now, 'MM/DD/YYYY') ||
        '</strong> (5 business days manufacturing + 2 business days shipping).</p>';
    END IF;
  ELSE
    v_timeline_msg :=
      '<p>After your approval, please allow 5 business days for manufacturing and 2 business days for shipping (7 business days total).</p>';
  END IF;

  -- Route to the right shared mailbox based on the case's strategic partner
  v_sender := pick_sender_mailbox(v_q.case_number);

  v_ctx := jsonb_build_object(
    'greeting',                v_greeting,
    'dr_last_name',            COALESCE(v_provider_last, v_acc."Last Name", v_acc."Practice Name", ''),
    'dr_first_name',           COALESCE(v_acc."First Name", ''),
    'dr_pref',                 COALESCE(v_acc."Dr Pref", 'Dr.'),
    'practice_name',           COALESCE(v_acc."Practice Name", ''),
    'patient_name',            v_patient_name,
    'doctor_due_date',         COALESCE(TO_CHAR(v_due, 'MM/DD/YYYY'), 'TBD'),
    'approval_by_date',        COALESCE(TO_CHAR(v_approve_by, 'MM/DD/YYYY'), 'TBD'),
    'arrival_if_approved_now', COALESCE(TO_CHAR(v_arrival_now, 'MM/DD/YYYY'), 'TBD'),
    'timeline_block',          v_timeline_msg,
    'hold_reason',             COALESCE(v_case."Hold Reason", ''),
    'case_number',             v_q.case_number,
    'current_step',            COALESCE(v_case."Current Step", ''),
    'account_manager',         COALESCE(v_acc."Account Manager", 'your account manager'),
    'exocad_link',             v_exocad_block,
    'rx_bullets',              v_rx_html,
    'missing_details',         v_missing_html,
    'issue_summary',           COALESCE(v_issue_summary, 'Action needed'),
    'signature',               'Spectrum Killian<br/><a href="mailto:' || v_sender || '">' || v_sender || '</a>'
  );

  v_recipient := CASE WHEN v_tpl.is_escalation THEN v_acc."Account Manager" ELSE v_acc."Primary Email" END;
  v_subject := render_template(v_tpl.subject, v_ctx);
  v_body    := render_template(v_tpl.body_html, v_ctx);
  v_subject := strip_special_dashes(v_subject);
  v_body    := strip_special_dashes(v_body);

  INSERT INTO dr_outreach_attempts (
    queue_id, attempt_number, template_id, to_email, subject, body_html, status, sender_mailbox
  ) VALUES (
    p_queue_id, p_row_attempt_number, v_tpl.id, v_recipient, v_subject, v_body,
    'pending_approval'::attempt_status, v_sender
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END $function$;

-- Drop a single ready-to-review draft into Pending Outbound for a just-classified reply.
-- Picks the next free attempt slot on the reply's queue and renders the base (attempt 1)
-- template for the given reason. No-ops when the reply has no linked queue, or when a
-- pending_approval draft already exists for that queue (so repeated clicks don't pile up drafts).
CREATE OR REPLACE FUNCTION public.compose_classification_draft(
  p_reply_id uuid,
  p_reason text
)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_queue_id uuid;
  v_next     integer;
  v_attempt  dr_outreach_attempts;
BEGIN
  SELECT queue_id INTO v_queue_id FROM dr_outreach_replies WHERE id = p_reply_id;
  IF v_queue_id IS NULL THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1 FROM dr_outreach_attempts
    WHERE queue_id = v_queue_id AND status = 'pending_approval'::attempt_status
  ) THEN
    RETURN NULL;  -- a draft is already waiting for review; don't create a duplicate
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM dr_outreach_attempts WHERE queue_id = v_queue_id;

  v_attempt := compose_attempt_with_reason(v_queue_id, v_next, p_reason, 1);
  RETURN v_attempt;
END $function$;
