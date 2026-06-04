-- CaseFlow production modes — Data Entry / Case Review / Scanning / Design Team.
-- Backing store for the four new front-end modes (src/caseflow/*). See
-- prd/PRD_caseflow_4_modes.md and prd/issues-caseflow-4-modes.md.
--
-- SINGLE-TABLE design: one row per case. The timeline (events) and file metadata
-- are folded into JSONB columns on this row instead of separate child tables, so
-- there is just ONE table (+ one Storage bucket for the actual file bytes).
-- Trade-off: events are not append-only — adding one rewrites the case row
-- (last-write-wins if two people edit the same case simultaneously). Fine for
-- this internal queue tool.
--
-- AUTH / RLS CAVEAT (issues B-2, B-3): this app's data path sends the Supabase
-- *publishable (anon)* key, not the signed-in user's JWT — so attribution stored
-- in JSONB (events[].by, files[].uploaded_by, reqs_ack_by) is CLIENT-STAMPED, not
-- server-verified. The policy below is permissive (anon + authenticated), matching
-- the rest of this app; real access control is the UI (permissions.js) for now.
--
-- Idempotent and SAFE TO RE-RUN. Nothing here was applied for you — review, then
-- apply via the Supabase MCP apply_migration or the CLI.

-- ── the one table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.caseflow_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       text UNIQUE NOT NULL,                  -- 'CF-001' style display id
  patient       text,
  doctor        text,
  case_num      text,
  rush          boolean NOT NULL DEFAULT false,
  ship_date     date,                                  -- pure date — never write a timestamptz here
  dr_due_date   date,                                  -- (avoids the PST day-shift gotcha)
  stage         text NOT NULL DEFAULT 'Data Entry'
    CHECK (stage IN ('Data Entry','Review','Scanning','Design Check','Outsourcing',
                     'QC','QC Failed - Rework','QC Failed - Resend',
                     'Case Coordination','Complete')),
  de_hold       text CHECK (de_hold IN ('models','missing')),
  notes         text,
  design_notes  text,
  design_reqs   jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [string]
  reqs_ack      boolean NOT NULL DEFAULT false,
  reqs_ack_by   text,
  reqs_ack_at   timestamptz,
  aox           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- Data Entry AOX checklist state
  aox_review    jsonb NOT NULL DEFAULT '{}'::jsonb,    -- Case Review checklist state (incl. aspFiles)
  dcl_type      text CHECK (dcl_type IN ('CC','LFX','TRI')),
  dcl           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- design checklist answers keyed t:/k:/y:/c:/site:
  checklist_done jsonb NOT NULL DEFAULT '[]'::jsonb,   -- design-readiness checklist indices (5-item DESIGN_CL)
  coord_reason  text,
  outsource_notes text,                                -- Design Team: notes captured at the Outsourcing step
  qc_notes      text,                                  -- Design Team: QC notes captured at the QC step
  events        jsonb NOT NULL DEFAULT '[]'::jsonb,    -- timeline: [{text, by, at}]
  files         jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {entry:[], review:[], scan:[], design:{}} — metadata only; bytes in Storage
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Idempotent for DBs created before these columns existed:
ALTER TABLE public.caseflow_cases ADD COLUMN IF NOT EXISTS outsource_notes text;
ALTER TABLE public.caseflow_cases ADD COLUMN IF NOT EXISTS qc_notes text;

CREATE INDEX IF NOT EXISTS idx_caseflow_cases_stage   ON public.caseflow_cases (stage);
CREATE INDEX IF NOT EXISTS idx_caseflow_cases_de_hold ON public.caseflow_cases (de_hold);

-- keep updated_at fresh even if a client forgets to stamp it
CREATE OR REPLACE FUNCTION public.caseflow_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_caseflow_cases_touch ON public.caseflow_cases;
CREATE TRIGGER trg_caseflow_cases_touch
  BEFORE UPDATE ON public.caseflow_cases
  FOR EACH ROW EXECUTE FUNCTION public.caseflow_touch_updated_at();

-- ── RLS + grants (permissive — see CAVEAT above) ─────────────────────
ALTER TABLE public.caseflow_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS caseflow_cases_all ON public.caseflow_cases;
CREATE POLICY caseflow_cases_all ON public.caseflow_cases
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.caseflow_cases TO anon, authenticated;

-- ── Storage bucket for case files (bytes) ────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('caseflow-files', 'caseflow-files', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS caseflow_files_objects_rw ON storage.objects;
CREATE POLICY caseflow_files_objects_rw ON storage.objects
  FOR ALL TO anon, authenticated
  USING (bucket_id = 'caseflow-files')
  WITH CHECK (bucket_id = 'caseflow-files');

-- ── (optional) queue-count view for badges ───────────────────────────
CREATE OR REPLACE VIEW public.v_caseflow_queue_counts
WITH (security_invoker = on) AS
SELECT stage, de_hold, count(*)::int AS n
FROM public.caseflow_cases
GROUP BY stage, de_hold;
GRANT SELECT ON public.v_caseflow_queue_counts TO anon, authenticated;
