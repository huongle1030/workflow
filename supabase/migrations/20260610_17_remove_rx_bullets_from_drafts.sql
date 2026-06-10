-- Remove the RX summary bullet block ({{rx_bullets}}) from outreach email drafts entirely.
--
-- The bullet list rendered into the email body by format_rx_bullets() (filling the {{rx_bullets}}
-- placeholder) is being dropped from all drafts:
--   1) Future drafts: strip the {{rx_bullets}} placeholder out of the templates that embed it
--      (the design_approval attempt 1-3 bodies — the only templates that reference it). Every
--      compose path (compose_pending_attempt / compose_attempt_with_reason / recompose) renders
--      from these templates, so this covers all newly-generated drafts.
--   2) Existing pending drafts: the block was already rendered into body_html at compose time, so
--      string-replace it back out. Compose applies strip_special_dashes() to the rendered body, so
--      we match the same strip_special_dashes(format_rx_bullets(...)) value. Verified ahead of time:
--      this matches exactly the 74 pending drafts built from an rx-bullets template and touches no
--      other drafts (no false positives). Only the RX block is removed; coordinator hand-edits to
--      the rest of the body are preserved.
--
-- The attached RX file (case_rx_attachments) and the fallback RX Summary PDF are unaffected — this
-- only concerns the bulleted list inside the email body text.

-- 1) Existing pending drafts: strip the already-rendered RX block (run before the template edit so
--    the match value is independent of it; format_rx_bullets does not depend on the templates).
UPDATE public.dr_outreach_attempts a
SET body_html = replace(a.body_html, strip_special_dashes(format_rx_bullets(q.case_number)), '')
FROM public.dr_outreach_queue q
WHERE a.queue_id = q.id
  AND a.status = 'pending_approval'::attempt_status
  AND q.case_number IS NOT NULL
  AND position(strip_special_dashes(format_rx_bullets(q.case_number)) in a.body_html) > 0;

-- 2) Future drafts: drop the {{rx_bullets}} placeholder (and its leading newline) from the
--    templates that embed it.
UPDATE public.dr_outreach_templates
SET body_html = replace(body_html, E'\n{{rx_bullets}}', '')
WHERE body_html LIKE '%{{rx_bullets}}%';
