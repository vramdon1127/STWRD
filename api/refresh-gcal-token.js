// Phase 2 — server-side gcal token refresh
// Architecture per docs/C1-PHASE-2.md
//
// Auth model (read carefully before modifying):
//   1. Caller sends Supabase JWT in Authorization header + {userId} in body
//   2. Verify JWT against /auth/v1/user, extract requesterId
//   3. If userId === requesterId, skip partnership check (self-refresh)
//   4. Else, call is_partner_or_self() RPC with caller's JWT (RLS enforces
//      partnership from caller's perspective, NOT service role's)
//   5. Only AFTER auth passes, use SERVICE_KEY to read profiles.gcal_refresh_token
//   6. Exchange with Google, return access_token
//   7. On invalid_grant, NULL out the stored token so we don't keep failing
//
// Why this layering: service role bypasses RLS. If we used service role for the
// partnership check, a bug could grant cross-user access. We use the user's own
// JWT for authorization decisions, and service role only for the privileged read
// once authorization has passed.

const SUPABASE_URL = 'https://fnnegalrrdzcgoelljmi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZubmVnYWxycmR6Y2dvZWxsam1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDMwNjksImV4cCI6MjA5MTUxOTA2OX0.bhgk6czCQYTuUGnu5Zv7pml9uMuPrp4I1VBSzVIHwqw';
const GOOGLE_OAUTH_CLIENT_ID = '933764042380-43o4bosc2unqd6dstrvgulcuqsc6mhc3.apps.googleusercontent.com';

// HTTP helper. IMPORTANT: userJwt and useServiceRole are mutually exclusive.
// - userJwt set, useServiceRole=false: anon-key apikey + user JWT in Authorization
// - useServiceRole=true, userJwt unset: service-key in both apikey and Authorization
// - Both set: incorrect, will produce mismatched headers — do not use.
async function sbFetch(path, opts = {}) {
  const { method = 'GET', body = null, useServiceRole = false, userJwt = null } = opts;
  const key = useServiceRole
    ? process.env.SUPABASE_SERVICE_KEY
    : SUPABASE_ANON_KEY;

  const headers = {
    'apikey': key,
    'Authorization': userJwt ? `Bearer ${userJwt}` : `Bearer ${key}`,
    'Content-Type': 'application/json'
  };

  const fetchOpts = { method, headers };
  if (body !== null) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(`${SUPABASE_URL}${path}`, fetchOpts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('[refresh-gcal-token] SUPABASE_SERVICE_KEY not configured');
    return res.status(500).json({ error: 'service_key_not_configured' });
  }
  if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    console.error('[refresh-gcal-token] GOOGLE_OAUTH_CLIENT_SECRET not configured');
    return res.status(500).json({ error: 'google_secret_not_configured' });
  }

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) {
    return res.status(401).json({ error: 'missing_auth' });
  }

  const { userId } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'missing_user_id' });
  }

  try {
    // Step 1: Verify JWT, get requesterId
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${jwt}`
      }
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: 'invalid_jwt' });
    }
    const userData = await userRes.json();
    const requesterId = userData?.id;
    if (!requesterId) {
      return res.status(401).json({ error: 'invalid_jwt' });
    }

    // Step 2: Authorization — self or active partner
    if (userId !== requesterId) {
      const rpcRes = await sbFetch('/rest/v1/rpc/is_partner_or_self', {
        method: 'POST',
        body: { target_user_id: userId },
        userJwt: jwt
      });
      if (!rpcRes.ok || rpcRes.data !== true) {
        return res.status(401).json({ error: 'not_partner' });
      }
    }

    // Step 3: Read refresh token (service role)
    const profileRes = await sbFetch(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=gcal_refresh_token`,
      { useServiceRole: true }
    );
    if (!profileRes.ok) {
      console.error('[refresh-gcal-token] profile read failed', profileRes.status);
      return res.status(500).json({ error: 'profile_read_failed' });
    }
    const refreshToken = profileRes.data?.[0]?.gcal_refresh_token;
    if (!refreshToken) {
      return res.status(404).json({ error: 'no_refresh_token' });
    }

    // Step 4: Exchange with Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (!tokenRes.ok) {
      const rawBody = await tokenRes.text();
      let tokenBody = {};
      try { tokenBody = JSON.parse(rawBody); } catch {}
      console.error('[refresh-gcal-token] google token error',
        tokenRes.status, rawBody.slice(0, 200));

      if (tokenBody.error === 'invalid_grant') {
        const patchRes = await sbFetch(
          `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
          {
            method: 'PATCH',
            body: { gcal_refresh_token: null, gcal_token_updated_at: null },
            useServiceRole: true
          }
        );
        if (!patchRes.ok) {
          console.error('[refresh-gcal-token] failed to clear revoked token',
            patchRes.status);
        }
        return res.status(401).json({ error: 'invalid_grant' });
      }
      return res.status(500).json({ error: 'google_token_error' });
    }

    const tokenJson = await tokenRes.json();
    return res.status(200).json({
      access_token: tokenJson.access_token,
      expires_in: tokenJson.expires_in
    });
  } catch (err) {
    console.error('[refresh-gcal-token] unexpected error', err);
    return res.status(500).json({ error: 'unexpected_error' });
  }
}
