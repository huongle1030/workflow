-- "No email from any tab before user approval." The dr-outreach-tick cron auto-sends a due row only
-- when its reason's gate is falsy, and a reason with NO dr_outreach_settings row defaults to SEND.
-- Ensure EVERY outreach_reason is gated (requires_approval_before_send = true) so the cron always
-- composes a pending_approval draft for coordinator review instead of sending. (The cron itself is
-- also hardened in supabase/functions/dr-outreach-tick to never auto-send; this is the live,
-- config-level guarantee that holds even before that redeploy.)

-- 1) Force every existing settings row to require approval (the 4 present were already true).
UPDATE dr_outreach_settings
SET requires_approval_before_send = true, updated_at = now()
WHERE requires_approval_before_send IS DISTINCT FROM true;

-- 2) Add gated rows for any reason that has none yet (otherwise the cron would default it to SEND).
INSERT INTO dr_outreach_settings (reason, requires_approval_before_send, auto_confirm_enabled)
SELECT r, true, false
FROM unnest(ARRAY['late_approval_notice','reschedule_check','scan_submission_ack']::outreach_reason[]) AS r
WHERE NOT EXISTS (SELECT 1 FROM dr_outreach_settings s WHERE s.reason = r);
