-- Auto-reply for inbound iOS-scan submissions — Part 1.
--
-- New outreach reason for the templated acknowledgment we send back when a doctor
-- emails in a patient's iOS / intraoral scan. Kept as its own reason so it gets its
-- own template row in dr_outreach_templates (see _02).
--
-- NOTE: `ALTER TYPE ... ADD VALUE` must be committed in its OWN migration before any
-- statement that *uses* the new value (Postgres won't let a new enum value be used in
-- the same transaction that adds it). Hence this is a standalone file.
ALTER TYPE public.outreach_reason ADD VALUE IF NOT EXISTS 'scan_submission_ack';
