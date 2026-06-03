-- Coordinator-uploaded PDF attachments for outbound emails.
--
-- Lets a coordinator drag/drop PDFs onto a Pending Outbound / Pending Approval card; the
-- file is uploaded to the private 'outreach-attachments' bucket (via a service-role signed
-- upload URL minted by the outreach-attachment edge fn) and linked here by attempt_id. At
-- send time, send-attempt / dr-outreach-tick read these rows and attach the files to the
-- Microsoft Graph message (inline for small files, upload session for large ones).

-- Private bucket for user-uploaded attachments (mirrors the outreach-assets pattern).
INSERT INTO storage.buckets (id, name, public)
VALUES ('outreach-attachments', 'outreach-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.dr_outreach_attempt_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     uuid NOT NULL REFERENCES public.dr_outreach_attempts(id) ON DELETE CASCADE,
  storage_bucket text NOT NULL DEFAULT 'outreach-attachments',
  storage_path   text NOT NULL,
  filename       text NOT NULL,
  mime_type      text NOT NULL DEFAULT 'application/pdf',
  size_bytes     bigint,
  uploaded_by    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempt_attachments_attempt
  ON public.dr_outreach_attempt_attachments (attempt_id);

-- Metadata is non-sensitive (filenames/sizes, no bytes). Allow read with the publishable
-- key; writes go through the edge function with the service role (which bypasses RLS).
ALTER TABLE public.dr_outreach_attempt_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attempt_attachments_select ON public.dr_outreach_attempt_attachments;
CREATE POLICY attempt_attachments_select ON public.dr_outreach_attempt_attachments
  FOR SELECT TO anon, authenticated
  USING (true);

GRANT SELECT ON public.dr_outreach_attempt_attachments TO anon, authenticated;
