// Supabase Edge Function: dr-outreach-tick
// Cron-driven worker. On each tick:
//   0) Send any attempts coordinators have approved (status='queued') via Graph
//   1) enqueue_due_outreach() to pick up any newly-eligible cases
//   2) pick_due_for_send() to grab a batch
//   3) For each new due row:
//      a) AUTO-SUMMARIZE: if needs_case_summaries() flags missing RX or
//         missing-info summaries, call Claude to generate them and stash
//         in case_rx_summaries / case_missing_info_summaries.
//      b) Either compose_pending_attempt() (if gate on) or render+send (gate off).
//
// Schedule from pg_cron (see README.md): every 15 minutes is a sane default.
// Required secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   MS_TENANT_ID
//   MS_CLIENT_ID
//   MS_CLIENT_SECRET
//   MS_SENDER_USER_ID      (e.g. implants@skdla.com - the shared mailbox UPN or object id)
//   ANTHROPIC_API_KEY      (Claude Haiku for RX + missing-info summarization)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_TENANT_ID = Deno.env.get("MS_TENANT_ID")!;
const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const MS_SENDER_USER_ID = Deno.env.get("MS_SENDER_USER_ID") || Deno.env.get("MS_SENDER_UPN")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY")
  || Deno.env.get("anthropic_api_key")
  || Deno.env.get("anthropic_key_api"))!;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function stripDashes(s: string): string {
  return (s ?? "").replace(/–/g, "-").replace(/—/g, "-");
}

async function callClaude(prompt: string, maxTokens = 800): Promise<string> {
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
      messages: [{ role: "user", content: prompt }],
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

async function fetchSynonyms(): Promise<{synonym:string; canonical_product:string; needs_verification?:boolean}[]> {
  try {
    const { data } = await sb.from("product_synonyms").select("synonym, canonical_product, needs_verification");
    return data ?? [];
  } catch { return []; }
}

function synonymsBlock(rows: any[]): string {
  if (!rows?.length) return "";
  return "\n\nKnown ambiguous terms (if any appear in the RX/note, flag inline with a verify hint):\n" +
    rows.map(r => `- "${r.synonym}" -> ${r.canonical_product}${r.needs_verification ? " [needs verification]" : ""}`).join("\n");
}

async function summarizeRx(rawText: string, syns: any[] = []): Promise<{ short: string; bullets: string } | null> {
  const prompt = `Summarize this RX into JSON {issue_summary_short, bullets_html}. RX:\n"""\n${rawText.slice(0, 6000)}\n"""${synonymsBlock(syns)}\nReturn only JSON.`;
  try {
    const out = await callClaude(prompt, 1200);
    const parsed = parseJsonish(out);
    if (!parsed?.issue_summary_short || !parsed?.bullets_html) return null;
    return { short: stripDashes(parsed.issue_summary_short).slice(0, 200), bullets: stripDashes(parsed.bullets_html) };
  } catch (e) { console.error("summarizeRx failed:", e); return null; }
}

async function summarizeMissingInfo(rawText: string, syns: any[] = []): Promise<{ short: string; bullets: string } | null> {
  const prompt = `Summarize what's missing from this case into JSON {issue_summary_short, bullets_html}. Note:\n"""\n${rawText.slice(0, 6000)}\n"""${synonymsBlock(syns)}\nReturn only JSON.`;
  try {
    const out = await callClaude(prompt, 700);
    const parsed = parseJsonish(out);
    if (!parsed?.issue_summary_short || !parsed?.bullets_html) return null;
    return { short: stripDashes(parsed.issue_summary_short).slice(0, 200), bullets: stripDashes(parsed.bullets_html) };
  } catch (e) { console.error("summarizeMissingInfo failed:", e); return null; }
}

async function ensureCaseSummaries(caseNumber: string, reason: string): Promise<{ rx?: boolean; missing?: boolean }> {
  const { data: chk, error } = await sb.rpc("needs_case_summaries", { p_case_number: caseNumber, p_reason: reason });
  if (error || !chk) return {};
  const result: { rx?: boolean; missing?: boolean } = {};
  const syns = (chk.needs_rx || chk.needs_missing) ? await fetchSynonyms() : [];
  if (chk.needs_rx) {
    const summary = await summarizeRx(chk.rx_raw, syns);
    if (summary) {
      await sb.from("case_rx_summaries").upsert({ case_number: caseNumber, raw_text: String(chk.rx_raw).slice(0, 50000), bullets_html: summary.bullets, issue_summary_short: summary.short, ai_model: CLAUDE_MODEL, ai_summary: summary.short });
      result.rx = true;
    }
  }
  if (chk.needs_missing) {
    const summary = await summarizeMissingInfo(chk.missing_raw, syns);
    if (summary) {
      await sb.from("case_missing_info_summaries").upsert({ case_number: caseNumber, raw_text: String(chk.missing_raw).slice(0, 50000), bullets_html: summary.bullets, issue_summary_short: summary.short, ai_model: CLAUDE_MODEL, ai_summary: summary.short });
      result.missing = true;
    }
  }
  return result;
}

let tokenCache: { token: string; exp: number } | null = null;
async function graphToken(): Promise<string> {
  if (tokenCache && tokenCache.exp - 60 > Math.floor(Date.now() / 1000)) return tokenCache.token;
  const body = new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Graph token failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Math.floor(Date.now() / 1000) + j.expires_in };
  return tokenCache.token;
}

