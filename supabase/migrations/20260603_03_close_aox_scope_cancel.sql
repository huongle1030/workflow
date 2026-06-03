-- Fix: close_advanced_aox_cases() was auto-canceling scan_submission_ack drafts.
--
-- The function closes design_approval queues whose ABS case advanced past Doctor Design
-- Approval, then cancels the associated drafts. But the draft-cancel step matched ANY
-- recently-closed queue, while scan_submission_ack queues are created CLOSED by design
-- (one-shot acks). So a freshly composed scan-ack draft got auto-canceled if this job ran
-- within ~1 minute of creation. Scope the cancel to reason='design_approval' (matching the
-- queue-close CTE above it) so other reasons' drafts are never swept.
CREATE OR REPLACE FUNCTION public.close_advanced_aox_cases()
 RETURNS TABLE(closed_queue_rows integer, canceled_drafts integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_queue_count INTEGER;
  v_draft_count INTEGER;
BEGIN
  WITH closed AS (
    UPDATE dr_outreach_queue q
    SET status = 'closed'::outreach_status,
        removed_by = 'system',
        removed_reason = CASE
          WHEN c."Case Status" NOT IN ('WIP','Hold') THEN 'Case no longer active (Case Status = ' || COALESCE(c."Case Status",'NULL') || ')'
          ELSE 'Case advanced past Doctor Design Approval in ABS'
        END,
        updated_at = now()
    FROM "Cases" c
    WHERE q.case_number = c."Case Number"
      AND q.status = 'open'
      AND q.reason = 'design_approval'
      AND (
        c."Current Step" IS NULL
        OR c."Current Step" != 'Doctor Design Approval - Full Arch'
        OR c."Case Status" NOT IN ('WIP','Hold')
      )
    RETURNING q.id
  )
  SELECT COUNT(*) INTO v_queue_count FROM closed;

  UPDATE dr_outreach_attempts a
  SET status = 'auto_canceled'::attempt_status,
      review_action = 'auto_canceled',
      review_note = 'Case no longer active in ABS — draft auto-canceled',
      reviewer_id = 'system',
      reviewed_at = now()
  WHERE a.status IN ('pending_approval'::attempt_status, 'queued'::attempt_status)
    AND EXISTS (
      SELECT 1 FROM dr_outreach_queue q
      WHERE q.id = a.queue_id
        AND q.status = 'closed'
        AND q.reason = 'design_approval'
        AND q.updated_at >= now() - interval '1 minute'
    );
  GET DIAGNOSTICS v_draft_count = ROW_COUNT;

  RETURN QUERY SELECT v_queue_count, v_draft_count;
END $function$;
