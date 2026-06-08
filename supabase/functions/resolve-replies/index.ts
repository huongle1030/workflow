// Supabase Edge Function: resolve-replies
// Cron-driven worker for the Pending Replies tab. For each undecided inbound doctor reply that has a
// later LAB-side communication, asks Claude Sonnet to read the doctor's reply + everything that
// happened after it and decide whether the reply was actually RESOLVED. Writes the verdict onto
// dr_outreach_replies.resolve_state; v_pending_inbound hides a card only when resolve_state='resolved'.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY")
  || Deno.env.get("anthropic_api_key")
  || Deno.env.get("anthropic_key_api"))!;
const CLAUDE_MODEL = "claude-sonnet-4-6";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const SYSTEM_PROMPT = `You determine whether a dental lab (SKDLA) has already RESOLVED one specific inbound message from a dentist's office.

You are given:
- THE OFFICE MESSAGE: one inbound message from the dentist's office (a reply to our outreach). It may ask a question, request a design change, approve or deny a design, or raise an issue.
- WHAT HAPPENED AFTER: every communication on the SAME case that occurred AFTER that message, oldest first — our internal notes, our outbound emails, logged phone calls, and any further office messages. Each line is labeled LAB (us; @skdla.com addresses or "OC-" note authors), OFFICE (the dentist's office), or INTERNAL (our own note).

Decide whether the office message has been ADDRESSED / RESOLVED. It IS resolved if the later activity shows the lab answered the question, fulfilled or actioned the request, the doctor's design was approved/closed, we called the office about it, or the matter is otherwise clearly handled. It is NOT resolved if the later activity is unrelated to the office message, is only an empty/automated note with no real content, or the office is still waiting on us.

Be conservative: if the later activity does not clearly address THIS office message, return resolved=false.

Return ONLY this JSON, no prose:
{"resolved": true, "reason": "<one short sentence>", "evidence_comm_ids": ["<line id>"]}`;

function stripCaution(s: string): string {
  if (!s) return "";
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

function sideHint(c: any): "LAB" | "OFFICE" | "INTERNAL" {
  const from = (c.from_addr || "").toLowerCase();
  const actor = (c.actor || "").toLowerCase();
  const cp = (c.counterparty || c.to_addr || "").toLowerCase();
  if (c.medium === "note") return "INTERNAL";
  if (isLabAddr(from) || actor.startsWith("oc-")) return "LAB";
  if (c.direction === "outbound") return "LAB";
  if (c.direction === "inbound") {
    if (!from && isLabAddr(cp)) return "LAB";
    return "OFFICE";
  }
  return "INTERNAL";
}

function buildTimeline(rows: any[]): string {
  const lines: string[] = [];
  let prevKey = "";
  for (const c of rows) {
    const body = stripCaution(c.body_text || "").slice(0, 360);
    const subj = (c.subject || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const side = sideHint(c);
    const key = side + "|" + subj + "|" + body.slice(0, 60);
    if (key === prevKey) continue;
    prevKey = key;
    const when = (c.occurred_at || "").slice(0, 16).replace("T", " ");
    lines.push(
      `id:${c.id} | ${when} | ${side} ${c.medium || ""}` +
      (subj ? ` | subj: ${subj}` : "") +
      (body ? ` | ${body}` : "")
    );
  }
  return lines.join("\n");
}

async function callClaude(userMsg: string, maxTokens = 600): Promise<string> {
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

// Returns { ok, resolved, reason, evidence } on a clean verdict; { ok:false, unparseable:true } when
// Claude answered but the JSON was unusable; { ok:false, error } on a fetch/API failure (retryable).
async function resolveOneReply(rep: any): Promise<any> {
  const { data: rows, error } = await sb
    .from("case_communications")
    .select("id, occurred_at, direction, medium, channel_source, from_addr, to_addr, actor, counterparty, subject, body_text")
    .eq("case_number", rep.case_number)
    .gt("occurred_at", rep.received_at)
    .order("occurred_at", { ascending: true })
    .limit(120);
  if (error) return { ok: false, error: `comm fetch: ${error.message}` };

  const used = (rows || []).slice(-80);
  const timeline = buildTimeline(used);
  const replyBody = stripCaution(rep.body_text || "").slice(0, 1500);
  const when = String(rep.received_at || "").slice(0, 16).replace("T", " ");

  const userMsg =
    `OFFICE MESSAGE (received ${when}):\n` +
    (rep.subject ? `Subject: ${rep.subject}\n` : "") +
    `${replyBody}\n\nWHAT HAPPENED AFTER (oldest first):\n${timeline || "(no later communications on file)"}\n\nReturn the JSON verdict.`;

  let out: string;
  try {
    out = await callClaude(userMsg);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const raw = parseJsonish(out);
  if (!raw || typeof raw.resolved !== "boolean") return { ok: false, unparseable: true, error: "unparseable model output" };
  return {
    ok: true,
    resolved: raw.resolved,
    reason: String(raw.reason || "").slice(0, 500),
    evidence: Array.isArray(raw.evidence_comm_ids) ? raw.evidence_comm_ids : [],
  };
}

serve(async (req) => {
  const log: any = { started_at: new Date().toISOString(), picked: 0, resolved: 0, unresolved: 0, unparseable: 0, errors: [] };
  let batch = 15;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && Number.isFinite(Number(body.batch))) batch = Math.min(Math.max(Number(body.batch), 1), 50);
  } catch { /* default */ }

  try {
    const { data: picked, error: pickErr } = await sb.rpc("pick_replies_to_resolve", { p_limit: batch });
    if (pickErr) throw pickErr;
    const replies = picked || [];
    log.picked = replies.length;

    for (const rep of replies) {
      try {
        const res = await resolveOneReply(rep);
        if (res.ok) {
          const { error: upErr } = await sb.from("dr_outreach_replies").update({
            resolve_state: res.resolved ? "resolved" : "unresolved",
            resolve_reason: res.reason,
            resolve_evidence: res.evidence,
            resolve_model: CLAUDE_MODEL,
            resolve_checked_at: new Date().toISOString(),
            resolve_checked_labcomm_count: rep.labcomm_count,
          }).eq("id", rep.reply_id);
          if (upErr) throw upErr;
          if (res.resolved) log.resolved += 1; else log.unresolved += 1;
        } else if (res.unparseable) {
          // Claude answered but JSON was unusable: soft-mark as checked so we don't re-pick it until a
          // new comm arrives. State stays NULL => the card stays VISIBLE (safe default).
          await sb.from("dr_outreach_replies").update({
            resolve_reason: "AI output unparseable; left visible",
            resolve_model: CLAUDE_MODEL,
            resolve_checked_at: new Date().toISOString(),
            resolve_checked_labcomm_count: rep.labcomm_count,
          }).eq("id", rep.reply_id);
          log.unparseable += 1;
          log.errors.push({ reply_id: rep.reply_id, error: res.error });
        } else {
          // Fetch / API failure: leave unmarked so it retries on the next run.
          throw new Error(res.error || "resolve failed");
        }
      } catch (e) {
        log.errors.push({ reply_id: rep.reply_id, error: String(e) });
      }
    }
  } catch (e) {
    log.errors.push({ stage: "outer", error: String(e) });
  }
  log.finished_at = new Date().toISOString();
  return new Response(JSON.stringify(log), { headers: { "Content-Type": "application/json" } });
});