type GraphAttachment = { "@odata.type": string; name: string; contentType: string; contentBytes: string; };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function htmlBulletsToText(html: string): string[] {
  if (!html) return [];
  const lines: string[] = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const raw = m[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
    if (raw) lines.push(raw);
  }
  return lines;
}

async function generateRxSummaryPdf(caseNumber: string, shortSummary: string | null, bulletsHtml: string | null): Promise<Uint8Array | null> {
  try {
    const mod = await import("npm:pdf-lib@1.17.1");
    const { PDFDocument, StandardFonts, rgb } = mod;
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font   = await pdf.embedFont(StandardFonts.Helvetica);
    const bold   = await pdf.embedFont(StandardFonts.HelveticaBold);
    const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
    const NAVY = rgb(0.020, 0.125, 0.188);
    const GOLD = rgb(0.702, 0.639, 0.412);
    const SLATE = rgb(0.420, 0.467, 0.522);
    const TEXT = rgb(0.122, 0.137, 0.157);
    let y = 740;
    page.drawRectangle({ x: 0, y: 760, width: 612, height: 32, color: NAVY });
    page.drawText("SPECTRUM KILLIAN DENTAL LAB ALLIANCE", { x: 40, y: 770, size: 11, font: bold, color: rgb(1, 1, 1) });
    page.drawText("RX SUMMARY", { x: 510, y: 770, size: 11, font: bold, color: GOLD });
    page.drawText("Case " + caseNumber, { x: 40, y, size: 22, font: bold, color: NAVY });
    y -= 26;
    if (shortSummary) { page.drawText(shortSummary.slice(0, 90), { x: 40, y, size: 12, font: italic, color: SLATE }); y -= 22; } else { y -= 8; }
    page.drawRectangle({ x: 40, y, width: 532, height: 2, color: GOLD });
    y -= 22;
    page.drawText("PRESCRIBED", { x: 40, y, size: 9, font: bold, color: SLATE });
    y -= 16;
    const bullets = htmlBulletsToText(bulletsHtml || "");
    if (!bullets.length) {
      page.drawText("(No RX summary on file for this case.)", { x: 40, y, size: 11, font: italic, color: SLATE });
      y -= 16;
    } else {
      const maxChars = 92;
      for (const b of bullets) {
        const words = b.split(" ");
        let line = "-  ";
        for (const w of words) {
          if ((line + w).length > maxChars) {
            page.drawText(line, { x: 40, y, size: 10.5, font, color: TEXT });
            y -= 14;
            line = "    " + w + " ";
            if (y < 80) break;
          } else { line += w + " "; }
        }
        if (y < 80) break;
        if (line.trim()) { page.drawText(line, { x: 40, y, size: 10.5, font, color: TEXT }); y -= 16; }
      }
    }
    page.drawRectangle({ x: 40, y: 60, width: 532, height: 1, color: SLATE });
    const footer = "Auto-generated summary of the RX on file with Spectrum Killian. Refer to the original RX in our system for the authoritative version.";
    page.drawText(footer.slice(0, 110), { x: 40, y: 46, size: 8.5, font: italic, color: SLATE });
    page.drawText(footer.slice(110, 220), { x: 40, y: 34, size: 8.5, font: italic, color: SLATE });
    page.drawText("Generated " + new Date().toISOString().slice(0, 10), { x: 40, y: 20, size: 8, font, color: SLATE });
    return await pdf.save();
  } catch (e) { console.error("generateRxSummaryPdf failed:", e); return null; }
}

