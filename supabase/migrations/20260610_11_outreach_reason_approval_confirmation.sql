-- New outreach_reason for the "thank you for approving" confirmation template that the Pending
-- Classification Approved / Approved+Mods buttons draft. Must be added in its own migration: Postgres
-- forbids using a newly-added enum value later in the same transaction.
ALTER TYPE public.outreach_reason ADD VALUE IF NOT EXISTS 'design_approval_confirmation';
