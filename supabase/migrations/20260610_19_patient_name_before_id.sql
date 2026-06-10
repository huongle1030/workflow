-- Show the patient's name before the unique ID in outreach emails, instead of the ID alone.
--
-- For ClearChoice the patient is redacted at source: "Patient First Name" holds a partial name and
-- "Patient Last Name" holds the unique ID. Emails previously showed the ID only (the hash). Now they
-- show "name - id" (name before id). Non-ClearChoice cases keep their full "First Last" name.
-- (compose runs strip_special_dashes() on the rendered email, so the en-dash below renders as a
-- plain hyphen in the sent email — a clean "name - id" separator either way.)
--
-- Centralized in patient_display_name() so both composers stay in sync. The match_*_to_case
-- functions intentionally keep using the raw hash for case-matching and are NOT touched.

CREATE OR REPLACE FUNCTION public.patient_display_name(p_first text, p_last text, p_is_clearchoice boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    CASE
      WHEN p_is_clearchoice THEN
        CASE
          WHEN NULLIF(TRIM(p_first), '') IS NOT NULL AND NULLIF(TRIM(p_last), '') IS NOT NULL
            THEN TRIM(p_first) || ' – ' || TRIM(p_last)
          ELSE COALESCE(NULLIF(TRIM(p_last), ''), NULLIF(TRIM(p_first), ''))
        END
      ELSE NULLIF(TRIM(COALESCE(p_first, '') || ' ' || COALESCE(p_last, '')), '')
    END,
    'your patient');
$$;

GRANT EXECUTE ON FUNCTION public.patient_display_name(text, text, boolean) TO anon, authenticated, service_role;

-- compose_attempt_with_reason: explicit-reason composer (classification / recompose / Select-draft /
-- the cron default, via the wrapper below). patient_name now goes through patient_display_name;
-- everything else is unchanged from migration 20260610_03.
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

  v_patient_name := patient_display_name(v_case."Patient First Name", v_case."Patient Last Name", v_is_clearchoice);

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

-- compose_pending_attempt is now a thin wrapper: composing the queue's own reason at attempt N is
-- identical to compose_attempt_with_reason(queue, N, reason, N). One source of truth, so the
-- patient-name (and all future) logic never diverges between the two.
CREATE OR REPLACE FUNCTION public.compose_pending_attempt(p_queue_id uuid, p_attempt_number integer)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_reason outreach_reason;
BEGIN
  SELECT reason INTO v_reason FROM dr_outreach_queue WHERE id = p_queue_id;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'queue % not found', p_queue_id; END IF;
  RETURN compose_attempt_with_reason(p_queue_id, p_attempt_number, v_reason::text, p_attempt_number);
END $function$;