async function getRxAttachment(caseNumber: string): Promise<GraphAttachment | null> {
  try {
    const { data: row } = await sb.from("case_rx_attachments").select("storage_path, mime_type, source_filename").eq("case_number", caseNumber).maybeSingle();
    if (row?.storage_path) {
      const path = row.storage_path.replace(/^case-rx\//, "");
      const { data: blob, error } = await sb.storage.from("case-rx").download(path);
      if (!error && blob) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const ext = (row.mime_type || "application/pdf").includes("pdf") ? "pdf" : "img";
        return { "@odata.type": "#microsoft.graph.fileAttachment", name: row.source_filename || `RX_${caseNumber}.${ext}`, contentType: row.mime_type || "application/pdf", contentBytes: bytesToBase64(buf) };
      }
    }
  } catch (e) { console.error("case_rx_attachments lookup failed:", e); }
  try {
    const { data: sum } = await sb.from("case_rx_summaries").select("issue_summary_short, bullets_html").eq("case_number", caseNumber).maybeSingle();
    if (sum?.bullets_html) {
      const pdfBytes = await generateRxSummaryPdf(caseNumber, sum.issue_summary_short ?? null, sum.bullets_html);
      if (pdfBytes) {
        return { "@odata.type": "#microsoft.graph.fileAttachment", name: `RX_Summary_${caseNumber}.pdf`, contentType: "application/pdf", contentBytes: bytesToBase64(pdfBytes) };
      }
    }
  } catch (e) { console.error("case_rx_summaries lookup failed:", e); }
  return null;
}

// Static job-aid attachment for scan-submission acks (case-less). The PDF lives in the
// private 'outreach-assets' bucket; the service-role client downloads it on each send.
// Cached in memory for the life of the (warm) function instance to avoid re-downloading
// ~940KB per email in a batch.
const JOB_AID_BUCKET = "outreach-assets";
const JOB_AID_PATH = "onix-fixed-ordering-aspenlabs.pdf";
const JOB_AID_FILENAME = "Onix Fixed ordering in AspenLabs.pdf";
let jobAidCache: GraphAttachment | null = null;
async function getJobAidAttachment(): Promise<GraphAttachment | null> {
  if (jobAidCache) return jobAidCache;
  try {
    const { data: blob, error } = await sb.storage.from(JOB_AID_BUCKET).download(JOB_AID_PATH);
    if (error || !blob) { console.error("job-aid download failed:", error); return null; }
    const buf = new Uint8Array(await blob.arrayBuffer());
    jobAidCache = { "@odata.type": "#microsoft.graph.fileAttachment", name: JOB_AID_FILENAME, contentType: "application/pdf", contentBytes: bytesToBase64(buf) };
    return jobAidCache;
  } catch (e) { console.error("getJobAidAttachment failed:", e); return null; }
}

type LargeAttachment = { name: string; contentType: string; size: number; bucket: string; path: string };

// Coordinator-uploaded attachments for an attempt (from dr_outreach_attempt_attachments).
async function getUserAttachments(attemptId: string): Promise<any[]> {
  try {
    const { data } = await sb.from("dr_outreach_attempt_attachments").select("*").eq("attempt_id", attemptId);
    return data ?? [];
  } catch (e) { console.error("getUserAttachments failed:", e); return []; }
}

async function downloadAsGraphAttachment(ua: any): Promise<GraphAttachment | null> {
  try {
    const { data: blob, error } = await sb.storage.from(ua.storage_bucket || "outreach-attachments").download(ua.storage_path);
    if (error || !blob) { console.error("attachment download failed:", error); return null; }
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { "@odata.type": "#microsoft.graph.fileAttachment", name: ua.filename, contentType: ua.mime_type || "application/pdf", contentBytes: bytesToBase64(buf) };
  } catch (e) { console.error("downloadAsGraphAttachment failed:", e); return null; }
}

