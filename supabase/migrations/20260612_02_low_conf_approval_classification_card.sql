-- Close the low-confidence AI-approval gap: surface it in Pending Classification.
--
-- When parse-case-comms decides a case is design-APPROVED but at <= 0.95 confidence (below the
-- auto-route threshold) and there is no inbound doctor reply, the case used to silently drop out of
-- Pending Outbound (show_in_pending_outbound=false) without landing in Pending Classification or
-- Ready-for-ABS. This adds a synthetic dr_outreach_replies "card" so a coordinator can confirm it;
-- confirming runs the normal confirm_reply path (-> thank-you draft -> Ready for ABS via the
-- reply_approved source). The card is keyed match_method='ai_parse' so the rest of the pipeline can
-- tell it apart from real doctor replies.
--
-- Touches 4 functions:
--   1. ensure_low_conf_classification_card(case)  - NEW: upsert/retract the synthetic card.
--   2. apply_case_parse_result                    - call (1) after each parse (best-effort).
--   3. sync_case_communications                   - DO NOT mirror ai_parse cards into the timeline
--                                                   (avoids fake doctor emails + a parser feedback loop).
--   4. pick_replies_to_resolve                    - DO NOT auto-resolve ai_parse cards (only a human
--                                                   or (1)'s own retraction clears them).

-- ---------------------------------------------------------------------------------------------------
-- 1. The upsert/retract helper.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_low_conf_classification_card(p_case_number text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_state    text;
  v_conf     numeric;
  v_eligible boolean;
  v_aiclass  text;
  v_summary  text;
  v_queue    uuid;
  v_acct     text;
  v_email    text;
  v_syn      uuid;
  v_norm     text := regexp_replace(btrim(p_case_number), '^\s*(\d{3,4})-+0*(\d+)\s*$', '\1-\2');
BEGIN
  SELECT approval_state, approval_confidence INTO v_state, v_conf
  FROM case_parse_state WHERE case_number = p_case_number;

  -- Eligible = a low-confidence approval still sitting at the Full-Arch doctor-design-approval step,
  -- not already approved through a human / ABS / reply source.
  v_eligible :=
       v_state IN ('approved','approved_small_fix_no_resend','in_production')
   AND COALESCE(v_conf, 0) <= 0.95
   AND EXISTS (SELECT 1 FROM "Cases" c
               WHERE c."Case Number" = p_case_number
                 AND c."Current Step" = 'Doctor Design Approval - Full Arch'
                 AND c."Case Status" IN ('WIP','Hold'))
   AND NOT EXISTS (SELECT 1 FROM v_combined_approved_cases v WHERE v.case_number = v_norm);

  -- Our own synthetic card for this case, if one is still pending.
  SELECT id INTO v_syn
  FROM dr_outreach_replies
  WHERE case_number = p_case_number AND match_method = 'ai_parse'
    AND decided_at IS NULL AND resolve_state IS DISTINCT FROM 'resolved'
  ORDER BY received_at DESC LIMIT 1;

  -- Not eligible any more (human-approved, re-opened, left scope, confidence climbed) -> retract ours.
  IF NOT v_eligible THEN
    IF v_syn IS NOT NULL THEN
      UPDATE dr_outreach_replies
      SET resolve_state='resolved',
          resolve_reason='ai_parse card retracted: no longer a low-confidence approval in design-approval scope',
          resolve_checked_at=now()
      WHERE id = v_syn;
    END IF;
    RETURN false;
  END IF;

  -- A real inbound reply is already pending for this case -> it is already in Pending Classification;
  -- nothing to add, and retract our synthetic one so there is no duplicate card.
  IF EXISTS (
    SELECT 1 FROM dr_outreach_replies r
    WHERE r.case_number = p_case_number
      AND COALESCE(r.match_method,'') <> 'ai_parse'
      AND r.decided_at IS NULL AND r.resolve_state IS DISTINCT FROM 'resolved'
      AND lower(COALESCE(r.from_email,'')) NOT LIKE '%@skdla.com'
  ) THEN
    IF v_syn IS NOT NULL THEN
      UPDATE dr_outreach_replies
      SET resolve_state='resolved',
          resolve_reason='ai_parse card retracted: a real inbound reply is already pending classification',
          resolve_checked_at=now()
      WHERE id = v_syn;
    END IF;
    RETURN false;
  END IF;

  v_aiclass := CASE WHEN v_state='approved_small_fix_no_resend' THEN 'approved_with_mods' ELSE 'approved' END;
  v_summary := 'AI parsed this case as DESIGN APPROVED at ' || ROUND(COALESCE(v_conf,0)*100)
            || '% confidence — below the 95% auto-route threshold, so a coordinator must confirm it '
            || 'before it moves to Ready for ABS scan.';

  -- Refresh an existing synthetic card in place (idempotent across re-parses).
  IF v_syn IS NOT NULL THEN
    UPDATE dr_outreach_replies
    SET ai_classification=v_aiclass, ai_confidence=v_conf, ai_summary=v_summary, body_text=v_summary
    WHERE id = v_syn;
    RETURN true;
  END IF;

  -- Otherwise create one. Attach the case's existing outreach queue (if any) so confirm_reply can
  -- compose the thank-you; a NULL queue is fine (confirm_reply still records the approval, which
  -- routes the case to Ready for ABS via the reply_approved source). We deliberately do NOT create a
  -- new open queue here — that could kick off chase emails on a case we believe is already approved.
  SELECT id, account_number INTO v_queue, v_acct
  FROM dr_outreach_queue WHERE case_number = p_case_number
  ORDER BY (reason='design_approval'::outreach_reason) DESC, created_at DESC LIMIT 1;

  IF v_acct IS NULL THEN
    SELECT "Account Number" INTO v_acct FROM "Cases" WHERE "Case Number"=p_case_number LIMIT 1;
  END IF;

  SELECT a."Primary Email" INTO v_email FROM "Accounts" a WHERE a."Account Number" = v_acct;

  INSERT INTO dr_outreach_replies (
    queue_id, case_number, from_email, subject, body_text,
    ai_classification, ai_confidence, ai_summary, match_method, match_confidence, received_at
  ) VALUES (
    v_queue, p_case_number,
    COALESCE(NULLIF(v_email,''), 'ai-parse@noreply.invalid'),
    'AI-detected design approval — needs confirmation',
    v_summary, v_aiclass, v_conf, v_summary, 'ai_parse', 1, now()
  );
  RETURN true;
END $fn$;

GRANT EXECUTE ON FUNCTION public.ensure_low_conf_classification_card(text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 2. Call the helper from the parse-apply path (best-effort, never fails the parse).
--    Body identical to the live apply_case_parse_result + the new PERFORM block.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_case_parse_result(p_case_number text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempts   jsonb := COALESCE(p_result->'per_reason_attempts', '{}'::jsonb);
  v_reason     text  := NULLIF(p_result->>'most_recent_unapproved_reason', '');
  v_reason_enum outreach_reason;
  v_da int := COALESCE((v_attempts->>'design_approval')::int, 0);
  v_dm int := COALESCE((v_attempts->>'design_modification')::int, (p_result->>'modification_count')::int, 0);
  v_mi int := COALESCE((v_attempts->>'missing_info')::int, 0);
  v_wp int := COALESCE((v_attempts->>'waiting_on_parts')::int, 0);
  v_la int := COALESCE((v_attempts->>'late_approval_notice')::int, 0);
  v_rc int := COALESCE((v_attempts->>'reschedule_check')::int, 0);
  v_sa int := COALESCE((v_attempts->>'scan_submission_ack')::int, 0);
  v_show  boolean := COALESCE((p_result->>'show_in_pending_outbound')::boolean, true);
  v_init  boolean := COALESCE((p_result->>'initial_design_in_progress')::boolean, false);
  v_state text := NULLIF(p_result->>'approval_state', '');
  v_model text := NULLIF(p_result->>'model', '');
  v_comm  int  := NULLIF(p_result->>'comm_count', '')::int;
  v_last  timestamptz := NULLIF(p_result->>'last_comm_at', '')::timestamptz;
  v_conf  numeric := NULLIF(p_result->>'approval_confidence', '')::numeric;
BEGIN
  IF v_reason IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'outreach_reason' AND e.enumlabel = v_reason
  ) THEN
    v_reason_enum := v_reason::outreach_reason;
  ELSE
    v_reason_enum := NULL;
  END IF;

  INSERT INTO public.case_parse_state AS s (
    case_number, approval_state, show_in_pending_outbound, most_recent_unapproved_reason,
    initial_design_in_progress, design_approval_attempt_count, design_modification_count,
    missing_info, waiting_on_parts, late_approval_notice, reschedule_check, scan_submission_ack,
    evidence, model, comm_count, last_comm_at, approval_confidence, parsed_at, updated_at
  ) VALUES (
    p_case_number, v_state, v_show, v_reason_enum,
    v_init, v_da, v_dm, v_mi, v_wp, v_la, v_rc, v_sa,
    p_result->'evidence', v_model, v_comm, v_last, v_conf, now(), now()
  )
  ON CONFLICT (case_number) DO UPDATE SET
    approval_state                = EXCLUDED.approval_state,
    show_in_pending_outbound      = EXCLUDED.show_in_pending_outbound,
    most_recent_unapproved_reason = EXCLUDED.most_recent_unapproved_reason,
    initial_design_in_progress    = EXCLUDED.initial_design_in_progress,
    design_approval_attempt_count = EXCLUDED.design_approval_attempt_count,
    design_modification_count     = EXCLUDED.design_modification_count,
    missing_info                  = EXCLUDED.missing_info,
    waiting_on_parts              = EXCLUDED.waiting_on_parts,
    late_approval_notice          = EXCLUDED.late_approval_notice,
    reschedule_check              = EXCLUDED.reschedule_check,
    scan_submission_ack           = EXCLUDED.scan_submission_ack,
    evidence                      = EXCLUDED.evidence,
    model                         = EXCLUDED.model,
    comm_count                    = EXCLUDED.comm_count,
    last_comm_at                  = EXCLUDED.last_comm_at,
    approval_confidence           = EXCLUDED.approval_confidence,
    parsed_at                     = EXCLUDED.parsed_at,
    updated_at                    = now();

  INSERT INTO public.case_parse_audit (
    case_number, model, approval_state, show_in_pending_outbound, most_recent_unapproved_reason,
    initial_design_in_progress, per_reason_attempts, modification_count, comm_count, evidence, raw_response
  ) VALUES (
    p_case_number, v_model, v_state, v_show, v_reason,
    v_init, v_attempts, v_dm, v_comm, p_result->'evidence', p_result
  );

  UPDATE public.case_parse_queue
  SET status = 'done', last_error = NULL
  WHERE case_number = p_case_number;

  BEGIN
    PERFORM ensure_post_approval_confirmation(p_case_number);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Low-confidence approval (no auto-route) -> surface a card in Pending Classification.
  BEGIN
    PERFORM ensure_low_conf_classification_card(p_case_number);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 3. sync_case_communications: never mirror synthetic ai_parse cards into the timeline.
--    Body identical to live + one exclusion line in SOURCE 2's candidate CTE.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_case_communications(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempts int := 0;
  v_replies  int := 0;
  v_notes    int := 0;
BEGIN
  -- =====================================================================
  -- SOURCE 1 -- Attempts -> outbound system email (status = 'sent')
  -- =====================================================================
  WITH cand AS (
    SELECT att.*, q.case_number AS q_case, q.account_number AS q_account,
           row_number() OVER (PARTITION BY att.graph_message_id
                              ORDER BY COALESCE(att.sent_at, att.created_at), att.id) AS rn
    FROM dr_outreach_attempts att
    JOIN dr_outreach_queue q ON q.id = att.queue_id
    WHERE att.status = 'sent'::attempt_status
      AND (p_since IS NULL OR COALESCE(att.sent_at, att.created_at) >= p_since)
  )
  INSERT INTO case_communications (
    case_number, account_number, occurred_at, direction, medium, channel_source,
    cc_compliant, from_addr, to_addr, counterparty, actor, subject, body_text,
    classification, classification_confidence, classified_by, needs_ai,
    source_type, source_id, graph_message_id, updated_at)
  SELECT
    c.q_case, c.q_account, COALESCE(c.sent_at, c.created_at),
    'outbound', 'email', 'system_email', true,
    c.sender_mailbox, c.to_email, c.to_email,
    COALESCE(c.reviewer_id, c.sender_mailbox),
    COALESCE(c.edited_subject, c.subject),
    LEFT(COALESCE(c.edited_body_html, c.body_html), 8000),
    NULL, NULL, 'source', false,
    'attempt', c.id::text, c.graph_message_id, now()
  FROM cand c
  WHERE (c.graph_message_id IS NULL OR c.rn = 1)
    AND NOT EXISTS (
      SELECT 1 FROM case_communications cc
      WHERE cc.graph_message_id = c.graph_message_id
        AND cc.graph_message_id IS NOT NULL
        AND NOT (cc.source_type = 'attempt' AND cc.source_id = c.id::text))
  ON CONFLICT (source_type, source_id) DO UPDATE SET
    case_number = EXCLUDED.case_number, account_number = EXCLUDED.account_number,
    occurred_at = EXCLUDED.occurred_at, from_addr = EXCLUDED.from_addr,
    to_addr = EXCLUDED.to_addr, counterparty = EXCLUDED.counterparty,
    actor = EXCLUDED.actor, subject = EXCLUDED.subject, body_text = EXCLUDED.body_text,
    graph_message_id = EXCLUDED.graph_message_id, updated_at = now();
  GET DIAGNOSTICS v_attempts = ROW_COUNT;

  -- =====================================================================
  -- SOURCE 2 -- Replies -> inbound shared-mailbox email
  -- =====================================================================
  WITH cand AS (
    SELECT r.*, q.account_number AS q_account, q.case_number AS q_case,
           row_number() OVER (PARTITION BY r.graph_message_id
                              ORDER BY r.received_at, r.id) AS rn
    FROM dr_outreach_replies r
    LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
    WHERE (p_since IS NULL OR r.received_at >= p_since)
      AND COALESCE(r.match_method,'') <> 'ai_parse'   -- never mirror synthetic AI-approval cards
  )
  INSERT INTO case_communications (
    case_number, account_number, occurred_at, direction, medium, channel_source,
    cc_compliant, from_addr, to_addr, counterparty, actor, subject, body_text,
    classification, classification_confidence, classified_by, needs_ai,
    source_type, source_id, graph_message_id, updated_at)
  SELECT
    COALESCE(c.case_number, c.q_case), c.q_account, c.received_at,
    'inbound', 'email', 'shared_mailbox_email', true,
    c.from_email, NULL, c.from_email, c.coordinator_id,
    c.subject, LEFT(COALESCE(c.body_text, c.body_html), 8000),
    COALESCE(c.coordinator_decision, c.ai_classification), c.ai_confidence,
    'source', false,
    'reply', c.id::text, c.graph_message_id, now()
  FROM cand c
  WHERE (c.graph_message_id IS NULL OR c.rn = 1)
    AND NOT EXISTS (
      SELECT 1 FROM case_communications cc
      WHERE cc.graph_message_id = c.graph_message_id
        AND cc.graph_message_id IS NOT NULL
        AND NOT (cc.source_type = 'reply' AND cc.source_id = c.id::text))
  ON CONFLICT (source_type, source_id) DO UPDATE SET
    case_number = EXCLUDED.case_number, account_number = EXCLUDED.account_number,
    occurred_at = EXCLUDED.occurred_at, from_addr = EXCLUDED.from_addr,
    counterparty = EXCLUDED.counterparty, actor = EXCLUDED.actor,
    subject = EXCLUDED.subject, body_text = EXCLUDED.body_text,
    classification = EXCLUDED.classification,
    classification_confidence = EXCLUDED.classification_confidence,
    graph_message_id = EXCLUDED.graph_message_id, updated_at = now();
  GET DIAGNOSTICS v_replies = ROW_COUNT;

  -- =====================================================================
  -- SOURCE 3 -- Case Notes -> phone / email / note (hybrid rules + cc_compliant)
  -- =====================================================================
  WITH classified AS (
    SELECT
      cn."Note Id"::text AS note_id,
      cn."Case Number" AS case_number,
      cn."Account Number" AS account_number,
      COALESCE(cn."Start Date",
               cn."Created Date" AT TIME ZONE 'America/Los_Angeles') AS occurred_at,
      cn."Note User Full Name" AS actor,
      cn."Subject" AS subject,
      LEFT(cn."Note Text", 8000) AS body_text,
      (COALESCE(cn."Subject",'') || ' ' || COALESCE(cn."Note Text",'')) AS combined,
      ((COALESCE(cn."Subject",'') || ' ' || COALESCE(cn."Note Text",''))
        ~* '(\mcalled\M)|(\mvoicemail\M)|(\mvm\M)|left\s+(a\s+)?(message|vm|voicemail)|spoke\s+(with|to)|\mphone\M|reached out by phone') AS is_phone,
      ((COALESCE(cn."Subject",'') || ' ' || COALESCE(cn."Note Text",''))
        ~* 'e-?mail|email sent|sent\s+(an?\s+)?e-?mail|int.?\s*design approval|approval\s+\d|redesign approval|reminder\s+\d'
        OR cn."Note Text" LIKE 'From:%') AS is_email,
      ((COALESCE(cn."Subject",'') || ' ' || COALESCE(cn."Note Text",''))
        ~* 'approv|contact|follow.?up|reach|confirm|spoke|advised|notif') AS is_ambiguous
    FROM "Case Notes" cn
    WHERE cn."Note Id" IS NOT NULL
      AND (p_since IS NULL
           OR COALESCE(cn."Start Date",
                       cn."Created Date" AT TIME ZONE 'America/Los_Angeles') >= p_since)
  ),
  resolved AS (
    SELECT c.*,
      CASE WHEN c.is_phone AND NOT c.is_email THEN 'phone'
           WHEN c.is_email AND NOT c.is_phone THEN 'email'
           ELSE 'note' END AS medium
    FROM classified c
  )
  INSERT INTO case_communications (
    case_number, account_number, occurred_at, direction, medium, channel_source,
    cc_compliant, from_addr, to_addr, counterparty, actor, subject, body_text,
    classification, classification_confidence, classified_by, needs_ai,
    related_message_id, source_type, source_id, updated_at)
  SELECT
    r.case_number, r.account_number, r.occurred_at,
    CASE r.medium
      WHEN 'phone' THEN (CASE WHEN r.combined ~* 'called|left|reached out|spoke' THEN 'outbound' ELSE 'internal' END)
      WHEN 'email' THEN (CASE WHEN r.combined ~* 'reply|response|received|wrote back|\mre:' THEN 'inbound' ELSE 'outbound' END)
      ELSE 'internal' END,
    r.medium,
    CASE r.medium
      WHEN 'phone' THEN 'phone_call'
      WHEN 'email' THEN (CASE WHEN mail.id IS NOT NULL THEN 'shared_mailbox_email' ELSE 'external_email' END)
      ELSE 'abs_note' END,
    CASE r.medium WHEN 'email' THEN (mail.id IS NOT NULL) ELSE NULL END,
    r.actor, NULL, NULL, r.actor, r.subject, r.body_text,
    NULL, NULL, 'rule',
    ((r.is_phone AND r.is_email) OR (NOT r.is_phone AND NOT r.is_email AND r.is_ambiguous)),
    mail.graph_message_id,
    'case_note', r.note_id, now()
  FROM resolved r
  LEFT JOIN LATERAL (
    SELECT cc2.id, cc2.graph_message_id
    FROM case_communications cc2
    WHERE cc2.case_number = r.case_number AND cc2.case_number IS NOT NULL
      AND cc2.channel_source IN ('shared_mailbox_email','system_email')
      AND cc2.occurred_at BETWEEN r.occurred_at - interval '3 days'
                              AND r.occurred_at + interval '3 days'
    ORDER BY abs(extract(epoch FROM (cc2.occurred_at - r.occurred_at)))
    LIMIT 1
  ) mail ON (r.medium = 'email')
  ON CONFLICT (source_type, source_id) DO UPDATE SET
    case_number = EXCLUDED.case_number, account_number = EXCLUDED.account_number,
    occurred_at = EXCLUDED.occurred_at, direction = EXCLUDED.direction,
    medium = EXCLUDED.medium, channel_source = EXCLUDED.channel_source,
    cc_compliant = EXCLUDED.cc_compliant, actor = EXCLUDED.actor,
    from_addr = EXCLUDED.from_addr, subject = EXCLUDED.subject,
    body_text = EXCLUDED.body_text, needs_ai = EXCLUDED.needs_ai,
    related_message_id = EXCLUDED.related_message_id,
    classified_by = CASE WHEN case_communications.classified_by = 'ai' THEN 'ai' ELSE 'rule' END,
    updated_at = now();
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  RETURN jsonb_build_object(
    'since', p_since,
    'attempts_upserted', v_attempts,
    'replies_upserted', v_replies,
    'notes_upserted', v_notes,
    'ran_at', now());
END $function$;

-- ---------------------------------------------------------------------------------------------------
-- 4. pick_replies_to_resolve: never auto-resolve synthetic ai_parse cards (only a human or the
--    helper's own retraction clears them). Body identical to live + one exclusion line.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pick_replies_to_resolve(p_limit integer DEFAULT 15)
 RETURNS TABLE(reply_id uuid, case_number text, subject text, body_text text, received_at timestamp with time zone, labcomm_count integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    AND COALESCE(r.match_method,'') <> 'ai_parse'
    AND COALESCE(r.case_number, q.case_number) IS NOT NULL
    AND r.resolve_state IS DISTINCT FROM 'resolved'
    AND lc.cnt > 0
    AND (r.resolve_checked_at IS NULL OR r.resolve_checked_labcomm_count < lc.cnt)
  ORDER BY r.received_at
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;
