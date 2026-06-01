// Supabase Edge Function: suggest-case-number
//
// Advisory, admin-facing helper for the "⚠ Needs case lookup" backlog. For inbound
// replies the deterministic matcher (match_text_to_case) could NOT link
// (case_number IS NULL), it asks Claude to: extract the patient name from the email,
// search the Cases table (via search_cases_for_suggestion), cross-check the doctor
// name / email / office and the product, and pick the single best case.
//
// It NEVER writes the real `case_number` — only the `suggested_*` columns. The
// "Needs case lookup" tag stays until a human clicks "Use this case #" in the UI,
// which reuses the existing manually_link_reply flow.
//
// Patterned on dr-outreach-reply (stripQuotedReply, Claude Haiku) + classify-comms-ai
// (batched cron tick). Env reuses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY. Driven by a pg_cron tick posting {"batch":25} every 10 min.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY")
  || Deno.env.get("anthropic_api_key")
  || Deno.env.get("anthropic_key_api"))!;

const MODEL = "claude-haiku-4-5-20251001";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Strip the quoted prior email from a reply body so Claude reasons over only the
// new text the doctor wrote. (Mirrors dr-outreach-reply.stripQuotedReply.)
function stripQuotedReply(text: string): string {
  if (!text) return "";
  const markers: RegExp[] = [
    /(^|\n)\s*From:\s+[^\n]+@/i,
    /(^|\n)\s*-{3,}\s*Original Message\s*-{3,}/i,
    /(^|\n)\s*On\s+.{1,100}\bwrote:/i,
    /(^|\n)\s*Sent:\s+\w+,\s+\w+\s+\d+/i,
    /(^|\n)\s*_{15,}/,
    /(^|\n)\s*>\s/,
    /Reply above this line/i,
    /(^|\n)\s*CAUTION:\s*Message is from EXTERNAL SENDER/i,
  ];
  let cutAt = text.length;
  for (const m of markers) {
    const match = text.search(m);
    if (match !== -1 && match < cutAt) cutAt = match;
  }
  const trimmed = text.slice(0, cutAt).trim();
  return trimmed.length > 0 ? trimmed : text.trim();
}

// Resolve the sender email to an Accounts."Account Number" so the search can
// prefer/scope to the practice that emailed us. Returns null when unknown.
async function resolveAccount(fromEmail: string): Promise<string | null> {
  if (!fromEmail) return null;
  const { data } = await sb.from("Accounts")
    .select(`"Account Number"`)
    .ilike("Primary Email", fromEmail)   // case-insensitive exact (no % wildcards)
    .limit(1)
    .maybeSingle();
  return (data as any)?.["Account Number"] ?? null;
}

// The Claude tool: search Cases by patient name, scoped/preferred to the resolved
// account, the sender's email domain (DSO soft-match), and an optional product hint.
// Returns the candidate array (each row carries account_match / domain_match / product_match).
async function searchCases(
  patientName: string,
  accountNumber: string | null,
  product: string | null,
  emailDomain: string | null,
) {
  const { data, error } = await sb.rpc("search_cases_for_suggestion", {
    p_patient_name: patientName,
    p_account_number: accountNumber,
    p_product: product,
    p_email_domain: emailDomain,
    p_limit: 12,
  });
  if (error) return { error: error.message, candidates: [] };
  return { candidates: Array.isArray(data) ? data : [] };
}

const TOOLS = [
  {
    name: "search_cases_by_patient",
    description:
      "Search the dental-lab Cases table for a patient name. Returns candidate cases enriched "
      + "with the doctor name/email, practice/office, product and account number so you can "
      + "cross-check which case the email is about. Call it again with a name variant if the "
      + "first search returns nothing.",
    input_schema: {
      type: "object",
      properties: {
        patient_name: { type: "string", description: "Patient name (full, last, or first) to search for." },
        product: { type: "string", description: "Optional product hint mentioned in the email (e.g. 'crown', 'denture')." },
      },
      required: ["patient_name"],
    },
  },
];

const SYSTEM = `You identify which dental-lab case an inbound doctor email is about.
Extract the patient name from the email, call search_cases_by_patient to find candidates, then
cross-check the doctor name / email / office and the product requested to choose the SINGLE best case.

Each candidate carries flags: account_match (same account as the sender), domain_match (same email
domain / dental group as the sender), and product_match. Choose confidence accordingly:
- Strong patient match + account_match (and ideally product_match): high confidence (~0.8-0.95).
- Strong patient match + product_match but only domain_match (NOT the same account) — i.e. a
  sibling office of the same dental group / DSO (e.g. another Aspen Dental location): STILL suggest
  that case at MODERATE confidence (~0.5-0.65) and note the office/doctor mismatch in the reasoning.
- A patient match with neither account_match nor domain_match, or an ambiguous/weak patient match:
  low confidence; prefer case_number=null unless one candidate is clearly right.
Only return case_number=null when there is no reasonable patient match at all.

When done, reply with ONLY a strict JSON object (no prose, no code fence):
{"case_number": "<Cases.Case Number or null>", "confidence": 0.0-1.0, "reasoning": "<one sentence citing the doctor/office/product cross-check>", "considered": [<the candidate case_numbers you weighed>]}`;

