-- Sonnet-driven Pending Outbound attempt/modification tracking — Part 1: storage.
--
-- A Claude Sonnet classifier reads each Full-Arch + WIP design-approval case's ENTIRE
-- communication history (case_communications, oldest -> newest, same timeline Case Lookup shows)
-- and decides whether the design is still awaiting doctor approval plus the per-reason follow-up
-- attempt counts. Those results drive which Pending Outbound cards show and which template the
-- card drafts next.
--
-- WHERE THE RESULTS LIVE (decided with huong, 2026-06-07): a dedicated table, NOT the caseflow
-- "Case" table. Only 52 of ~208 outbound cases have a "Case" row, so UPSERTing parse output into
-- "Case" would create ~156 phantom caseflow cards and churn updated_date on every re-parse, pushing
-- real cases out of the Case Tracker's 500-row load. case_parse_state is read only by the Pending
-- Outbound view, so CaseFlow (Case Tracker, FPY = dr_approval_count, the 2-mod cap on
-- design_change_count) is completely untouched.
--
-- The 7 outreach_reason values map to these columns:
--   design_approval     -> design_approval_attempt_count   (new; NOT "Case".dr_approval_count)
--   design_modification -> design_modification_count       (== "modification count")
--   missing_info        -> missing_info
--   waiting_on_parts    -> waiting_on_parts
--   late_approval_notice-> late_approval_notice
--   reschedule_check    -> reschedule_check
--   scan_submission_ack -> scan_submission_ack
--
-- No double-counting: each parse fully recomputes every count from scratch from the complete comm
-- history and OVERWRITES the row, so re-running is idempotent and can never inflate a count.

-- Latest parse verdict per case (one row per case_number; overwritten on every re-parse).
CREATE TABLE IF NOT EXISTS public.case_parse_state (
  case_number                     text PRIMARY KEY,
  -- verdict
  approval_state                  text,              -- awaiting_review | mods_requested | approved_small_fix_no_resend | approved | in_production
  show_in_pending_outbound        boolean NOT NULL DEFAULT true,
  most_recent_unapproved_reason   outreach_reason,   -- the reason the case is still open on, or NULL if approved
  initial_design_in_progress      boolean NOT NULL DEFAULT false,  -- true iff exactly one comm exists
  -- per-reason follow-up attempt counts
  design_approval_attempt_count   integer NOT NULL DEFAULT 0,
  design_modification_count       integer NOT NULL DEFAULT 0,
  missing_info                    integer NOT NULL DEFAULT 0,
  waiting_on_parts                integer NOT NULL DEFAULT 0,
  late_approval_notice            integer NOT NULL DEFAULT 0,
  reschedule_check                integer NOT NULL DEFAULT 0,
  scan_submission_ack             integer NOT NULL DEFAULT 0,
  -- provenance / audit
  evidence                        jsonb,             -- { "<reason|verdict>": "<case_communications.id>" }
  model                           text,
  comm_count                      integer,
  last_comm_at                    timestamptz,       -- occurred_at of the newest comm seen this parse
  parsed_at                       timestamptz,
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.case_parse_state IS
  'Latest Sonnet parse verdict + per-reason attempt counts per case_number, consumed by v_fullarch_wip_outbound. Overwritten (full recompute) on every parse. Separate from caseflow "Case".';

-- Full history of every parse run (transparency + idempotent dedup via evidence comm ids).
CREATE TABLE IF NOT EXISTS public.case_parse_audit (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number                     text NOT NULL,
  parsed_at                       timestamptz NOT NULL DEFAULT now(),
  model                           text,
  approval_state                  text,
  show_in_pending_outbound        boolean,
  most_recent_unapproved_reason   text,
  initial_design_in_progress      boolean,
  per_reason_attempts             jsonb,
  modification_count              integer,
  comm_count                      integer,
  evidence                        jsonb,
  raw_response                    jsonb
);

CREATE INDEX IF NOT EXISTS case_parse_audit_case_idx
  ON public.case_parse_audit (case_number, parsed_at DESC);

-- The Pending Outbound view reads case_parse_state; grant SELECT to the same roles the view is
-- granted to. The edge function writes via the service role (bypasses RLS).
GRANT SELECT ON public.case_parse_state TO anon, authenticated, service_role;
GRANT SELECT ON public.case_parse_audit TO authenticated, service_role;