// Split an attempt's user attachments into small (inline base64, kept under the Graph ~4MB
// create-message budget alongside the auto job-aid/RX attachment) and large (streamed via an
// upload session). autoAttachments are the already-computed job-aid/RX attachments.
const INLINE_MAX = 3 * 1024 * 1024;
async function buildAttachmentSets(autoAttachments: GraphAttachment[] | null, attemptId: string): Promise<{ inline: GraphAttachment[] | null; large: LargeAttachment[] | null }> {
  const inline: GraphAttachment[] = autoAttachments ? [...autoAttachments] : [];
  let inlineBudget = 0;
  for (const a of inline) inlineBudget += a.contentBytes ? Math.floor(a.contentBytes.length * 0.75) : 0;
  const large: LargeAttachment[] = [];
  const toLarge = (ua: any): LargeAttachment => ({ name: ua.filename, contentType: ua.mime_type || "application/pdf", size: Number(ua.size_bytes ?? 0), bucket: ua.storage_bucket || "outreach-attachments", path: ua.storage_path });
  for (const ua of await getUserAttachments(attemptId)) {
    const sz = Number(ua.size_bytes ?? 0);
    if (sz <= INLINE_MAX && inlineBudget + sz <= INLINE_MAX) {
      const a = await downloadAsGraphAttachment(ua);
      if (a) { inline.push(a); inlineBudget += sz; } else { large.push(toLarge(ua)); }
    } else {
      large.push(toLarge(ua));
    }
  }
  return { inline: inline.length ? inline : null, large: large.length ? large : null };
}

// Attach a large file to an already-created draft via a Graph upload session, streaming the
// bytes from storage in 320KiB-multiple chunks so edge memory stays bounded regardless of size.
async function uploadLargeAttachment(token: string, mailbox: string, messageId: string, att: LargeAttachment) {
  const sessRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments/createUploadSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: att.name, size: att.size, contentType: att.contentType } }),
  });
  if (!sessRes.ok) throw new Error(`createUploadSession failed: ${sessRes.status} ${await sessRes.text()}`);
  const { uploadUrl } = await sessRes.json();
  const CHUNK = 327680 * 12; // 3.75 MB (multiple of 320 KiB, required by Graph for non-final chunks)
  const objUrl = `${SUPABASE_URL}/storage/v1/object/${att.bucket}/${att.path.split("/").map(encodeURIComponent).join("/")}`;
  let start = 0;
  while (start < att.size) {
    const end = Math.min(start + CHUNK, att.size) - 1;
    const rangeRes = await fetch(objUrl, { headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, Range: `bytes=${start}-${end}` } });
    if (rangeRes.status !== 206 && rangeRes.status !== 200) throw new Error(`storage range fetch failed: ${rangeRes.status} ${await rangeRes.text()}`);
    const buf = new Uint8Array(await rangeRes.arrayBuffer());
    if (buf.length === 0) throw new Error("storage range returned 0 bytes");
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(buf.length), "Content-Range": `bytes ${start}-${start + buf.length - 1}/${att.size}` },
      body: buf,
    });
    if (![200, 201, 202].includes(putRes.status)) throw new Error(`chunk upload failed: ${putRes.status} ${await putRes.text()}`);
    start += buf.length;
  }
}

