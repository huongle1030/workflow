-- Scan Submission tab: pre-populate the ack template ONLY for @aspendental.com senders.
--
-- Product decision: in the Scan Submission sub-tab, only doctors whose email ends in
-- @aspendental.com should get the auto-filled Aspen Labs ack template. Every other scan
-- submission (Aspen ClearChoice, @clearchoice.com, unknown senders, etc.) should still
-- SHOW UP in the tab, but as a BLANK draft the coordinator writes and sends themselves.
--
-- Three changes here:
--   1. compose_scan_ack(): template only when the sender domain is aspendental.com; else
--      insert a blank (subject='', body_html='', template_id=NULL) pending draft.
--   2. Backfill: clear the template off existing non-@aspendental.com scan-ack drafts that
--      are still awaiting approval, so the tab is consistent with the new rule immediately.
--   3. v_pending_outbound_triage: expose the originating scan-submission email
--      (dr_outreach_replies, joined on scan_ack_attempt_id) so the card can render a
--      "Scan Submission Email" panel like the Most Recent Communication card.
--
-- The Aspen Labs job-aid PDF attachment is gated to @aspendental.com sends in the two
-- senders (send-attempt + dr-outreach-tick edge functions), not here.

-- 1) ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compose_scan_ack(p_reply_id uuid)
RETURNS dr_outreach_attempts
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reply    dr_outreach_replies;
  v_acc      RECORD;
  v_account  TEXT;
  v_domain   TEXT;
  v_is_aspen BOOLEAN;
  v_tpl      dr_outreach_templates;
  v_tpl_id   UUID;
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

  -- Optional account resolution (used only for a nicer greeting + mailbox routing).
  SELECT * INTO v_acc FROM "Accounts"
   WHERE "Primary Email" ILIKE v_reply.from_email
   LIMIT 1;
  v_account := v_acc."Account Number";   -- NULL when no account matched
  v_domain  := lower(split_part(v_reply.from_email, '@', 2));

  -- ONLY @aspendental.com senders get the pre-populated template. Aspen ClearChoice,
  -- @clearchoice.com, and everyone else fall through to a blank draft.
  v_is_aspen := (v_domain = 'aspendental.com');

  -- From mailbox routing applies to both branches: clearchoice domain/account -> clearchoice@,
  -- else implants@.
  IF v_domain LIKE '%clearchoice%'
     OR COALESCE(v_acc."Strategic Partner", '') ILIKE '%clearchoice%'
     OR COALESCE(v_acc."Practice Name", '') ILIKE '%clearchoice%'
     OR COALESCE(v_acc."Practice Name", '') ~ '^7[0-9]{3}' THEN
    v_sender := 'clearchoice@skdla.com';
  ELSE
    v_sender := 'implants@skdla.com';
  END IF;

  IF v_is_aspen THEN
    SELECT * INTO v_tpl FROM dr_outreach_templates
     WHERE reason = 'scan_submission_ack' AND attempt_number = 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'scan_submission_ack/1 template not found (run _02)'; END IF;
    v_tpl_id := v_tpl.id;

    -- Greeting: prefer a real provider-ish account last name, else practice, else generic.
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
  ELSE
    -- Non-Aspen: blank draft. Coordinator writes the email themselves in the card.
    v_tpl_id  := NULL;
    v_subject := '';
    v_body    := '';
  END IF;

  -- CLOSED case-less queue row (terminal -> pick_due_for_send never re-picks it for follow-ups).
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
    v_queue_id, 1, v_tpl_id, v_reply.from_email, v_subject, v_body,
    'pending_approval'::attempt_status, v_sender
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END $function$;

-- 2) ---------------------------------------------------------------------------------------
-- Clear the template off existing non-@aspendental.com scan-ack drafts still awaiting review.
UPDATE public.dr_outreach_attempts a
SET subject = '', body_html = '', template_id = NULL
FROM public.dr_outreach_queue q
WHERE a.queue_id = q.id
  AND q.reason = 'scan_submission_ack'::outreach_reason
  AND a.status = 'pending_approval'
  AND lower(a.to_email) NOT LIKE '%@aspendental.com';

