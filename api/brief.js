// api/brief.js — GET today's Brief actionables for the signed-in user.
//
// Auth model (mirrors refresh-gcal-token.js):
//   1. Caller sends Supabase JWT in Authorization: Bearer header
//   2. Verify JWT via /auth/v1/user → requesterId
//   3. Read daily_briefs via the user's own JWT so RLS enforces self-only
//      access (defense in depth — service role is unnecessary here)
//
// Response shape:
//   200 { id, brief_date, payload: { generated_at, actionables, raw_triage } }
//        — actionables filtered to those where neither promoted nor dismissed is true
//   404 { error: 'no_brief' } when no row exists for the requested date
//   401 on missing/invalid JWT
//
// Companion endpoint: POST /api/brief/promote (separate file).

const SUPABASE_URL = 'https://fnnegalrrdzcgoelljmi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZubmVnYWxycmR6Y2dvZWxsam1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDMwNjksImV4cCI6MjA5MTUxOTA2OX0.bhgk6czCQYTuUGnu5Zv7pml9uMuPrp4I1VBSzVIHwqw';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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
    console.error('[api/brief] auth verify failed', err);
    return res.status(401).json({ error: 'auth_failed' });
  }

  const requestedDate = (req.query?.date || '').toString();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  try {
    const briefRes = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_briefs?user_id=eq.${encodeURIComponent(userId)}&brief_date=eq.${encodeURIComponent(date)}&select=id,brief_date,payload,created_at,updated_at`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!briefRes.ok) {
      const text = await briefRes.text();
      console.error('[api/brief] sb read failed', briefRes.status, text.slice(0, 200));
      return res.status(500).json({ error: 'brief_read_failed' });
    }

    const rows = await briefRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'no_brief' });
    }

    const brief = rows[0];
    const allActionables = Array.isArray(brief.payload?.actionables)
      ? brief.payload.actionables
      : [];
    const filtered = allActionables.filter(i => !i.promoted && !i.dismissed);

    return res.status(200).json({
      id: brief.id,
      brief_date: brief.brief_date,
      payload: { ...brief.payload, actionables: filtered },
    });
  } catch (err) {
    console.error('[api/brief] unexpected error', err);
    return res.status(500).json({ error: 'unexpected_error' });
  }
}
