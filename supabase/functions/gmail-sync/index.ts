// gmail-sync Edge Function
// Pulls last 30 days of inbox messages from each Gmail account in oauth_tokens
// and upserts them into gmail_messages, labeled by account.
//
// Schedule: every 5 min via pg_cron + trigger_edge_function wrapper.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;

const GMAIL_QUERY = "in:inbox newer_than:30d";
const MAX_MESSAGES_PER_ACCOUNT = 200; // Gmail API page size cap; 200 covers 30d for most accounts
const BODY_TEXT_MAX_CHARS = 4000;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Helpers ----------

interface GmailToken {
  account: string;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }
  return res.json();
}

async function getValidAccessToken(token: GmailToken): Promise<string> {
  // If we have a non-expired access token, use it; otherwise refresh.
  const now = Date.now();
  if (token.access_token && token.access_token_expires_at) {
    const expiresAt = new Date(token.access_token_expires_at).getTime();
    // 60s safety margin
    if (expiresAt - now > 60_000) {
      return token.access_token;
    }
  }
  const refreshed = await refreshAccessToken(token.refresh_token);
  const newExpiresAt = new Date(now + refreshed.expires_in * 1000).toISOString();

  // Persist the new access token
  await sb
    .from("oauth_tokens")
    .update({
      access_token: refreshed.access_token,
      access_token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", `gmail:${token.account}`);

  return refreshed.access_token;
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  // atob -> binary string of UTF-8 bytes; convert via Uint8Array -> TextDecoder
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

interface MessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
}

function findPlainTextBody(part: MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return base64UrlDecode(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const found = findPlainTextBody(sub);
      if (found) return found;
    }
  }
  return null;
}

function parseFromHeader(value: string): { from_address: string | null; from_name: string | null } {
  // "Name <email@x.com>" or "email@x.com"
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    return { from_name: m[1].trim() || null, from_address: m[2].trim().toLowerCase() };
  }
  return { from_name: null, from_address: value.trim().toLowerCase() };
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string };
    parts?: MessagePart[];
  };
}

async function fetchMessageList(accessToken: string): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", GMAIL_QUERY);
  url.searchParams.set("maxResults", String(MAX_MESSAGES_PER_ACCOUNT));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail list failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return (data.messages ?? []).map((m: { id: string }) => m.id);
}

async function fetchMessageDetail(accessToken: string, id: string): Promise<GmailMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail fetch ${id} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

function transformMessage(account: string, msg: GmailMessage) {
  const headers = msg.payload?.headers ?? [];
  const headerMap = new Map(headers.map((h) => [h.name.toLowerCase(), h.value]));
  const fromRaw = headerMap.get("from") ?? "";
  const { from_address, from_name } = parseFromHeader(fromRaw);
  const subject = headerMap.get("subject") ?? null;

  const bodyTextRaw = findPlainTextBody(msg.payload as MessagePart | undefined);
  const body_text = bodyTextRaw ? bodyTextRaw.slice(0, BODY_TEXT_MAX_CHARS) : null;

  const internalMs = msg.internalDate ? Number(msg.internalDate) : Date.now();

  return {
    account,
    gmail_id: msg.id,
    thread_id: msg.threadId,
    from_address,
    from_name,
    subject,
    snippet: msg.snippet ?? null,
    body_text,
    received_at: new Date(internalMs).toISOString(),
    labels: msg.labelIds ?? [],
    synced_at: new Date().toISOString(),
  };
}

// ---------- Per-account sync ----------

async function syncAccount(token: GmailToken): Promise<{ account: string; fetched: number; upserted: number; error?: string }> {
  try {
    const accessToken = await getValidAccessToken(token);
    const messageIds = await fetchMessageList(accessToken);

    if (messageIds.length === 0) {
      return { account: token.account, fetched: 0, upserted: 0 };
    }

    // Skip messages already in DB (by account + gmail_id)
    const { data: existing } = await sb
      .from("gmail_messages")
      .select("gmail_id")
      .eq("account", token.account)
      .in("gmail_id", messageIds);
    const existingSet = new Set((existing ?? []).map((r: { gmail_id: string }) => r.gmail_id));
    const newIds = messageIds.filter((id) => !existingSet.has(id));

    if (newIds.length === 0) {
      return { account: token.account, fetched: 0, upserted: 0 };
    }

    // Fetch new messages in parallel batches of 10 (Gmail allows ~250 req/sec/user, this is gentle)
    const rows: ReturnType<typeof transformMessage>[] = [];
    const BATCH = 10;
    for (let i = 0; i < newIds.length; i += BATCH) {
      const batch = newIds.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((id) => fetchMessageDetail(accessToken, id)));
      for (const m of results) rows.push(transformMessage(token.account, m));
    }

    const { error } = await sb
      .from("gmail_messages")
      .upsert(rows, { onConflict: "account,gmail_id", ignoreDuplicates: false });
    if (error) throw new Error(`Upsert failed: ${error.message}`);

    return { account: token.account, fetched: newIds.length, upserted: rows.length };
  } catch (err) {
    return { account: token.account, fetched: 0, upserted: 0, error: (err as Error).message };
  }
}

// ---------- Entry point ----------

Deno.serve(async (_req) => {
  try {
    const { data: tokens, error } = await sb
      .from("oauth_tokens")
      .select("account, refresh_token, access_token, access_token_expires_at")
      .eq("service", "gmail");
    if (error) throw error;
    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: "No gmail accounts configured" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Sync accounts in parallel — they're independent
    const results = await Promise.all((tokens as GmailToken[]).map(syncAccount));

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});