// Supabase Edge Function: parse-case-comms
//
// Cron-driven worker for the Pending Outbound tab. On each tick:
//   1) pick_cases_for_parse(batch) atomically claims up to `batch` queued cases
//   2) for each case, read its ENTIRE case_communications history (oldest -> newest, the same
//      timeline Case Lookup shows) and ask Claude SONNET to decide:
//        - whether the design is still awaiting doctor approval (show_in_pending_outbound)
//        - the per-reason follow-up attempt counts (7 outreach_reason values)
//        - the modification count, the open reason, and initial_design_in_progress
//   3) apply_case_parse_result() OVERWRITES case_parse_state (full recompute -> idempotent),
//      appends an audit row, and marks the queue item done.
//
// The queue is fed by a trigger on case_communications INSERT (scoped to Full-Arch WIP
// design-approval cases) and by confirm_reply's reply-classification trigger. We never call Sonnet
// inline on insert. Schedule from pg_cron (20260607_06): every 5 minutes.
//
// Required secrets (already set for dr-outreach-tick):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY")
  || Deno.env.get("anthropic_api_key")
  || Deno.env.get("anthropic_key_api"))!;
const CLAUDE_MODEL = "claude-sonnet-4-6";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const REASONS = [
  "design_approval", "design_modification", "missing_info", "waiting_on_parts",
  "late_approval_notice", "reschedule_check", "scan_submission_ack",
];

// ---- The static rules. Cached on the Anthropic side (ephemeral) so a batch of cases reuses it. ----
const SYSTEM_PROMPT = `You analyze the complete communication history of ONE dental-lab case and return a strict JSON verdict about its doctor-design-approval status and our follow-up attempt counts.

WHO IS WHO
- "LAB" = us, Spectrum Killian Dental Lab (SKDLA). Our messages come from @skdla.com addresses (e.g. implants@skdla.com, clearchoice@skdla.com) or from internal note authors prefixed "OC-". LAB notes/emails are OUTBOUND or internal.
- "OFFICE" = the doctor / dental office (the external counterparty). Only a message genuinely FROM the office is a doctor reply.
- Each timeline line is pre-labeled LAB / OFFICE / INTERNAL as a hint, but you must use the content to correct obvious mislabels. In particular, an "inbound" email whose body is clearly OUR own wording (e.g. "As requested, we've completed the redesign", "Thank you for approving") is an echo of our own send — treat it as LAB, NOT a doctor reply.

NOISE TO IGNORE
- The history is grouped by the office, so it may contain emails about OTHER patients, "disregard / sent in error" scans, cancellations, and unrelated threads. Focus on the CURRENT design cycle for THIS case's patient (the most recent design-approval thread). Do not count attempts from unrelated patients/threads.
- Near-identical consecutive lines are duplicate scrapes of the same message — count them once.

THE 7 REASONS (outreach_reason)
- design_approval: we sent a finished design and are asking the doctor to approve it.
- design_modification: the doctor requested a change to a design we already showed; we are sending/awaiting approval of the REVISED design.
- missing_info: we need more info from the office before we can proceed.
- waiting_on_parts: we are waiting on physical parts/models/jigs from the office.
- late_approval_notice: notifying the office the case will arrive late.
- reschedule_check: checking/confirming a new delivery/reschedule date.
- scan_submission_ack: acknowledging a newly submitted scan.

ATTEMPT COUNTING (per reason)
- An attempt = one of OUR (LAB) outbound messages for that reason. The FIRST such outbound = attempt 1. Each additional LAB follow-up for the same reason with NO office reply in between = +1 (2, 3, ...). An office reply ENDS that streak.
- For each reason, report the length of the CURRENT unanswered LAB outbound streak for that reason (i.e. how many times we've reached out for it that the office has not yet answered). If the last relevant event for a reason was an office reply, or we never reached out for it, that reason = 0.
- This streak length for the open reason is what picks our next follow-up template (next = count + 1), so it must reflect un-replied follow-ups accurately.

MODIFICATION COUNT (design_modification)
- Stays 0 until a design has actually been SENT to the office at least once.
- After a design is sent, each DISTINCT doctor-requested change increments it by 1.
- A case the doctor "approved with modifications" still counts that modification (so its modification count is >= 1) even though it then leaves the tab.

APPROVAL STATE (pick exactly one)
- awaiting_review: a design (or revised design) was sent and we are still waiting on the doctor; no approval yet.
- mods_requested: the doctor's latest decision on the current design is a change request and we still owe/await approval of the redesign.
- approved_small_fix_no_resend: the doctor approved and asked only for a minor fix that does NOT require sending a new design for re-approval.
- approved: the doctor approved the design as-is.
- in_production: after approval, the case moved to production / fabrication / shipping.

SHOW IN PENDING OUTBOUND
- show_in_pending_outbound = true ONLY when the design is still awaiting the doctor (approval_state is awaiting_review or mods_requested).
- false for approved, approved_small_fix_no_resend, and in_production (the doctor is done — hide it).

OTHER FIELDS
- most_recent_unapproved_reason: the single reason the case is still open on (usually design_approval; design_modification if we're chasing approval of a revised design; missing_info/waiting_on_parts if blocked on the office). null when approved/closed.
- initial_design_in_progress: true ONLY if the case has exactly ONE communication so far (the opening note / Rx). Otherwise false.
- evidence: for the open/most-relevant reason and for the verdict, cite the timeline line's id you keyed on. Keys: each reason you gave a non-zero count, plus "verdict".

OUTPUT — return ONLY this JSON, no prose:
{
  "approval_state": "awaiting_review|mods_requested|approved_small_fix_no_resend|approved|in_production",
  "show_in_pending_outbound": true,
  "most_recent_unapproved_reason": "design_approval",
  "initial_design_in_progress": false,
  "per_reason_attempts": {
    "design_approval": 0, "design_modification": 0, "missing_info": 0,
    "waiting_on_parts": 0, "late_approval_notice": 0, "reschedule_check": 0,
    "scan_submission_ack": 0
  },
  "modification_count": 0,
  "evidence": { "design_approval": "<line id>", "verdict": "<line id>" }
}`;

