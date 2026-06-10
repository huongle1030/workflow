-- Pending Classification: record the coordinator's button choice in its own column,
-- sitting next to the AI's ai_classification so the two are directly comparable.
-- Stores the canonical decision key (same vocabulary as ai_classification):
--   approved | approved_with_mods | modification | pricing_or_product_question
--   | escalated_call | other
-- Distinct from coordinator_decision (kept for back-compat); this is the dedicated,
-- always-the-button-label column the Pending Classification UI reads/writes.
ALTER TABLE public.dr_outreach_replies
  ADD COLUMN IF NOT EXISTS human_classification text;

COMMENT ON COLUMN public.dr_outreach_replies.human_classification IS
  'Coordinator''s Pending Classification button choice: approved | approved_with_mods | modification | pricing_or_product_question | escalated_call | other. Mirrors ai_classification''s vocabulary.';
