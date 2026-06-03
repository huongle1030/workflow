import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const MS_TENANT_ID = Deno.env.get("MS_TENANT_ID")!;
const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const MS_SENDER_USER_ID = Deno.env.get("MS_SENDER_USER_ID") || Deno.env.get("MS_SENDER_UPN")!;
const CLIENT_STATE = Deno.env.get("GRAPH_WEBHOOK_CLIENT_STATE")!;
const NOTIFY_URL = "https://asdunkqodixbhbohxtuq.functions.supabase.co/dr-outreach-reply";

// Shared mailboxes whose Inbox we watch for inbound doctor mail (replies + scan
// submissions). Both feed the dr-outreach-reply handler. Deduped in case
// MS_SENDER_USER_ID already equals one of these.
const MAILBOXES = Array.from(new Set([
  MS_SENDER_USER_ID,
  "implants@skdla.com",
  "clearchoice@skdla.com",
].filter(Boolean)));

async function graphToken(): Promise<string> {
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
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.access_token;
}

async function listSubs(token: string) {
  const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.value || [];
}

async function createSub(token: string, mailbox: string) {
  const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
  const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: NOTIFY_URL,
      resource: `users/${mailbox}/mailFolders('Inbox')/messages`,
      expirationDateTime: expires,
      clientState: CLIENT_STATE,
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function renewSub(token: string, id: string) {
  const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
  const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expirationDateTime: expires }),
  });
  return { status: res.status, body: await res.text() };
}

async function deleteSub(token: string, id: string) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status };
}

serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";
  const token = await graphToken();

  if (action === "list") {
    const subs = await listSubs(token);
    return new Response(JSON.stringify({ subs }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (action === "create") {
    const results = [];
    for (const mb of MAILBOXES) {
      const r = await createSub(token, mb);
      results.push({ mailbox: mb, status: r.status, body: r.body });
    }
    return new Response(JSON.stringify({ action: "created", results }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (action === "delete") {
    const id = url.searchParams.get("id");
    if (!id) return new Response("missing id", { status: 400 });
    const r = await deleteSub(token, id);
    return new Response(`status ${r.status}`, { status: r.status });
  }

  if (action === "renew") {
    const id = url.searchParams.get("id");
    if (!id) return new Response("missing id", { status: 400 });
    const r = await renewSub(token, id);
    return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
  }

  if (action === "auto_renew") {
    // Daily cron entry point: ensure EVERY watched mailbox has a live subscription on
    // our notification URL. Renew the ones that exist; create any that are missing.
    const subs = await listSubs(token);
    const ours = subs.filter((s: any) => s.notificationUrl === NOTIFY_URL);
    const results = [];
    for (const mb of MAILBOXES) {
      const existing = ours.find((s: any) =>
        (s.resource || "").toLowerCase().includes(mb.toLowerCase()));
      if (existing) {
        const r = await renewSub(token, existing.id);
        results.push({ mailbox: mb, action: "renewed", id: existing.id, status: r.status });
      } else {
        const r = await createSub(token, mb);
        results.push({ mailbox: mb, action: "created", status: r.status, body: r.body });
      }
    }
    return new Response(JSON.stringify({ action: "auto_renew", results }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("Use ?action=list|create|delete&id=|renew&id=|auto_renew", { status: 400 });
});
