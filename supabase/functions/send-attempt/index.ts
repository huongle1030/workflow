// Supabase Edge Function: send-attempt
// On-demand, single-attempt sender. Called by the Pending Outbound "Approve & Send"
// button (after approve_attempt flips the draft to 'queued') so an approved email goes
// out in seconds instead of waiting for the 5-min dr-outreach-tick cron.
//
// Safety: it ONLY sends an attempt whose status is 'queued' (i.e. already approved), and
// it atomically claims the row (queued -> sent) before calling Graph, so a double-trigger
// or two coordinators can't send the same attempt twice. Mirrors dr-outreach-tick's step-0
// send logic + attachment handling (job-aid PDF for scan_submission_ack, RX otherwise).
//
// Project secrets used (shared with dr-outreach-tick): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER_USER_ID.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_TENANT_ID = Deno.env.get("MS_TENANT_ID")!;
const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const MS_SENDER_USER_ID = Deno.env.get("MS_SENDER_USER_ID") || Deno.env.get("MS_SENDER_UPN")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
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

// Static job-aid attachment for scan-submission acks (case-less), from the private
// 'outreach-assets' bucket via the service-role client. Cached for the warm instance.
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let attemptId: string | null = null;
  let bodyCc: string[] | null = null;
  try {
    const reqBody = await req.json();
    attemptId = reqBody?.attempt_id ?? null;
    if (Array.isArray(reqBody?.cc)) bodyCc = reqBody.cc.filter((a: unknown): a is string => typeof a === "string" && a.length > 0);
  } catch { /* no body */ }
  if (!attemptId) return json({ error: "attempt_id required" }, 400);

  // Atomically claim the row: only one caller can flip queued -> sent. If it isn't
  // 'queued' (not approved, already sent, or already claimed), do nothing.
  const sentAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await sb
    .from("dr_outreach_attempts")
    .update({ status: "sent", sent_at: sentAt })
    .eq("id", attemptId)
    .eq("status", "queued")
    .select("id, queue_id, to_email, subject, body_html, sender_mailbox, cc_emails")
    .maybeSingle();
  if (claimErr) return json({ error: `claim failed: ${claimErr.message}` }, 500);
  if (!claimed) {
    const { data: cur } = await sb.from("dr_outreach_attempts").select("status").eq("id", attemptId).maybeSingle();
    return json({ skipped: true, reason: "not in 'queued' state", status: cur?.status ?? "unknown" });
  }

  try {
    const { data: q } = await sb.from("dr_outreach_queue").select("case_number, reason").eq("id", claimed.queue_id).single();
    let autoAttachments: GraphAttachment[] | null = null;
    if (q?.reason === "scan_submission_ack") {
      // The Aspen Labs job-aid PDF only belongs on @aspendental.com acks (the templated
      // ones). Non-Aspen scan submissions are coordinator-written and carry no job aid.
      if (/@aspendental\.com\s*$/i.test(claimed.to_email || "")) {
        const jobAid = await getJobAidAttachment();
        if (jobAid) autoAttachments = [jobAid];
      }
    } else if (q?.case_number) {
      const rx = await getRxAttachment(q.case_number);
      if (rx) autoAttachments = [rx];
    }
    // Merge in coordinator-uploaded attachments (inline if small, upload session if large).
    const { inline, large } = await buildAttachmentSets(autoAttachments, claimed.id);
    // CC: prefer what's persisted on the row (set via set_attempt_cc before approve); fall
    // back to the cc passed inline on this request. Persist the inline cc so the audit/row
    // reflects what was actually sent.
    const cc = (Array.isArray(claimed.cc_emails) && claimed.cc_emails.length) ? claimed.cc_emails : bodyCc;
    if ((!claimed.cc_emails || !claimed.cc_emails.length) && cc && cc.length) {
      await sb.from("dr_outreach_attempts").update({ cc_emails: cc }).eq("id", claimed.id);
    }
    const send = await graphSendMail(claimed.to_email, claimed.subject, claimed.body_html, q?.case_number ?? "approved", claimed.sender_mailbox, inline, large, cc);
    await sb.from("dr_outreach_attempts").update({ graph_message_id: send.graph_message_id, graph_conversation_id: send.graph_conversation_id }).eq("id", claimed.id);
    await sb.rpc("record_outbox_outbound", { p_case_number: q?.case_number, p_account_no: null, p_attempt_id: claimed.id, p_to_addr: claimed.to_email, p_subject: claimed.subject, p_body_html: claimed.body_html, p_graph_msg_id: send.graph_message_id });
    return json({ sent: true, attempt_id: claimed.id, to: claimed.to_email, sender: send.sender_used, inline_attachments: inline?.length ?? 0, large_attachments: large?.length ?? 0 });
  } catch (e) {
    // Roll the claim back to 'failed' so it surfaces (and the cron won't retry a 'sent' row).
    await sb.from("dr_outreach_attempts").update({ status: "failed", sent_at: null, error: String(e) }).eq("id", attemptId);
    return json({ error: String(e), attempt_id: attemptId }, 500);
  }
});
