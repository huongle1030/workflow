// Supabase Edge Function: outreach-attachment
// Mints service-role signed upload URLs for coordinator-attached PDFs, and deletes them.
// Called from the Pending Outbound / Pending Approval cards. The bytes are uploaded by the
// browser straight to the private 'outreach-attachments' bucket via the signed URL (so large
// files don't pass through this function), and a row is recorded in
// dr_outreach_attempt_attachments. send-attempt / dr-outreach-tick attach the files at send time.
//
// Actions (POST JSON):
//   { action: 'sign',   attempt_id, filename, contentType, size, uploaded_by? }
//        -> { attachment_id, bucket, path, signedUrl, token }
//   { action: 'delete', attachment_id }
//        -> { deleted: true }
//
// verify_jwt=false (called from the browser with the publishable key, like send-attempt).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const BUCKET = "outreach-attachments";
const MAX_BYTES = 35 * 1024 * 1024; // 35 MB soft cap (upload sessions support more; edge limits in mind)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function safeName(name: string): string {
  const base = (name || "attachment.pdf").split(/[\\/]/).pop() || "attachment.pdf";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "attachment.pdf";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body?.action;

  if (action === "sign") {
    const { attempt_id, filename, contentType, size, uploaded_by } = body;
    if (!attempt_id) return json({ error: "attempt_id required" }, 400);
    if ((contentType || "").toLowerCase() !== "application/pdf" && !/\.pdf$/i.test(filename || "")) {
      return json({ error: "only PDF files are allowed" }, 400);
    }
    if (typeof size === "number" && size > MAX_BYTES) {
      return json({ error: `file too large (max ${Math.floor(MAX_BYTES / 1024 / 1024)} MB)` }, 400);
    }
    const display = safeName(filename);
    const path = `${attempt_id}/${crypto.randomUUID()}-${display}`;
    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (signErr || !signed) return json({ error: `sign failed: ${signErr?.message || "unknown"}` }, 500);

    const { data: row, error: insErr } = await sb
      .from("dr_outreach_attempt_attachments")
      .insert({
        attempt_id,
        storage_bucket: BUCKET,
        storage_path: path,
        filename: display,
        mime_type: "application/pdf",
        size_bytes: typeof size === "number" ? size : null,
        uploaded_by: uploaded_by ?? null,
      })
      .select("id")
      .single();
    if (insErr || !row) {
      // Roll back the orphan storage slot best-effort.
      await sb.storage.from(BUCKET).remove([path]).catch(() => {});
      return json({ error: `insert failed: ${insErr?.message || "unknown"}` }, 500);
    }
    return json({ attachment_id: row.id, bucket: BUCKET, path, signedUrl: signed.signedUrl, token: signed.token });
  }

  if (action === "delete") {
    const { attachment_id } = body;
    if (!attachment_id) return json({ error: "attachment_id required" }, 400);
    const { data: row } = await sb
      .from("dr_outreach_attempt_attachments")
      .select("id, storage_bucket, storage_path")
      .eq("id", attachment_id)
      .maybeSingle();
    if (!row) return json({ deleted: true, note: "already gone" });
    await sb.storage.from(row.storage_bucket || BUCKET).remove([row.storage_path]).catch(() => {});
    const { error: delErr } = await sb.from("dr_outreach_attempt_attachments").delete().eq("id", attachment_id);
    if (delErr) return json({ error: `delete failed: ${delErr.message}` }, 500);
    return json({ deleted: true });
  }

  return json({ error: "unknown action" }, 400);
});