async function graphSendMail(to: string, subject: string, html: string, caseNumber: string, sender?: string | null, attachments?: GraphAttachment[] | null, largeAttachments?: LargeAttachment[] | null, cc?: string[] | null) {
  const token = await graphToken();
  const fromMailbox = sender && sender.length > 3 ? sender : MS_SENDER_USER_ID;
  const tag = `[SKDLA-${caseNumber}]`;
  const taggedSubject = subject.includes(tag) ? subject : `${subject} ${tag}`;
  const messageBody: Record<string, unknown> = {
    subject: taggedSubject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    singleValueExtendedProperties: [{ id: "String {66f5a359-4659-4830-9070-00047ec6ac6e} Name SKDLACaseNumber", value: caseNumber }],
  };
  if (cc && cc.length) messageBody.ccRecipients = cc.map((a) => ({ emailAddress: { address: a } }));
  if (attachments && attachments.length) messageBody.attachments = attachments;
  const draftRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromMailbox)}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(messageBody) });
  if (!draftRes.ok) throw new Error(`Graph draft failed (mailbox=${fromMailbox}): ${draftRes.status} ${await draftRes.text()}`);
  const draft = await draftRes.json();
  // Large user attachments go on the draft via upload sessions before we send it.
  for (const la of largeAttachments ?? []) {
    await uploadLargeAttachment(token, fromMailbox, draft.id, la);
  }
  const sendRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromMailbox)}/messages/${draft.id}/send`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!sendRes.ok) throw new Error(`Graph send failed (mailbox=${fromMailbox}): ${sendRes.status} ${await sendRes.text()}`);
  return { graph_message_id: draft.id, graph_conversation_id: draft.conversationId, tagged_subject: taggedSubject, sender_used: fromMailbox };
}

function render(template: string, ctx: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx[k] ?? "").toString());
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "TBD";
  try { return new Date(d).toLocaleDateString("en-US"); } catch { return d; }
}

serve(async (_req) => {
  const log: any = { started_at: new Date().toISOString(), enqueued: 0, sent: 0, gated: 0, errors: [] };
  try {
    const { data: approvedAttempts } = await sb.from("dr_outreach_attempts").select("id, queue_id, to_email, subject, body_html, sender_mailbox, cc_emails").eq("status", "queued").limit(50);
    for (const a of approvedAttempts ?? []) {
      try {
        const { data: q } = await sb.from("dr_outreach_queue").select("case_number, reason").eq("id", a.queue_id).single();
        // Scan-submission acks are case-less; @aspendental.com acks carry the Aspen Labs
        // job-aid PDF instead of an RX attachment. Non-Aspen scan submissions are
        // coordinator-written and carry no auto attachment. Everything else gets the RX.
        let autoAttachments: GraphAttachment[] | null = null;
        if (q?.reason === "scan_submission_ack") {
          if (/@aspendental\.com\s*$/i.test(a.to_email || "")) {
            const jobAid = await getJobAidAttachment();
            if (jobAid) autoAttachments = [jobAid];
          }
        } else if (q?.case_number) {
          const rxAttachment = await getRxAttachment(q.case_number);
          if (rxAttachment) autoAttachments = [rxAttachment];
        }
        // Merge in coordinator-uploaded attachments (inline if small, upload session if large).
        const { inline, large } = await buildAttachmentSets(autoAttachments, a.id);
        const send = await graphSendMail(a.to_email, a.subject, a.body_html, q?.case_number ?? "approved", a.sender_mailbox, inline, large, a.cc_emails);
        await sb.from("dr_outreach_attempts").update({ status: "sent", graph_message_id: send.graph_message_id, graph_conversation_id: send.graph_conversation_id, sent_at: new Date().toISOString() }).eq("id", a.id);
        await sb.rpc("record_outbox_outbound", { p_case_number: q?.case_number, p_account_no: null, p_attempt_id: a.id, p_to_addr: a.to_email, p_subject: a.subject, p_body_html: a.body_html, p_graph_msg_id: send.graph_message_id });
        log.sent += 1;
      } catch (e) {
        await sb.from("dr_outreach_attempts").update({ status: "failed", error: String(e) }).eq("id", a.id);
        log.errors.push({ attempt_id: a.id, error: String(e) });
      }
    }
    const { data: enq, error: enqErr } = await sb.rpc("enqueue_due_outreach");
    if (enqErr) throw enqErr;
    log.enqueued = enq;
    const { data: dueRows, error: dueErr } = await sb.rpc("pick_due_for_send", { p_limit: 50 });
    if (dueErr) throw dueErr;
    const { data: settingsRows } = await sb.from("dr_outreach_settings").select("reason, requires_approval_before_send");
    const gateByReason: Record<string, boolean> = {};
    for (const s of settingsRows ?? []) gateByReason[s.reason] = s.requires_approval_before_send !== false;
    for (const r of dueRows ?? []) {
      const attemptNumber = (r.attempt_count ?? 0) + 1;
      const { data: tmpl, error: tErr } = await sb.from("dr_outreach_templates").select("id, subject, body_html, is_escalation").eq("reason", r.reason).eq("attempt_number", attemptNumber).single();
      if (tErr) { log.errors.push({ queue_id: r.queue_id, error: `template lookup: ${tErr.message}` }); continue; }
      const recipient = tmpl.is_escalation ? r.account_manager : r.dr_email;
      if (!recipient) { log.errors.push({ queue_id: r.queue_id, error: "no recipient" }); continue; }
      const exocadBlock = r.exocad_viewer_url ? `<p><strong>View the design:</strong> <a href="${r.exocad_viewer_url}">${r.exocad_viewer_url}</a></p>` : "";
      const rxBullets = `<p><em>Please refer to your original RX submission for the full list of instructions.</em></p>`;
      const signature = Deno.env.get("OUTREACH_SIGNATURE") ?? `Spectrum Killian<br/><a href="mailto:implants@skdla.com">implants@skdla.com</a>`;
      const ctx = { dr_pref: r.dr_pref ?? "Dr.", dr_first_name: r.dr_first_name ?? "", dr_last_name: r.dr_last_name ?? (r.practice_name ?? ""), practice_name: r.practice_name ?? "", case_number: r.case_number, patient_name: r.patient_name ?? "your patient", hold_reason: r.hold_reason ?? "", current_step: r.current_step ?? "", doctor_due_date: fmtDate(r.doctor_due_date), account_manager: r.account_manager ?? "your account manager", exocad_link: exocadBlock, rx_bullets: rxBullets, signature: signature };
      const subject = render(tmpl.subject, ctx);
      const body    = render(tmpl.body_html, ctx);
      try {
        const made = await ensureCaseSummaries(r.case_number, r.reason);
        if (made.rx || made.missing) (log.ai_summaries = log.ai_summaries || []).push({ case_number: r.case_number, rx: !!made.rx, missing: !!made.missing });
      } catch (e) { log.errors.push({ stage: "summarize", case_number: r.case_number, error: String(e) }); }
      if (gateByReason[r.reason]) {
        await sb.rpc("compose_pending_attempt", { p_queue_id: r.queue_id, p_attempt_number: attemptNumber });
        log.gated += 1;
        continue;
      }
      try {
        const { data: senderRow } = await sb.rpc("pick_sender_mailbox", { p_case_number: r.case_number });
        const rxAttachment = await getRxAttachment(r.case_number);
        const sendRes = await graphSendMail(recipient, subject, body, r.case_number, senderRow, rxAttachment ? [rxAttachment] : null);
        if (attemptNumber === 4) await sb.rpc("mark_escalation_target", { p_queue_id: r.queue_id });
        await sb.rpc("record_attempt", { p_queue_id: r.queue_id, p_template_id: tmpl.id, p_to_email: recipient, p_subject: sendRes.tagged_subject, p_body_html: body, p_graph_message_id: sendRes.graph_message_id, p_graph_conversation_id: sendRes.graph_conversation_id });
        const { data: lastAttempt } = await sb.from("dr_outreach_attempts").select("id").eq("queue_id", r.queue_id).order("created_at", { ascending: false }).limit(1).single();
        await sb.rpc("record_outbox_outbound", { p_case_number: r.case_number, p_account_no: r.account_number, p_attempt_id: lastAttempt?.id ?? null, p_to_addr: recipient, p_subject: sendRes.tagged_subject, p_body_html: body, p_graph_msg_id: sendRes.graph_message_id });
        log.sent += 1;
      } catch (sendErr) {
        await sb.from("dr_outreach_attempts").insert({ queue_id: r.queue_id, attempt_number: attemptNumber, template_id: tmpl.id, to_email: recipient, subject, body_html: body, status: "failed", error: String(sendErr) });
        log.errors.push({ queue_id: r.queue_id, error: String(sendErr) });
      }
    }
  } catch (e) { log.errors.push({ stage: "outer", error: String(e) }); }
  log.finished_at = new Date().toISOString();
  return new Response(JSON.stringify(log), { headers: { "Content-Type": "application/json" } });
});
