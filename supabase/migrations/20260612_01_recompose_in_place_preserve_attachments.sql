-- =====================================================================
-- Make draft "recompose" non-destructive: preserve attachments + recipients
-- =====================================================================
-- Background. Coordinators upload RX photos onto a pending draft; the photos live
-- in dr_outreach_attempt_attachments, keyed by attempt_id with ON DELETE CASCADE.
-- Typed To/CC live on the attempt row (to_emails / cc_emails). DraftGuard restores
-- body/recipient edits across re-renders by the attempt_id-scoped field ids.
--
-- Several "recompose" helpers regenerated a draft by DELETEing the pending attempt
-- and INSERTing a fresh one. That gave the draft a NEW id, which:
--   * cascade-DELETED the coordinator's uploaded photos, and
--   * reset recipients to the template default + orphaned DraftGuard's body draft.
-- That was the bug behind "inserting the ExoCAD link after adding photos/emails
-- deletes the photos and resets the recipients" (saveExocadLink -> recompose_pending_for_case),
-- and the same hazard sits behind the "Regenerate Summary" button (recompose_pending_attempt).
--
-- Fix: recompose IN PLACE. Render fresh subject/body via the normal composer into a
-- throwaway row, copy that content back onto the ORIGINAL attempt (same id), then drop
-- the throwaway. The original row keeps its id, so its attachments and typed recipients
-- survive. (dr_outreach_attempts has no INSERT/DELETE triggers and no unique constraint
-- on (queue_id, attempt_number), so the transient throwaway row is side-effect-free.)

-- ---------------------------------------------------------------------
-- Shared helper: regenerate one pending attempt's body without changing its id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompose_attempt_in_place(p_attempt_id uuid)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old    dr_outreach_attempts;
  v_tmp    dr_outreach_attempts;
  v_reason outreach_reason;
  v_row    dr_outreach_attempts;
BEGIN
  SELECT * INTO v_old FROM dr_outreach_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt % not found', p_attempt_id; END IF;
  IF v_old.status <> 'pending_approval'::attempt_status THEN
    RAISE EXCEPTION 'attempt is not pending_approval (status=%)', v_old.status;
  END IF;

  SELECT reason INTO v_reason FROM dr_outreach_queue WHERE id = v_old.queue_id;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'queue % not found', v_old.queue_id; END IF;

  -- Render fresh subject/body via the normal composer (it only INSERTs), into a throwaway row.
  v_tmp := compose_attempt_with_reason(v_old.queue_id, v_old.attempt_number, v_reason::text, v_old.attempt_number);

  -- Copy the regenerated content onto the ORIGINAL attempt. Preserving the id keeps the
  -- coordinator's uploaded attachments and any typed To/CC (to_emails / cc_emails) intact;
  -- only the rendered body is refreshed.
  UPDATE dr_outreach_attempts
     SET subject        = v_tmp.subject,
         body_html      = v_tmp.body_html,
         template_id    = v_tmp.template_id,
         sender_mailbox = v_tmp.sender_mailbox
   WHERE id = p_attempt_id
   RETURNING * INTO v_row;

  -- Discard the throwaway draft (it never carried attachments, so its cascade deletes nothing).
  DELETE FROM dr_outreach_attempts WHERE id = v_tmp.id;

  RETURN v_row;
END $function$;

GRANT EXECUTE ON FUNCTION public.recompose_attempt_in_place(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- recompose_pending_attempt: backs the "Regenerate Summary" button. Now in-place,
-- so regenerating the body no longer deletes the RX photo or resets recipients.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompose_pending_attempt(p_attempt_id uuid)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN recompose_attempt_in_place(p_attempt_id);
END $function$;

-- ---------------------------------------------------------------------
-- recompose_pending_for_case: previously DELETE+recreated every pending draft on a
-- case (the saveExocadLink path). The frontend no longer calls it, but harden it too
-- so no caller can ever silently destroy a coordinator's photos/recipients.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompose_pending_for_case(p_case_number text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count   integer := 0;
  v_attempt RECORD;
BEGIN
  FOR v_attempt IN
    SELECT a.id
    FROM dr_outreach_attempts a
    JOIN dr_outreach_queue q ON q.id = a.queue_id
    WHERE a.status = 'pending_approval'::attempt_status
      AND q.case_number = p_case_number
  LOOP
    PERFORM recompose_attempt_in_place(v_attempt.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;

-- ---------------------------------------------------------------------
-- recompose_attempt_with_reason: backs the "Select draft" button. It deliberately
-- supersedes the open draft (status -> auto_canceled) and composes a fresh one under
-- a new id for the chosen template. Carry the coordinator's uploaded attachments
-- forward onto the new draft so re-selecting a template never silently drops the RX
-- photo they already attached. (Recipients legitimately reset here — re-selecting a
-- template is an explicit "start this draft over" action.)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompose_attempt_with_reason(p_attempt_id uuid, p_reason text)
 RETURNS dr_outreach_attempts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_queue_id   uuid;
  v_next       integer;
  v_attempt    dr_outreach_attempts;
  v_superseded uuid[];
BEGIN
  SELECT queue_id INTO v_queue_id FROM dr_outreach_attempts WHERE id = p_attempt_id;
  IF v_queue_id IS NULL THEN RETURN NULL; END IF;

  -- Capture the open drafts we're about to supersede so we can move their attachments forward.
  SELECT array_agg(id) INTO v_superseded
  FROM dr_outreach_attempts
  WHERE queue_id = v_queue_id AND status = 'pending_approval'::attempt_status;

  -- Supersede any open draft on this queue (the one being replaced, plus any other stale draft).
  UPDATE dr_outreach_attempts
  SET status      = 'auto_canceled'::attempt_status,
      review_note = left(COALESCE(review_note || ' | ', '') || 'Superseded by manual draft re-selection (' || p_reason || ')', 1000)
  WHERE queue_id = v_queue_id AND status = 'pending_approval'::attempt_status;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM dr_outreach_attempts WHERE queue_id = v_queue_id;

  v_attempt := compose_attempt_with_reason(v_queue_id, v_next, p_reason, 1);

  -- Carry coordinator-uploaded attachments forward onto the freshly selected draft.
  IF v_superseded IS NOT NULL THEN
    UPDATE dr_outreach_attempt_attachments
       SET attempt_id = v_attempt.id
     WHERE attempt_id = ANY(v_superseded);
  END IF;

  RETURN v_attempt;
END $function$;
