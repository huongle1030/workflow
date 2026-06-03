// Supabase Edge Function: classify-scan-submission
//
// Scans new inbound replies for "a doctor submitting a patient's iOS / intraoral scan"
// and, when found, composes a templated acknowledgment draft (compose_scan_ack) that
// lands in the Pending Outbound tab for a coordinator to approve. It never sends — the
// existing approve_attempt → Graph-sender path does that after human review.
//
// Patterned on suggest-case-number (stripQuotedReply, Claude Haiku, batched cron tick,
// idempotent scan_ack_at stamp). Env reuses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY. Driven by a pg_cron tick posting {"batch":25} every 10 min.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY")
  || Deno.env.get("anthropic_api_key")
  || Deno.env.get("anthropic_key_api"))!;

const MODEL = "claude-haiku-4-5-20251001";
const CONFIDENCE_THRESHOLD = 0.7;   // tune after reviewing a sample

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Strip the quoted prior email from a reply body so Claude reasons over only the new
// text the doctor wrote. (Mirrors suggest-case-number.stripQuotedReply.)
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

const SYSTEM = `You triage inbound emails to a dental lab. Decide whether THIS email is a
dental provider (doctor / office) SUBMITTING a patient's iOS / intraoral scan — i.e. sending
in a new scan/STL/digital impression so the lab can start or set up a case.

Treat as a scan submission (is_scan_submission = true): an email whose purpose is to hand off
a patient scan / intraoral scan / digital impression / STL files for a new or existing patient,
typically with the files attached or shared via a link.

Treat as NOT a scan submission (false): design-approval replies, modification requests, pricing
or product questions, scheduling, shipping/status questions, general correspondence, or anything
that isn't the provider sending in a scan.

Reply with ONLY a strict JSON object (no prose, no code fence):
{"is_scan_submission": true|false, "confidence": 0.0-1.0, "reasoning": "<one sentence>"}`;

interface Verdict {
  is_scan_submission: boolean;
  confidence: number;
  reasoning: string;
}

async function classify(reply: { subject: string; body_text: string; from_email: string }): Promise<Verdict | null> {
  const replyOnly = stripQuotedReply(reply.body_text || "");
  const userText =
    `Inbound email.\nFrom: ${reply.from_email || "(unknown)"}\nSubject: ${reply.subject || "(none)"}\n\n`
    + `Body (quoted thread already stripped):\n${replyOnly.slice(0, 6000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const text = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]);
    return {
      is_scan_submission: p.is_scan_submission === true,
      confidence: Number(p.confidence ?? 0),
      reasoning: String(p.reasoning ?? ""),
    };
  } catch {
    return null;
  }
}

serve(async (req) => {
  const log: any = { started_at: new Date().toISOString(), processed: 0, drafted: 0, no_account: 0, not_submission: 0, failed: 0, errors: [] };
  let batch = 25;
  try {
    const b = await req.json();
    if (Number.isFinite(b?.batch)) batch = Math.max(1, Math.min(100, b.batch));
  } catch { /* no body */ }

  try {
    const { data: rows, error } = await sb.from("dr_outreach_replies")
      .select("id, subject, body_text, from_email")
      .is("scan_ack_at", null)
      .order("received_at", { ascending: false })
      .limit(batch);
    if (error) throw error;

    for (const r of rows || []) {
      log.processed++;
      try {
        const fromEmail = (r as any).from_email || "";
        // Internal staff mail is never a doctor scan submission — skip (no Claude call),
        // just stamp it processed so it leaves the pickup backlog.
        if (/@skdla\.com\s*$/i.test(fromEmail)) {
          log.not_submission++;
          await sb.from("dr_outreach_replies").update({
            scan_ack_at: new Date().toISOString(),
            scan_is_submission: false,
            scan_ack_reasoning: "internal @skdla.com sender — skipped",
            scan_ack_model: MODEL,
          }).eq("id", (r as any).id);
          continue;
        }

        const v = await classify(r as any);
        const isSub = !!v?.is_scan_submission;
        let attemptId: string | null = null;

        // Only compose a draft for a confident scan submission with a sender to reply to.
        if (v && isSub && v.confidence >= CONFIDENCE_THRESHOLD && (r as any).from_email) {
          const { data: attempt, error: rpcErr } = await sb.rpc("compose_scan_ack", { p_reply_id: (r as any).id });
          if (rpcErr) {
            // Most common: no Accounts row matches the sender email. Record + move on.
            log.no_account++;
            log.errors.push({ id: (r as any).id, error: rpcErr.message });
          } else {
            attemptId = (attempt as any)?.id ?? null;
            log.drafted++;
          }
        } else if (!isSub) {
          log.not_submission++;
        }

        const { error: upErr } = await sb.from("dr_outreach_replies").update({
          scan_ack_at:         new Date().toISOString(),
          scan_is_submission:  v ? isSub : null,
          scan_ack_confidence: v?.confidence ?? null,
          scan_ack_reasoning:  v?.reasoning ?? null,
          scan_ack_model:      MODEL,
          scan_ack_attempt_id: attemptId,
        }).eq("id", (r as any).id);
        if (upErr) { log.errors.push({ id: (r as any).id, error: upErr.message }); log.failed++; }
      } catch (e) {
        // Still stamp scan_ack_at so a transient error doesn't wedge the row forever.
        await sb.from("dr_outreach_replies").update({
          scan_ack_at: new Date().toISOString(),
          scan_ack_model: MODEL,
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
