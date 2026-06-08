-- Sonnet-driven Pending Outbound tracking — Part 5: re-parse when a doctor reply is classified.
--
-- Spec: the Pending Replies "modification" button must NOT do its own +1 — it logs the change and
-- triggers a re-parse, so the manual action and the AI parse can never both count the same
-- modification.
--
-- With parse results living in case_parse_state (separate from caseflow "Case"), the Pending
-- Outbound card's modification count comes ONLY from the parse (a full recompute from the comm
-- history), so it can never be inflated by a button click. confirm_reply is therefore left
-- UNCHANGED — it keeps maintaining the caseflow "Case".design_change_count / dr_approval_count that
-- the Case Tracker / FPY / 2-mod cap rely on. All this migration adds is: whenever a reply gets a
-- coordinator decision (Modification / Approved / Approved+Mods / ... via the button OR the
-- auto-classifier), enqueue the case for a fresh parse so the card updates promptly.

CREATE OR REPLACE FUNCTION public.enqueue_parse_on_reply_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case text;
BEGIN
  IF NEW.coordinator_decision IS DISTINCT FROM OLD.coordinator_decision
     AND NEW.coordinator_decision IS NOT NULL THEN
    SELECT case_number INTO v_case FROM dr_outreach_queue WHERE id = NEW.queue_id;
    IF v_case IS NULL THEN
      v_case := NEW.case_number;
    END IF;
    IF v_case IS NOT NULL THEN
      PERFORM public.enqueue_case_parse(v_case);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_parse_on_reply_decision ON public.dr_outreach_replies;
CREATE TRIGGER trg_enqueue_parse_on_reply_decision
  AFTER UPDATE ON public.dr_outreach_replies
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_parse_on_reply_decision();