-- 3) ---------------------------------------------------------------------------------------
-- Re-create v_pending_outbound_triage adding the originating scan-submission email fields.
-- Identical to 20260605_01 except for the trailing scanr LATERAL + four scan_reply_* columns
-- appended at the end (CREATE OR REPLACE requires existing columns/order unchanged).
CREATE OR REPLACE VIEW public.v_pending_outbound_triage AS
 SELECT po.attempt_id,
    po.queue_id,
    po.attempt_number,
    po.proposed_at,
    po.to_email,
    po.subject,
    po.body_html,
    po.case_number,
    po.pan_number,
    po.account_number,
    po.reason,
    po.dr_first_name,
    po.dr_last_name,
    po.dr_pref,
    po.practice_name,
    po.account_manager,
    po.hold_reason,
    po.current_step,
    po.doctor_due_date,
    po.patient_name,
    po.exocad_viewer_url,
    po.last_activity_at,
    po.days_since_last_activity,
    po.recent_doctor_reply,
    po.replies_14d,
    po.notes_14d,
    po.sends_14d,
    po.issue_summary,
    po.projected_ship_date,
    po.doctor_due_date_only,
    po.days_late_if_approved_now,
    po.will_miss_due_date,
    po.account_preferences,
    po.prefs_auto,
    po.prefs_summary_headline,
    po.prefs_summary_detail,
    po.case_revenue,
    po.strategic_partner,
    po.last_outreach_note_at,
    po.outreach_note_count,
    po.most_recent_outreach_note,
    po.most_recent_outreach_author,
    tri.evidence_at,
    tri.evidence_kind,
        CASE
            WHEN po.reason = 'scan_submission_ack' THEN 'outbound_only'::text
            ELSE 'pending_approval'::text
        END AS triage_bucket,
    lc.occurred_at AS most_recent_comm_at,
    lc.medium AS most_recent_comm_medium,
    lc.direction AS most_recent_comm_direction,
    lc.source_type AS most_recent_comm_source_type,
    lc.subject AS most_recent_comm_subject,
    lc.body_text AS most_recent_comm_body,
    lc.actor AS most_recent_comm_actor,
    lc.counterparty AS most_recent_comm_counterparty,
    lr.cc_recipients AS most_recent_comm_cc,
    lr.received_at AS most_recent_comm_cc_at,
    scanr.from_email AS scan_reply_from,
    scanr.subject AS scan_reply_subject,
    scanr.body_text AS scan_reply_body,
    scanr.received_at AS scan_reply_at
   FROM v_pending_outbound po
     CROSS JOIN LATERAL ( SELECT count(*) AS comm_count,
            max(cc.occurred_at) AS evidence_at,
            (array_agg(cc.channel_source ORDER BY cc.occurred_at DESC))[1] AS evidence_kind
           FROM case_communications cc
          WHERE cc.case_number = po.case_number) tri
     LEFT JOIN LATERAL ( SELECT cc.occurred_at,
            cc.medium,
            cc.direction,
            cc.source_type,
            cc.subject,
            cc.body_text,
            cc.actor,
            cc.counterparty
           FROM case_communications cc
          WHERE cc.case_number = po.case_number
          ORDER BY cc.occurred_at DESC
          LIMIT 1) lc ON true
     LEFT JOIN LATERAL ( SELECT r2.cc_recipients,
            r2.received_at
           FROM dr_outreach_replies r2
             LEFT JOIN dr_outreach_queue q2 ON q2.id = r2.queue_id
          WHERE COALESCE(r2.case_number, q2.case_number) = po.case_number
            AND r2.cc_recipients IS NOT NULL
            AND array_length(r2.cc_recipients, 1) > 0
          ORDER BY r2.received_at DESC
          LIMIT 1) lr ON true
     LEFT JOIN LATERAL ( SELECT sr.from_email,
            sr.subject,
            sr.body_text,
            sr.received_at
           FROM dr_outreach_replies sr
          WHERE sr.scan_ack_attempt_id = po.attempt_id
          ORDER BY sr.received_at DESC
          LIMIT 1) scanr ON true;
