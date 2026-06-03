-- Auto-reply for inbound iOS-scan submissions — job-aid as a real attachment.
--
-- Originally the scan_submission_ack/1 template (see 20260602_02) linked the Aspen Labs
-- job aid via a placeholder href (REPLACE_WITH_JOB_AID_URL) that was never filled in. We
-- now ship the PDF as a true email attachment instead:
--   * The PDF lives in the private 'outreach-assets' storage bucket
--     (object: onix-fixed-ordering-aspenlabs.pdf).
--   * dr-outreach-tick (v7) downloads it with the service role and attaches it to any
--     send whose queue.reason = 'scan_submission_ack'.
-- So the body should point the doctor at the attachment, not a (broken) link.
--
-- Surgical replace of just the link paragraph, so any other manual edits to the body are
-- preserved. Re-runnable (the replace is a no-op once applied).
UPDATE public.dr_outreach_templates
SET body_html = replace(
  body_html,
  '<p>Please use this link to access the Aspen Labs job aid for detailed instructions on how to '
  || 'submit your case: <a href="REPLACE_WITH_JOB_AID_URL">Onix Fixed ordering in AspenLabs.pdf</a>.</p>',
  '<p>Please refer to the attached job aid (Onix Fixed ordering in AspenLabs.pdf) for detailed '
  || 'instructions on how to submit your case.</p>'
)
WHERE reason = 'scan_submission_ack'::outreach_reason AND attempt_number = 1;

-- Bring any already-composed draft still awaiting approval in line with the new wording,
-- so coordinators don't approve-and-send an email carrying the dead placeholder link.
UPDATE public.dr_outreach_attempts a
SET body_html = replace(
  a.body_html,
  '<p>Please use this link to access the Aspen Labs job aid for detailed instructions on how to submit your case: <a href="REPLACE_WITH_JOB_AID_URL">Onix Fixed ordering in AspenLabs.pdf</a>.</p>',
  '<p>Please refer to the attached job aid (Onix Fixed ordering in AspenLabs.pdf) for detailed instructions on how to submit your case.</p>'
)
FROM public.dr_outreach_queue q
WHERE a.queue_id = q.id
  AND q.reason = 'scan_submission_ack'::outreach_reason
  AND a.status = 'pending_approval'
  AND a.body_html LIKE '%REPLACE_WITH_JOB_AID_URL%';
