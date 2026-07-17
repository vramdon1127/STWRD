import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const account = process.argv[2];
if (!account) die("usage: node gmail-reauth.mjs <account-email>");

const CLIENT_ID = req("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = req("GOOGLE_OAUTH_CLIENT_SECRET");
const SUPABASE_URL = req("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = req("SUPABASE_SERVICE_ROLE_KEY");

function req(name) {
  const v = process.env[name];
  if (!v) die(`missing env ${name}`);
  return v;
}
function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    login_hint: account,
    state,
  });

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((rq, rs) => {
    const url = new URL(rq.url, `http://localhost:${PORT}`);
    if (url.pathname !== "/oauth2callback") {
      rs.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");
    rs.writeHead(200, { "content-type": "text/plain" });
    if (err || !got) {
      rs.end(`Failed: ${err || "no code"}. You can close this tab.`);
      server.close();
      return reject(new Error(err || "no code returned"));
    }
    if (gotState !== state) {
      rs.end("State mismatch. You can close this tab.");
      server.close();
      return reject(new Error("state mismatch"));
    }
    rs.end(`Authorized ${account}. You can close this tab.`);
    server.close();
    resolve(got);
  });
  server.listen(PORT, () => {
    console.log(`\nSign in as: ${account}`);
    console.log(`If the browser does not open, paste this URL:\n\n${authUrl}\n`);
    exec(`open "${authUrl}"`);
  });
  setTimeout(() => {
    server.close();
    reject(new Error("timed out after 5 minutes"));
  }, 5 * 60 * 1000);
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }),
});
const tok = await tokenRes.json();
if (!tokenRes.ok) die(`token exchange failed (${tokenRes.status}): ${JSON.stringify(tok)}`);
if (!tok.refresh_token) {
  die("Google returned no refresh_token. Revoke this app at https://myaccount.google.com/permissions and run again.");
}

const profRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { authorization: `Bearer ${tok.access_token}` },
});
const prof = await profRes.json();
if (!profRes.ok) die(`profile check failed (${profRes.status}): ${JSON.stringify(prof)}`);
if (prof.emailAddress.toLowerCase() !== account.toLowerCase()) {
  die(`signed in as ${prof.emailAddress}, expected ${account}. Nothing written.`);
}

const row = {
  id: `gmail:${account}`,
  service: "gmail",
  account,
  refresh_token: tok.refresh_token,
  access_token: tok.access_token,
  access_token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
  scopes: SCOPE,
  client_id: CLIENT_ID,
  updated_at: new Date().toISOString(),
};

const up = await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens?on_conflict=id`, {
  method: "POST",
  headers: {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    prefer: "resolution=merge-duplicates,return=representation",
  },
  body: JSON.stringify(row),
});
if (!up.ok) die(`supabase upsert failed (${up.status}): ${await up.text()}`);

console.log(`\nok: ${account} written (id gmail:${account}), ${prof.messagesTotal} messages in mailbox.`);
