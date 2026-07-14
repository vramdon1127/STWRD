// api/brief/dismiss.js — POST: mark selected brief items dismissed.
//
// Body: { date: 'YYYY-MM-DD', item_ids: [string, ...] }
//
// Sibling of promote.js: same read→map→PATCH of daily_briefs.payload, but
// only sets dismissed=true — no task inserts. GET /api/brief filters
// dismissed items out alongside promoted ones. stale_task items are
// review-only and rejected here just like in promote.
//
// Response: { dismissed: N, skipped: M, errors: [{ id?, error }] }
//
// Auth: user JWT → verify via /auth/v1/user → all DB ops run under user JWT
// so the self-only RLS on daily_briefs enforces isolation. No service role.

const SUPABASE_URL = 'https://fnnegalrrdzcgoelljmi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZubmVnYWxycmR6Y2dvZWxsam1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDMwNjksImV4cCI6MjA5MTUxOTA2OX0.bhgk6czCQYTuUGnu5Zv7pml9uMuPrp4I1VBSzVIHwqw';

async function sbUser(path, jwt, { method = 'GET', body = null, prefer = null } = {}) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const opts = { method, headers };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}${path}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data, raw: text };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return res.status(401).json({ error: 'missing_auth' });

  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${jwt}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'invalid_jwt' });
    const userData = await userRes.json();
    userId = userData?.id;
    if (!userId) return res.status(401).json({ error: 'invalid_jwt' });
  } catch (err) {
    console.error('[api/brief/dismiss] auth verify failed', err);
    return res.status(401).json({ error: 'auth_failed' });
  }

  const { date, item_ids } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'bad_date' });
  }
  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return res.status(400).json({ error: 'no_items' });
  }

  // Load the brief via RLS so we cannot touch someone else's payload.
  const briefQuery = await sbUser(
    `/rest/v1/daily_briefs?user_id=eq.${encodeURIComponent(userId)}&brief_date=eq.${encodeURIComponent(date)}&select=id,payload`,
    jwt
  );
  if (!briefQuery.ok) {
    console.error('[api/brief/dismiss] brief read failed', briefQuery.status, briefQuery.raw.slice(0, 200));
    return res.status(500).json({ error: 'brief_read_failed' });
  }
  if (!Array.isArray(briefQuery.data) || briefQuery.data.length === 0) {
    return res.status(404).json({ error: 'no_brief' });
  }

  const brief = briefQuery.data[0];
  const actionables = Array.isArray(brief.payload?.actionables) ? brief.payload.actionables : [];
  const wanted = new Set(item_ids);

  const result = { dismissed: 0, skipped: 0, errors: [] };
  const dismissedIds = new Set();

  for (const item of actionables) {
    if (!wanted.has(item.id)) continue;

    if (item.category === 'stale_task') {
      result.errors.push({ id: item.id, error: 'stale_task_not_dismissable' });
      continue;
    }
    if (item.dismissed) {
      result.skipped++;
      continue;
    }
    dismissedIds.add(item.id);
    result.dismissed++;
  }

  if (dismissedIds.size) {
    // Spread keeps every other field — including an existing promoted:true.
    const updatedActionables = actionables.map(item =>
      dismissedIds.has(item.id) ? { ...item, dismissed: true } : item
    );
    const patchRes = await sbUser(
      `/rest/v1/daily_briefs?id=eq.${encodeURIComponent(brief.id)}`,
      jwt,
      {
        method: 'PATCH',
        body: {
          payload: { ...brief.payload, actionables: updatedActionables },
          updated_at: new Date().toISOString(),
        },
        prefer: 'return=minimal',
      }
    );
    if (!patchRes.ok) {
      console.error('[api/brief/dismiss] payload patch failed', patchRes.status, patchRes.raw.slice(0, 200));
      result.errors.push({ error: 'payload_update_failed' });
    }
  }

  return res.status(200).json(result);
}
