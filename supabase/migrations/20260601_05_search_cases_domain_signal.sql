-- Tuning — add an email-DOMAIN (DSO) signal to search_cases_for_suggestion.
--
-- Why: big dental groups (e.g. Aspen Dental) span many offices under one email
-- domain. A doctor at one branch (drkunduru@aspendental.com / Richardson,Mesquite)
-- may email about a patient whose lab cases are registered to a sibling office
-- (victor.wilcoxson@aspendental.com / Euless). The strict account/doctor match
-- then drops a perfectly good patient+product match. `domain_match` lets Claude
-- prefer same-DSO candidates and suggest them at moderate confidence.
--
-- Adds the p_email_domain param (so the function signature changes); DROP + CREATE
-- to avoid leaving an overloaded copy of the old 4-arg version behind.
DROP FUNCTION IF EXISTS public.search_cases_for_suggestion(text,text,text,int);

CREATE OR REPLACE FUNCTION public.search_cases_for_suggestion(
  p_patient_name   text,
  p_account_number text DEFAULT NULL,   -- sender's resolved account (exact scope/prefer)
  p_product        text DEFAULT NULL,   -- optional product hint from the email
  p_email_domain   text DEFAULT NULL,   -- sender's email domain (DSO soft-match), e.g. 'aspendental.com'
  p_limit          int  DEFAULT 12
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT
      c."Case Number"          AS case_number,
      c."Patient First Name"   AS patient_first,
      c."Patient Last Name"    AS patient_last,
      c."Primary Product"      AS primary_product,
      c."Received Date"        AS received_date,
      c."Account Number"       AS account_number,
      a."First Name"           AS dr_first,
      a."Last Name"            AS dr_last,
      a."Practice Name"        AS practice_name,
      a."Primary Email"        AS dr_email,
      a."City" || ', ' || a."State" AS dr_office,
      (p_account_number IS NOT NULL AND c."Account Number" = p_account_number) AS account_match,
      (p_email_domain   IS NOT NULL AND a."Primary Email" ILIKE '%@' || p_email_domain) AS domain_match,
      (p_product        IS NOT NULL AND c."Primary Product" ILIKE '%' || p_product || '%') AS product_match
    FROM "Cases" c
    LEFT JOIN "Accounts" a ON a."Account Number" = c."Account Number"
    WHERE (c."Patient First Name" || ' ' || c."Patient Last Name") ILIKE '%' || p_patient_name || '%'
       OR c."Patient Last Name"  ILIKE '%' || p_patient_name || '%'
       OR c."Patient First Name" ILIKE '%' || p_patient_name || '%'
    -- prefer exact account, then same DSO domain, then product, then most recent
    ORDER BY account_match DESC, domain_match DESC, product_match DESC, c."Received Date" DESC NULLS LAST
    LIMIT p_limit
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.search_cases_for_suggestion(text,text,text,text,int)
  TO anon, authenticated, service_role;
