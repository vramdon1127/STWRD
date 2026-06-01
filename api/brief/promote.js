// api/brief/promote.js — POST: create STWRD tasks from selected brief items.
//
// Body: { date: 'YYYY-MM-DD', item_ids: [string, ...] }
//
// For each requested item:
//   - Skip with error if category === 'stale_task' (review-only in v1)
//   - Insert into tasks with source_type / source_id / source_dedup_key copied
//     from the brief item
//   - 409 from PostgREST (tasks_source_dedup unique violation) → counted as
//     skipped, not an error — the item was already promoted earlier
// After inserts, PATCH the brief payload to mark successfully-promoted items
// promoted=true so the GET endpoint filters them out on the next render.
//
// Response: { created: N, skipped: M, errors: [{ id, status?, error }] }
//
// Auth: user JWT → verify via /auth/v1/user → all DB ops run under user JWT
// so the partnership-aware RLS on tasks (i1) and the self-only RLS on
// daily_briefs (i2) enforce isolation. No service role.

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
    console.error('[api/brief/promote] auth verify failed', err);
    return res.status(401).json({ error: 'auth_failed' });
  }

  const { date, item_ids } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'bad_date' });
  }
  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return res.status(400).json({ error: 'no_items' });
  }

  // Load the brief via RLS so we cannot pull someone else's payload.
  const briefQuery = await sbUser(
    `/rest/v1/daily_briefs?user_id=eq.${encodeURIComponent(userId)}&brief_date=eq.${encodeURIComponent(date)}&select=id,payload`,
    jwt
  );
  if (!briefQuery.ok) {
    console.error('[api/brief/promote] brief read failed', briefQuery.status, briefQuery.raw.slice(0, 200));
    return res.status(500).json({ error: 'brief_read_failed' });
  }
  if (!Array.isArray(briefQuery.data) || briefQuery.data.length === 0) {
    return res.status(404).json({ error: 'no_brief' });
  }

  const brief = briefQuery.data[0];
  const actionables = Array.isArray(brief.payload?.actionables) ? brief.payload.actionables : [];
  const wanted = new Set(item_ids);

  const result = { created: 0, skipped: 0, errors: [] };
  const promotedIds = new Set();

  for (const item of actionables) {
    if (!wanted.has(item.id)) continue;

    if (item.category === 'stale_task') {
      result.errors.push({ id: item.id, error: 'stale_task_not_promotable' });
      continue;
    }
    if (item.promoted) {
      result.skipped++;
      continue;
    }

    // Defaults match what processTask() in index.html sets, minus the
    // Claude-classified fields. User can edit category/project/priority
    // after promotion. added_by='Brief' marks origin in the UI.
    const taskBody = {
      content: item.task_title || item.title,
      cleaned_task: item.task_title || item.title,
      category: 'AI Assist',
      project: 'Personal',
      priority: 'P2',
      due_date: null,
      recurrence: 'none',
      life_area: null,
      status: 'todo',
      added_by: 'Brief',
      user_id: userId,
      source_type: item.source_type,
      source_id: item.source_id,
      source_dedup_key: item.source_dedup_key,
    };

    const insertRes = await sbUser('/rest/v1/tasks', jwt, {
      method: 'POST',
      body: taskBody,
      prefer: 'return=minimal',
    });

    if (insertRes.ok) {
      result.created++;
      promotedIds.add(item.id);
    } else if (insertRes.status === 409) {
      // Unique violation on tasks_source_dedup — already in tasks. Mark
      // promoted on the brief so it disappears from the actionables list.
      result.skipped++;
      promotedIds.add(item.id);
    } else {
      console.error('[api/brief/promote] insert failed', insertRes.status, insertRes.raw.slice(0, 200));
      result.errors.push({
        id: item.id,
        status: insertRes.status,
        error: insertRes.raw.slice(0, 200) || 'insert_failed',
      });
    }
  }

  if (promotedIds.size) {
    const updatedActionables = actionables.map(item =>
      promotedIds.has(item.id) ? { ...item, promoted: true } : item
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
      console.error('[api/brief/promote] payload patch failed', patchRes.status, patchRes.raw.slice(0, 200));
      // Tasks were already created — surface a soft warning but return 200
      // with the create count. The brief will just show the items again
      // until something else updates it (next digest run).
      result.errors.push({ error: 'payload_update_failed' });
    }
  }

  return res.status(200).json(result);
}
