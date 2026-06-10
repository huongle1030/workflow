-- Post-approval routing for Full-Arch cases, driven by the thread parse (case_parse_state), so it
-- works even when the approval arrives as an ABS note / external email (no classified reply).
--
-- Two scenarios once the design is approved (approval_state approved / approved_small_fix_no_resend
-- / in_production):
--   1) Approved but we haven't thanked the doctor yet  -> compose a "thank you for approving"
--      (design_approval_confirmation) draft so the case shows in Pending Outbound for review/send.
--   2) Approved AND a thank-you has already been SENT  -> the case routes to Ready for ABS scan.
--      For approvals detected by the AI parse (not a coordinator-clicked Approved), this only happens
--      when approval_confidence > 0.95, and the row is flagged (source 'ai_parse_approved') so the UI
--      can mark it with a red asterisk.

-- approval_confidence: the parse's 0..1 confidence in the approval verdict (emitted by parse-case-comms).
ALTER TABLE public.case_parse_state
  ADD COLUMN IF NOT EXISTS approval_confidence numeric;

-- Scenario 1: ensure an approved-but-not-yet-thanked case has a design_approval_confirmation draft.
-- Composes the thank-you AT MOST ONCE per case (guarded on "no design_approval_confirmation attempt
-- in any status"), superseding the stale design_approval chase draft. Returns true if it composed.
CREATE OR REPLACE FUNCTION public.ensure_post_approval_confirmation(p_case_number text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state text;
  v_queue uuid;
  v_next  integer;
BEGIN
  SELECT approval_state INTO v_state FROM case_parse_state WHERE case_number = p_case_number;
  IF v_state IS NULL OR v_state NOT IN ('approved','approved_small_fix_no_resend','in_production') THEN
    RETURN false;
  END IF;

  -- Compose the thank-you only once per case, across any status (so a rejected/sent one never re-appears).
  IF EXISTS (
    SELECT 1 FROM dr_outreach_attempts a
    JOIN dr_outreach_queue q     ON q.id = a.queue_id
    JOIN dr_outreach_templates t ON t.id = a.template_id
    WHERE q.case_number = p_case_number
      AND t.reason = 'design_approval_confirmation'::outreach_reason
  ) THEN
    RETURN false;
  END IF;

  -- Pick the case's outreach queue (prefer the design_approval chase queue).
  SELECT id INTO v_queue FROM dr_outreach_queue
  WHERE case_number = p_case_number
  ORDER BY (reason = 'design_approval'::outreach_reason) DESC, created_at DESC
  LIMIT 1;
  IF v_queue IS NULL THEN RETURN false; END IF;   -- no queue to hang the draft on

  -- Supersede any open chase draft on that queue, then drop in the thank-you draft.
  UPDATE dr_outreach_attempts
  SET status = 'auto_canceled'::attempt_status,
      review_note = left(COALESCE(review_note || ' | ', '') || 'Superseded by approval-confirmation draft (parse-detected approval)', 1000)
  WHERE queue_id = v_queue AND status = 'pending_approval'::attempt_status;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM dr_outreach_attempts WHERE queue_id = v_queue;

  PERFORM compose_attempt_with_reason(v_queue, v_next, 'design_approval_confirmation', 1);
  RETURN true;
END $function$;

GRANT EXECUTE ON FUNCTION public.ensure_post_approval_confirmation(text) TO anon, authenticated, service_role;

-- Store approval_confidence on the parse upsert, and fire the scenario-1 thank-you composer.
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

  -- Scenario 1: approved but not yet thanked -> drop a thank-you draft into Pending Outbound.
  -- Best-effort: never let a compose hiccup fail the parse apply.
  BEGIN
    PERFORM ensure_post_approval_confirmation(p_case_number);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$function$;

-- Scenario 2: route approved + already-thanked cases to Ready for ABS scan. Adds an AI-parse source
-- (gated on approval_confidence > 0.95 and a SENT design_approval_confirmation) alongside the existing
-- reply/abs/casecoord sources. 'ai_parse_approved' is lowest precedence, so a human/ABS source still
-- wins the label when present; the UI flags 'ai_parse_approved' rows with a red asterisk.
CREATE OR REPLACE VIEW public.v_aox_ready_for_abs_scan AS
 WITH dda_cases AS (
         SELECT c."Case Number" AS case_number,
            c."Account Number" AS account_number,
            c."Doctor Due Date" AS doctor_due_date,
            c."Hold Reason" AS hold_reason,
            c."Current Step" AS current_step,
            c."Pan Number" AS pan_number,
            c."Case Status" AS case_status,
            NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' '::text) || c."Patient Last Name"), ''::text) AS patient_name
           FROM "Cases" c
          WHERE c."Current Step" = 'Doctor Design Approval - Full Arch'::text AND (c."Case Status" = ANY (ARRAY['WIP'::text, 'Hold'::text]))
        ), waiting_at AS (
         SELECT DISTINCT ON (cs."Case Number") cs."Case Number" AS case_number,
            cs."Start Date" AS waiting_since
           FROM "Case Steps" cs
             JOIN dda_cases d_1 ON d_1.case_number = cs."Case Number"
          WHERE cs."Step" = 'Doctor Design Approval - Full Arch'::text AND (cs."Status" = ANY (ARRAY['S'::text, 'B'::text]))
          ORDER BY cs."Case Number", cs."Start Date" DESC
        ), approved AS (
         SELECT u.norm_case_number,
            max(u.approved_on) AS approved_on,
            (array_agg(u.source ORDER BY (
                CASE u.source
                    WHEN 'reply_approved_mods'::text THEN 0
                    WHEN 'reply_approved'::text THEN 2
                    WHEN 'ai_parse_approved'::text THEN 3
                    ELSE 1
                END), u.approved_on DESC NULLS LAST))[1] AS source
           FROM ( SELECT cac.case_number AS norm_case_number,
                    cac.approved_on,
                    cac.source
                   FROM v_combined_approved_cases cac
                UNION ALL
                 SELECT regexp_replace(TRIM(BOTH FROM COALESCE(r.case_number, q.case_number)), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text) AS norm_case_number,
                    r.decided_at::date AS approved_on,
                        CASE
                            WHEN r.coordinator_decision = 'approved_with_mods'::text THEN 'reply_approved_mods'::text
                            ELSE 'reply_approved'::text
                        END AS source
                   FROM dr_outreach_replies r
                     LEFT JOIN dr_outreach_queue q ON q.id = r.queue_id
                  WHERE (r.coordinator_decision = ANY (ARRAY['approved'::text, 'approved_with_mods'::text])) AND r.decided_at IS NOT NULL AND COALESCE(r.case_number, q.case_number) IS NOT NULL
                UNION ALL
                 SELECT regexp_replace(TRIM(BOTH FROM ps.case_number), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text) AS norm_case_number,
                    ps.parsed_at::date AS approved_on,
                    'ai_parse_approved'::text AS source
                   FROM case_parse_state ps
                  WHERE ps.approval_state = ANY (ARRAY['approved'::text, 'approved_small_fix_no_resend'::text, 'in_production'::text])
                    AND COALESCE(ps.approval_confidence, 0) > 0.95
                    AND ps.case_number IS NOT NULL
                    AND EXISTS (
                       SELECT 1 FROM dr_outreach_attempts a
                       JOIN dr_outreach_queue q2     ON q2.id = a.queue_id
                       JOIN dr_outreach_templates t  ON t.id = a.template_id
                       WHERE q2.case_number = ps.case_number
                         AND a.status = 'sent'::attempt_status
                         AND t.reason = 'design_approval_confirmation'::outreach_reason
                    )) u
          GROUP BY u.norm_case_number
        )
 SELECT d.case_number,
    COALESCE(w.waiting_since, now()) AS waiting_since,
    d.account_number,
    d.doctor_due_date,
    d.hold_reason,
    d.current_step,
    d.pan_number,
    d.patient_name,
    a."First Name" AS dr_first_name,
    a."Last Name" AS dr_last_name,
    a."Dr Pref" AS dr_pref,
    a."Practice Name" AS practice_name,
    a."Primary Email" AS dr_email,
    a."Account Manager" AS account_manager,
    ap.approved_on,
    ap.source AS approved_source,
    (ap.source = 'ai_parse_approved'::text) AS ai_classified
   FROM dda_cases d
     LEFT JOIN waiting_at w ON w.case_number = d.case_number
     JOIN "Accounts" a ON a."Account Number" = d.account_number
     JOIN approved ap ON ap.norm_case_number = regexp_replace(TRIM(BOTH FROM d.case_number), '^\s*(\d{3,4})-+0*(\d+)\s*$'::text, '\1-\2'::text);
