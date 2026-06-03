-- Auto-reply for inbound iOS-scan submissions — Part 2.
--
-- The acknowledgment template. compose_scan_ack() (see _04) looks this up by
-- (reason='scan_submission_ack', attempt_number=1) and fills the {{tokens}} via
-- render_template(). Because a scan submission has NO case yet, only case-less
-- tokens are available:
--     {{greeting}}        e.g. "Hello Dr. Smith" / "Hi Acme Dental team" / "Hello Doctor"
--     {{dr_first_name}}   account first name if the sender matched an account, else ''
--     {{dr_last_name}}    account last name / practice name if matched, else ''
--     {{practice_name}}   account practice name if matched, else ''
--     {{signature}}       "Spectrum Killian<br/><mailto link to the sending mailbox>"
-- Do NOT use {{patient_name}}/{{case_number}}/{{exocad_link}} here — there is no case.
--
-- Re-runnable: only inserts if a scan_submission_ack/1 template doesn't already exist.
-- ⚠️  The job-aid link href is a PLACEHOLDER (REPLACE_WITH_JOB_AID_URL) — swap in the real
--     Aspen Labs "Onix Fixed ordering" job-aid URL before this goes live. Subject line was
--     drafted to match the body; adjust if desired.
INSERT INTO public.dr_outreach_templates (reason, attempt_number, is_escalation, subject, body_html)
SELECT
  'scan_submission_ack'::outreach_reason,
  1,
  false,
  'Action needed: Resubmit your Locator Fixed case through Aspen Labs',
  -- {{greeting}} renders "Hello Dr. <Name>" when a real provider name is known, else
  -- "Hi <Practice> team" / "Hello Doctor". Using the raw {{dr_last_name}} here printed
  -- location codes (e.g. "Hello Dr 0200 Los Angeles CA Beacon") for Aspen/Beacon accounts.
  '<p>{{greeting}},</p>'
  || '<p>Thank you for your Locator Fixed submission to Spectrum Killian. Unfortunately, we are '
  || 'unable to process this case as it was received directly through 3Shape and does not follow '
  || 'Aspen''s required submission workflow. All cases must be submitted through Aspen Labs for '
  || 'processing. Please resubmit your case via the Aspen Labs portal to ensure timely and accurate '
  || 'fulfillment.</p>'
  || '<p>Please use this link to access the Aspen Labs job aid for detailed instructions on how to '
  || 'submit your case: <a href="REPLACE_WITH_JOB_AID_URL">Onix Fixed ordering in AspenLabs.pdf</a>.</p>'
  || '<p>If you need other assistance with the submission process, please contact the Digital Help '
  || 'Desk at <a href="tel:18009966470">1-800-996-6470</a>.</p>'
  -- {{signature}} renders "Spectrum Killian" + the chosen From mailbox (clearchoice@ or
  -- implants@, by sender domain) as a mailto link.
  || '<p>Best regards,<br/>{{signature}}</p>'
WHERE NOT EXISTS (
  SELECT 1 FROM public.dr_outreach_templates
  WHERE reason = 'scan_submission_ack'::outreach_reason AND attempt_number = 1
);