function stripCaution(s: string): string {
  if (!s) return "";
  // Remove the EXTERNAL SENDER gateway banner that prefixes scraped office emails.
  return s
    .replace(/CAUTION:\s*Message\s+is\s+from\s+EXTERNAL\s+SENDER\.?\s*Please\s+practice\s+caution\s+before\s+clicking\s+links\s+and\s+check\s+the\s+email\s+address\s+before\s+replying\.?/gi, "")
    .replace(/CAUTION:\s*This\s+email\s+originated\s+from\s+outside\s+the\s+organization\.?\s*DO\s+NOT\s+reply,?\s+click\s+on\s+links,?\s+or\s+open\s+attachments[^\n]*/gi, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isLabAddr(s: string | null | undefined): boolean {
  return /@skdla\.com/i.test((s || "").trim());
}

// Best-effort side hint; Sonnet corrects obvious echoes/mislabels using the content.
function sideHint(c: any): "LAB" | "OFFICE" | "INTERNAL" {
  const from = (c.from_addr || "").toLowerCase();
  const actor = (c.actor || "").toLowerCase();
  const cp = (c.counterparty || c.to_addr || "").toLowerCase();
  if (c.medium === "note") return "INTERNAL";
  if (isLabAddr(from) || actor.startsWith("oc-")) return "LAB";
  if (c.direction === "outbound") return "LAB";
  if (c.direction === "inbound") {
    // actor/from empty but the only @skdla address is the counterparty => echo of our own send.
    if (!from && isLabAddr(cp)) return "LAB";
    return "OFFICE";
  }
  return "INTERNAL";
}

function buildTimeline(rows: any[]): { text: string; kept: number; lastAt: string | null } {
  const lines: string[] = [];
  let prevKey = "";
  let lastAt: string | null = null;
  for (const c of rows) {
    const body = stripCaution(c.body_text || "").slice(0, 360);
    const subj = (c.subject || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const side = sideHint(c);
    // Collapse exact-duplicate consecutive scrapes (same side + subject + body head).
    const key = side + "|" + subj + "|" + body.slice(0, 60);
    if (key === prevKey) continue;
    prevKey = key;
    lastAt = c.occurred_at;
    const when = (c.occurred_at || "").slice(0, 16).replace("T", " ");
    lines.push(
      `id:${c.id} | ${when} | ${side} ${c.medium || ""}` +
      (subj ? ` | subj: ${subj}` : "") +
      (body ? ` | ${body}` : "")
    );
  }
  return { text: lines.join("\n"), kept: lines.length, lastAt };
}

async function callClaude(userMsg: string, maxTokens = 1500): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.content?.[0]?.text ?? "";
}

function parseJsonish(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Normalize Sonnet's output into the shape apply_case_parse_result expects.
function normalize(raw: any, commCount: number, lastAt: string | null): any {
  const attempts: Record<string, number> = {};
  const src = (raw && typeof raw.per_reason_attempts === "object") ? raw.per_reason_attempts : {};
  for (const r of REASONS) {
    const n = Number(src[r]);
    attempts[r] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  // Modification count == design_modification attempts; keep them consistent.
  let modCount = Number(raw?.modification_count);
  if (!Number.isFinite(modCount) || modCount < 0) modCount = attempts["design_modification"] || 0;
  modCount = Math.round(modCount);
  attempts["design_modification"] = Math.max(attempts["design_modification"], modCount);

  const state = String(raw?.approval_state || "").trim();
  const validStates = new Set(["awaiting_review", "mods_requested", "approved_small_fix_no_resend", "approved", "in_production"]);
  const approval_state = validStates.has(state) ? state : "awaiting_review";
  // Derive show from state when the model is inconsistent.
  const open = approval_state === "awaiting_review" || approval_state === "mods_requested";
  let show = raw?.show_in_pending_outbound;
  show = (typeof show === "boolean") ? show : open;
  if (!open) show = false;  // approved / small-fix / production must hide

  let openReason = raw?.most_recent_unapproved_reason;
  openReason = (typeof openReason === "string" && REASONS.includes(openReason)) ? openReason : null;
  if (!open) openReason = null;
  else if (!openReason) openReason = "design_approval";

  const initial = (commCount === 1) ? true : !!raw?.initial_design_in_progress;

  return {
    approval_state,
    show_in_pending_outbound: show,
    most_recent_unapproved_reason: openReason,
    initial_design_in_progress: initial,
    per_reason_attempts: attempts,
    modification_count: modCount,
    evidence: (raw && typeof raw.evidence === "object") ? raw.evidence : {},
    model: CLAUDE_MODEL,
    comm_count: commCount,
    last_comm_at: lastAt,
  };
}

async function parseOneCase(caseNumber: string): Promise<{ ok: boolean; result?: any; error?: string }> {
  const { data: rows, error } = await sb
    .from("case_communications")
    .select("id, occurred_at, direction, medium, channel_source, from_addr, to_addr, actor, counterparty, subject, body_text")
    .eq("case_number", caseNumber)
    .order("occurred_at", { ascending: true })
    .limit(400);
  if (error) return { ok: false, error: `comm fetch: ${error.message}` };

  const commCount = rows?.length || 0;

  // Exactly one comm => initial design in progress, everything zero. No need to spend a Sonnet call.
  if (commCount <= 1) {
    const result = {
      approval_state: "awaiting_review",
      show_in_pending_outbound: true,
      most_recent_unapproved_reason: "design_approval",
      initial_design_in_progress: commCount === 1,
      per_reason_attempts: Object.fromEntries(REASONS.map((r) => [r, 0])),
      modification_count: 0,
      evidence: rows?.[0]?.id ? { verdict: rows[0].id } : {},
      model: CLAUDE_MODEL,
      comm_count: commCount,
      last_comm_at: rows?.[0]?.occurred_at ?? null,
    };
    return { ok: true, result };
  }

  // If there are more than 200 rows, keep the most recent 200 (the active cycle is recent) so the
  // prompt stays bounded; note the truncation for the model.
  let used = rows!;
  let truncated = false;
  if (used.length > 200) { used = used.slice(used.length - 200); truncated = true; }
  const { text, lastAt } = buildTimeline(used);

  const userMsg =
    `Case ${caseNumber}. Total communications on file: ${commCount}.` +
    (truncated ? ` (Only the most recent 200 are shown below.)` : ``) +
    `\n\nTimeline (oldest first):\n${text}\n\nReturn the JSON verdict.`;

  let out: string;
  try {
    out = await callClaude(userMsg);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const raw = parseJsonish(out);
  if (!raw) return { ok: false, error: "unparseable model output" };
  return { ok: true, result: normalize(raw, commCount, lastAt) };
}

serve(async (req) => {
  const log: any = { started_at: new Date().toISOString(), picked: 0, parsed: 0, hidden: 0, errors: [] };
  let batch = 15;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && Number.isFinite(Number(body.batch))) batch = Math.min(Math.max(Number(body.batch), 1), 50);
  } catch { /* default */ }

  try {
    const { data: picked, error: pickErr } = await sb.rpc("pick_cases_for_parse", { p_limit: batch });
    if (pickErr) throw pickErr;
    const caseNumbers: string[] = (picked || []).map((r: any) => (typeof r === "string" ? r : r.case_number ?? r.pick_cases_for_parse)).filter(Boolean);
    log.picked = caseNumbers.length;

    for (const caseNumber of caseNumbers) {
      try {
        const res = await parseOneCase(caseNumber);
        if (!res.ok) throw new Error(res.error || "parse failed");
        const { error: applyErr } = await sb.rpc("apply_case_parse_result", { p_case_number: caseNumber, p_result: res.result });
        if (applyErr) throw applyErr;
        log.parsed += 1;
        if (res.result.show_in_pending_outbound === false) log.hidden += 1;
      } catch (e) {
        // Transient failures (incl. an out-of-credits Anthropic key) leave the row PENDING so the
        // next tick retries it — until it has been attempted MAX_ATTEMPTS times, then it gives up
        // ('error') so a genuinely un-parseable case can't loop forever.
        const MAX_ATTEMPTS = 6;
        await sb.from("case_parse_queue").update({ status: "pending", last_error: String(e) })
          .eq("case_number", caseNumber).lt("attempts", MAX_ATTEMPTS);
        await sb.from("case_parse_queue").update({ status: "error", last_error: String(e) })
          .eq("case_number", caseNumber).gte("attempts", MAX_ATTEMPTS);
        log.errors.push({ case_number: caseNumber, error: String(e) });
      }
    }
  } catch (e) {
    log.errors.push({ stage: "outer", error: String(e) });
  }
  log.finished_at = new Date().toISOString();
  return new Response(JSON.stringify(log), { headers: { "Content-Type": "application/json" } });
});