interface Suggestion {
  case_number: string | null;
  confidence: number;
  reasoning: string;
  considered: unknown[];
}

// Run the Claude tool-use loop for one reply. Returns the parsed suggestion plus
// the full candidate list seen (for the suggested_candidates audit column).
async function suggestForReply(
  reply: { subject: string; body_text: string; from_email: string },
): Promise<{ suggestion: Suggestion | null; candidates: unknown[] }> {
  const accountNumber = await resolveAccount(reply.from_email);
  // Sender's email domain — a soft "same dental group / DSO" signal for the search,
  // so cross-office cases (same domain, different account) can still be suggested.
  const fromDomain = (reply.from_email.split("@")[1] || "").toLowerCase().trim() || null;
  const replyOnly = stripQuotedReply(reply.body_text || "");

  const userText =
    `Inbound reply.\nFrom: ${reply.from_email}\nSubject: ${reply.subject || "(none)"}\n\n`
    + `Body (quoted thread already stripped):\n${replyOnly.slice(0, 6000)}`;

  const messages: any[] = [{ role: "user", content: userText }];
  let allCandidates: unknown[] = [];

  for (let round = 0; round < 5; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM,
        tools: TOOLS,
        messages,
      }),
    });
    if (!res.ok) return { suggestion: null, candidates: allCandidates };
    const j = await res.json();

    messages.push({ role: "assistant", content: j.content });

    if (j.stop_reason === "tool_use") {
      const toolResults: any[] = [];
      for (const block of j.content || []) {
        if (block.type !== "tool_use") continue;
        if (block.name === "search_cases_by_patient") {
          const out = await searchCases(
            String(block.input?.patient_name ?? ""),
            accountNumber,
            block.input?.product ? String(block.input.product) : null,
            fromDomain,
          );
          if (Array.isArray(out.candidates)) allCandidates = allCandidates.concat(out.candidates);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(out.candidates ?? out),
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: "unknown tool" }),
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Final text turn — parse the JSON object.
    const text = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { suggestion: null, candidates: allCandidates };
    try {
      const p = JSON.parse(m[0]);
      const rawCase = p.case_number;
      const suggestion: Suggestion = {
        case_number: (rawCase === null || rawCase === undefined || rawCase === "" || rawCase === "null")
          ? null : String(rawCase),
        confidence: Number(p.confidence ?? 0),
        reasoning: String(p.reasoning ?? ""),
        considered: Array.isArray(p.considered) ? p.considered : [],
      };
      return { suggestion, candidates: allCandidates };
    } catch {
      return { suggestion: null, candidates: allCandidates };
    }
  }
  // Ran out of rounds without a final answer.
  return { suggestion: null, candidates: allCandidates };
}

// Guard: a non-null suggested_case_number must be a REAL Cases."Case Number".
async function caseExists(caseNumber: string): Promise<boolean> {
  const { data } = await sb.from("Cases")
    .select(`"Case Number"`)
    .eq("Case Number", caseNumber)
    .limit(1)
    .maybeSingle();
  return !!data;
}

serve(async (req) => {
  const log: any = { started_at: new Date().toISOString(), processed: 0, suggested: 0, none: 0, failed: 0, errors: [] };
  let batch = 25;
  try {
    const b = await req.json();
    if (Number.isFinite(b?.batch)) batch = Math.max(1, Math.min(100, b.batch));
  } catch { /* no body */ }

  try {
    const { data: rows, error } = await sb.from("dr_outreach_replies")
      .select("id, subject, body_text, from_email")
      .is("case_number", null)
      .is("suggested_at", null)
      .order("received_at", { ascending: false })
      .limit(batch);
    if (error) throw error;

    for (const r of rows || []) {
      log.processed++;
      try {
        const { suggestion, candidates } = await suggestForReply(r as any);

        let caseNumber: string | null = suggestion?.case_number ?? null;
        // Never persist a suggested case that isn't a real Cases row.
        if (caseNumber && !(await caseExists(caseNumber))) caseNumber = null;

        const { error: upErr } = await sb.from("dr_outreach_replies").update({
          suggested_case_number: caseNumber,
          suggested_confidence:  caseNumber ? (suggestion?.confidence ?? null) : null,
          suggested_reasoning:   suggestion?.reasoning ?? null,
          suggested_candidates:  candidates.length ? candidates : null,
          suggested_at:          new Date().toISOString(),
          suggested_model:       MODEL,
        }).eq("id", (r as any).id);

        if (upErr) { log.errors.push({ id: (r as any).id, error: upErr.message }); log.failed++; continue; }
        if (caseNumber) log.suggested++; else log.none++;
      } catch (e) {
        // Still stamp suggested_at so a transient error doesn't wedge the row forever.
        await sb.from("dr_outreach_replies").update({
          suggested_at: new Date().toISOString(),
          suggested_model: MODEL,
        }).eq("id", (r as any).id);
        log.errors.push({ id: (r as any).id, error: String((e as any)?.message || e) });
        log.failed++;
      }
    }
  } catch (e) {
    log.errors.push({ stage: "outer", error: String((e as any)?.message || e) });
  }
  log.finished_at = new Date().toISOString();
  return new Response(JSON.stringify(log), { headers: { "Content-Type": "application/json" } });
});
