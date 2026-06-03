// Supabase Edge Function: dr-outreach-reply
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_TENANT_ID = Deno.env.get("MS_TENANT_ID")!;
const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const MS_SENDER_USER_ID = Deno.env.get("MS_SENDER_USER_ID") || Deno.env.get("MS_SENDER_UPN")!;
const CLIENT_STATE = Deno.env.get("GRAPH_WEBHOOK_CLIENT_STATE")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY")
  || Deno.env.get("anthropic_api_key")
  || Deno.env.get("anthropic_key_api"))!;

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

// The Graph change notification tells us which mailbox the message lives in. We now
// watch MULTIPLE shared mailboxes (implants@, clearchoice@), so fetch the message from
// the mailbox named in the notification's `resource` rather than a single fixed mailbox.
// Falls back to MS_SENDER_USER_ID if the resource can't be parsed (preserves old behavior).
function mailboxFromResource(resource: string | undefined | null): string {
  if (resource) {
    const m = resource.match(/users\/([^\/]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return MS_SENDER_USER_ID;
}

async function fetchMessage(userId: string, messageId: string) {
  const token = await graphToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages/${messageId}?$select=id,conversationId,subject,from,bodyPreview,body,internetMessageId,toRecipients,receivedDateTime`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Graph fetch message failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function graphSendMail(to: string, subject: string, html: string, caseNumber: string) {
  const token = await graphToken();
  const tag = `[SKDLA-${caseNumber}]`;
  const taggedSubject = subject.includes(tag) ? subject : `${subject} ${tag}`;
  const draftRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_SENDER_USER_ID)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: taggedSubject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      }),
    },
  );
  if (!draftRes.ok) throw new Error(`Graph draft failed: ${draftRes.status} ${await draftRes.text()}`);
  const draft = await draftRes.json();
  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_SENDER_USER_ID)}/messages/${draft.id}/send`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!sendRes.ok) throw new Error(`Graph send failed: ${sendRes.status} ${await sendRes.text()}`);
  return { graph_message_id: draft.id, graph_conversation_id: draft.conversationId };
}

async function classifyReply(subject: string, body: string) {
  const prompt = `You classify dental-lab doctor email replies into one of five buckets:
- "approved": Doctor approves the design as-is, NO change requests.
- "modification": Doctor requests changes and does NOT approve.
- "approved_with_mods": Doctor approves AND requests one or more modifications.
- "pricing_or_product_question": Doctor is asking about pricing, materials, custom options. Routes to Account Manager.
- "other": Out-of-office, scheduling, unrelated.

Reply with strict JSON: {"classification": "...", "confidence": 0.0-1.0, "summary": "<one-sentence reason>"}.

IMPORTANT: The body below contains ONLY what the doctor wrote in this reply (any quoted prior email has already been stripped). Classify based on this content alone.

Subject: ${subject}

Body:
${body.slice(0, 4000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return { classification: "unclear", confidence: 0, summary: `classifier error: ${res.status}` };
  const j = await res.json();
  const text = j.content?.[0]?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { classification: "unclear", confidence: 0, summary: "no JSON" };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      classification: parsed.classification ?? "unclear",
      confidence: Number(parsed.confidence ?? 0),
      summary: parsed.summary ?? "",
    };
  } catch { return { classification: "unclear", confidence: 0, summary: "parse error" }; }
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "")
             .replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .trim();
}

// Strip the quoted prior email from a reply body. Only feed the new text
// the doctor wrote to the classifier so it doesn't get confused.
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

function extractCaseNumber(subject: string, body: string): string | null {
  const tag = subject.match(/\[SKDLA-([\w-]+)\]/);
  if (tag) return tag[1];
  const yearish = (subject + " " + body).match(/\b(20\d{2}-\d{4,6})\b/);
  return yearish ? yearish[1] : null;
}

serve(async (req) => {
  const url = new URL(req.url);
  const vt = url.searchParams.get("validationToken");
  if (vt) return new Response(vt, { status: 200, headers: { "Content-Type": "text/plain" } });

  const payload = await req.json().catch(() => null);
  if (!payload?.value) return new Response("ok");

  for (const note of payload.value) {
    if (note.clientState !== CLIENT_STATE) continue;
    if (!note.resourceData?.id) continue;

    try {
      const mailbox = mailboxFromResource(note.resource);
      const msg = await fetchMessage(mailbox, note.resourceData.id);
      const subject = msg.subject ?? "";
      const fromAddr = msg.from?.emailAddress?.address ?? "";
      const html = msg.body?.contentType === "html" ? (msg.body?.content ?? "") : "";
      const text = msg.body?.contentType === "text" ? (msg.body?.content ?? "") : stripHtml(html);
      const internetMsgId = msg.internetMessageId ?? null;

      // Idempotency guard. Graph delivers change notifications at-least-once (it re-fires
      // the same message seconds apart), and the same email also lands in several watched
      // mailboxes (implants@, clearchoice@, MS_SENDER) — each a separate notification.
      // internetMessageId (the RFC-822 Message-ID) is identical across every copy, so if
      // we've already ingested it, skip: otherwise we create duplicate reply rows and the
      // scan-ack composer drafts one ack per row (2–3 identical drafts in Pending Outbound).
      if (internetMsgId) {
        const { data: dup } = await sb.from("dr_outreach_replies")
          .select("id").eq("internet_message_id", internetMsgId).limit(1).maybeSingle();
        if (dup) continue;
      }

      const caseNumber = extractCaseNumber(subject, text);

      let queueId: string | null = null;
      if (caseNumber) {
        const { data: q } = await sb.from("dr_outreach_queue")
          .select("id").eq("case_number", caseNumber).eq("status", "open")
          .order("created_at", { ascending: false }).limit(1).single();
        queueId = q?.id ?? null;
      }
      if (!queueId && msg.conversationId) {
        const { data: a } = await sb.from("dr_outreach_attempts")
          .select("queue_id").eq("graph_conversation_id", msg.conversationId)
          .order("created_at", { ascending: false }).limit(1).single();
        queueId = a?.queue_id ?? null;
      }

      if (queueId) {
        await sb.from("dr_outreach_queue")
          .update({ next_followup_at: new Date(Date.now() + 7 * 86400_000).toISOString() })
          .eq("id", queueId).eq("status", "open");
      }

      const replyOnly = stripQuotedReply(text);
      const cls = await classifyReply(subject, replyOnly);

      // upsert + ignoreDuplicates is the race-safe backstop to the pre-check above: if two
      // concurrent notifications for the same message slip past the SELECT, the unique index
      // on internet_message_id makes the second a no-op (returns no row → insertedReply null,
      // and the case/auto-confirm steps below are already guarded on insertedReply).
      const { data: insertedReply } = await sb.from("dr_outreach_replies").upsert({
        queue_id: queueId,
        graph_message_id: msg.id,
        graph_conversation_id: msg.conversationId,
        internet_message_id: internetMsgId,
        from_email: fromAddr,
        subject,
        body_text: text.slice(0, 50_000),
        body_html: html.slice(0, 200_000),
        ai_classification: cls.classification,
        ai_confidence: cls.confidence,
        ai_summary: cls.summary,
      }, { onConflict: "internet_message_id", ignoreDuplicates: true }).select("id").maybeSingle();

      if (caseNumber && insertedReply) {
        await sb.rpc("record_outbox_inbound", {
          p_case_number: caseNumber,
          p_reply_id: insertedReply.id,
          p_from_addr: fromAddr,
          p_subject: subject,
          p_body_text: text.slice(0, 50_000),
          p_graph_msg_id: msg.id,
        });
      }

      if (insertedReply && queueId) {
        const { data: autoApplied } = await sb.rpc("try_auto_confirm_reply", { p_reply_id: insertedReply.id });
        if (!autoApplied) {
          const { data: q } = await sb.from("dr_outreach_queue")
            .select("case_number, account_number").eq("id", queueId).single();
          const { data: acct } = await sb.from("Accounts")
            .select(`"Account Manager", "Practice Name"`)
            .eq("Account Number", q?.account_number ?? "").single();
          const am = (acct as any)?.["Account Manager"];
          if (am && am !== "(x) Not Assigned") {
            try {
              await graphSendMail(
                am,
                `Review needed: reply on Case ${q?.case_number}`,
                `<p>The classifier was not confident enough to auto-apply this reply.</p>
                 <p><strong>Practice:</strong> ${(acct as any)?.["Practice Name"] ?? ""}<br/>
                 <strong>From:</strong> ${fromAddr}<br/>
                 <strong>Guess:</strong> ${cls.classification} (${cls.confidence})<br/>
                 <strong>Summary:</strong> ${cls.summary}</p>
                 <p><strong>Original subject:</strong> ${subject}</p>
                 <hr/>
                 <pre>${replyOnly.slice(0, 4000)}</pre>
                 <p>Confirm or override in the Coordinator Inbox.</p>`,
                q?.case_number ?? "review",
              );
            } catch (e) { console.error("AM notify failed", e); }
          }
        }
      }
    } catch (e) {
      console.error("reply handler error", e);
    }
  }

  return new Response("ok");
});
