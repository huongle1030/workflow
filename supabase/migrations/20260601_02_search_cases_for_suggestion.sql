-- Part 2 — search_cases_for_suggestion RPC (the Claude tool).
--
-- Returns candidate cases for a patient name, enriched with the doctor / office /
-- product so Claude can cross-check and disambiguate. SECURITY DEFINER with a
-- pinned search_path; granted to anon/authenticated/service_role (the app uses the
-- publishable key — see project memory: data-layer-uses-publishable-key).
CREATE OR REPLACE FUNCTION public.search_cases_for_suggestion(
  p_patient_name   text,
  p_account_number text DEFAULT NULL,   -- sender's account if resolved (scope/prefer)
  p_product        text DEFAULT NULL,   -- optional product hint from the email
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
      (p_product IS NOT NULL AND c."Primary Product" ILIKE '%' || p_product || '%') AS product_match
    FROM "Cases" c
    LEFT JOIN "Accounts" a ON a."Account Number" = c."Account Number"
    WHERE (c."Patient First Name" || ' ' || c."Patient Last Name") ILIKE '%' || p_patient_name || '%'
       OR c."Patient Last Name"  ILIKE '%' || p_patient_name || '%'
       OR c."Patient First Name" ILIKE '%' || p_patient_name || '%'
    -- prefer the sender's account, then product match, then most recent case
    ORDER BY account_match DESC, product_match DESC, c."Received Date" DESC NULLS LAST
    LIMIT p_limit
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.search_cases_for_suggestion(text,text,text,int)
  TO anon, authenticated, service_role;
