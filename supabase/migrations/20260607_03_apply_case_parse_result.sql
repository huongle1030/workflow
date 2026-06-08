-- Sonnet-driven Pending Outbound tracking — Part 3: persist one parse result.
--
-- The parse-case-comms edge function builds the structured JSON verdict for a case and hands it to
-- this RPC, which (a) OVERWRITES case_parse_state (full recompute -> idempotent, never inflates a
-- count), (b) appends an immutable audit row, and (c) marks the queue item done. Doing the write in
-- one SECURITY DEFINER call keeps the edge function thin and the write atomic.
--
-- p_result shape (produced by the edge function, see supabase/functions/parse-case-comms):
--   {
--     "approval_state": "...", "show_in_pending_outbound": true/false,
--     "most_recent_unapproved_reason": "design_approval"|null,
--     "initial_design_in_progress": true/false,
--     "per_reason_attempts": { "design_approval": N, "design_modification": N, ... 7 keys ... },
--     "modification_count": N, "evidence": { ... }, "model": "...",
--     "comm_count": N, "last_comm_at": "ISO8601"
--   }

CREATE OR REPLACE FUNCTION public.apply_case_parse_result(p_case_number text, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  -- Only accept a known outreach_reason; anything else (or null) means "approved / no open reason".
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
    evidence, model, comm_count, last_comm_at, parsed_at, updated_at
  ) VALUES (
    p_case_number, v_state, v_show, v_reason_enum,
    v_init, v_da, v_dm, v_mi, v_wp, v_la, v_rc, v_sa,
    p_result->'evidence', v_model, v_comm, v_last, now(), now()
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_case_parse_result(text, jsonb) TO service_role;
