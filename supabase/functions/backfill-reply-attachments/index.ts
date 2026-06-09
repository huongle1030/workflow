// Supabase Edge Function: backfill-reply-attachments
//
// One-time (re-runnable) backfill for dr_outreach_replies.attachments on emails that were
// ingested BEFORE the dr-outreach-reply webhook started capturing attachment metadata.
//
// We store graph_message_id per reply but NOT which mailbox it came from, and Graph message
// IDs are per-mailbox. So for each row we try the watched shared mailboxes in turn; the first
// that returns the message's attachments wins. Inline images (signatures/logos) are dropped.
//
// A row is only written when a mailbox actually returns the message — if the message is gone
// (moved/deleted) we leave attachments = NULL ("not captured") so it isn't misrepresented as
// "no attachments". That means unresolved rows are re-picked on the next run; re-run until the
// "updated" count hits 0, then stop.
//
// Body params (all optional): { "batch": 50, "scanSubsOnly": true }
//   scanSubsOnly (default true) restricts to rows already flagged scan_is_submission = true —
//   i.e. exactly what the Scan Submission card surfaces. Pass false to backfill every inbound
//   reply that still has a graph_message_id.
//
// Env reuses the same Graph client-credentials as dr-outreach-reply.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_TENANT_ID = Deno.env.get("MS_TENANT_ID")!;
const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const MS_SENDER_USER_ID = Deno.env.get("MS_SENDER_USER_ID") || Deno.env.get("MS_SENDER_UPN")!;

// Same watched shared mailboxes as outreach-register-webhook. De-duped (MS_SENDER may equal one).
const MAILBOXES = Array.from(new Set([
  MS_SENDER_USER_ID,
  "implants@skdla.com",
  "clearchoice@skdla.com",
].filter(Boolean)));

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let tokenCache: { token: string; exp: number } | null = null;
async function graphToken(): Promise<string> {
  if (tokenCache && tokenCache.exp - 60 > Math.floor(Date.now() / 1000)) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
  );
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Math.floor(Date.now() / 1000) + j.expires_in };
  return tokenCache.token;
}

interface Attachment { name: string; contentType: string | null; size: number | null }

// Returns the attachment list for a message in one mailbox, or null when the message isn't in
// that mailbox (404) or the call fails. [] means the message was found and has no (non-inline)
// attachments.
async function attachmentsFromMailbox(token: string, mailbox: string, messageId: string): Promise<Attachment[] | null> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments?$select=name,contentType,size,isInline`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;   // 404 = not in this mailbox; try the next one
  const j = await res.json();
  return (j.value ?? [])
    .filter((a: any) => a?.isInline !== true && a?.name)
    .map((a: any) => ({
      name: String(a.name),
      contentType: a.contentType ?? null,
      size: typeof a.size === "number" ? a.size : null,
    }));
}

serve(async (req) => {
  const log: any = { started_at: new Date().toISOString(), processed: 0, updated: 0, not_found: 0, failed: 0, errors: [] };
  let batch = 50;
  let scanSubsOnly = true;
  try {
    const b = await req.json();
    if (Number.isFinite(b?.batch)) batch = Math.max(1, Math.min(200, b.batch));
    if (typeof b?.scanSubsOnly === "boolean") scanSubsOnly = b.scanSubsOnly;
  } catch { /* no body */ }

  try {
    let q = sb.from("dr_outreach_replies")
      .select("id, graph_message_id")
      .is("attachments", null)
      .not("graph_message_id", "is", null);
    if (scanSubsOnly) q = q.eq("scan_is_submission", true);
    const { data: rows, error } = await q.order("received_at", { ascending: false }).limit(batch);
    if (error) throw error;

    const token = await graphToken();

    for (const r of rows || []) {
      log.processed++;
      const id = (r as any).id;
      const msgId = (r as any).graph_message_id;
      try {
        let found: Attachment[] | null = null;
        for (const mb of MAILBOXES) {
          found = await attachmentsFromMailbox(token, mb, msgId);
          if (found !== null) break;   // message located in this mailbox
        }
        if (found === null) { log.not_found++; continue; }   // leave NULL → retried next run
        const { error: upErr } = await sb.from("dr_outreach_replies")
          .update({ attachments: found }).eq("id", id);
        if (upErr) { log.failed++; log.errors.push({ id, error: upErr.message }); }
        else log.updated++;
      } catch (e) {
        log.failed++;
        log.errors.push({ id, error: String((e as any)?.message || e) });
      }
    }
  } catch (e) {
    log.errors.push({ stage: "outer", error: String((e as any)?.message || e) });
  }
  log.finished_at = new Date().toISOString();
  return new Response(JSON.stringify(log), { headers: { "Content-Type": "application/json" } });
});
