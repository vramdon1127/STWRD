// STWRD Daily Digest — runs every morning at 6am CT via cron-job.org
// Pulls tasks from Supabase, generates AI summary, sends via Resend.
//
// For users whose id is in PERSONAL_BRIEFING_USER_IDS, ALSO pulls a
// household briefing from the personal-life Supabase project (sensors +
// sleep + iMessages + Gmail) and surfaces a household card in the email.
// The personal briefing is never required — if it errors or times out,
// the digest still ships without the household card.

const SUPABASE_URL = 'https://fnnegalrrdzcgoelljmi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZubmVnYWxycmR6Y2dvZWxsam1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDMwNjksImV4cCI6MjA5MTUxOTA2OX0.bhgk6czCQYTuUGnu5Zv7pml9uMuPrp4I1VBSzVIHwqw';

// Vijay's user_id — only user that gets the personal household briefing card
// for now. Convert to a `profiles.personal_briefing_enabled` flag when
// expanding to Mia / other beta users.
const PERSONAL_BRIEFING_USER_IDS = new Set([
  '2e5683e0-c6ad-483f-b31d-c93f097c0aeb',
]);

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
}

async function sbFetch(path, useServiceRole = false) {
  const key = useServiceRole ? getServiceKey() : SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    }
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchPersonalBriefing() {
  const url = process.env.PERSONAL_BRIEFING_URL;
  const key = process.env.PERSONAL_BRIEFING_KEY;
  if (!url || !key) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${url}/functions/v1/morning-briefing`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error('Personal briefing non-2xx:', res.status);
      return null;
    }
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    console.error('Personal briefing fetch failed:', e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstNameFrom(profile) {
  const raw = profile?.full_name || profile?.digest_email || '';
  const first = String(raw).trim().split(/\s+/)[0] || '';
  return first.split('@')[0] || 'friend';
}

const LEGACY_PROJECT_HEX = {
  GNE: '#f472b6',
  Caliber: '#60a5fa',
  Personal: '#34d399',
  ServeAnts: '#fb923c',
  Family: '#22d3ee',
};
function projectHexFor(name, colorByName) {
  if (!name) return '#7c6fef';
  const stored = colorByName ? colorByName[name] : null;
  if (stored && stored.startsWith('#')) return stored;
  return LEGACY_PROJECT_HEX[name] || '#7c6fef';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const profiles = await sbFetch('profiles?digest_email=not.is.null&select=id,full_name,digest_email,anthropic_key', true);

    if (!profiles || profiles.length === 0) {
      return res.status(200).json({ message: 'No users with digest email configured' });
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return res.status(500).json({ error: 'RESEND_API_KEY not configured in environment' });
    }

    let personalBriefing = null;
    const needsBriefing = profiles.some(p => PERSONAL_BRIEFING_USER_IDS.has(p.id));
    if (needsBriefing) {
      personalBriefing = await fetchPersonalBriefing();
      if (personalBriefing) {
        personalBriefing.triage = await triageInbox(personalBriefing);
      }
    }

    let sent = 0;
    let errors = [];

    for (const profile of profiles) {
      const briefingForUser = PERSONAL_BRIEFING_USER_IDS.has(profile.id)
        ? personalBriefing
        : null;

      try {
        await sendDigestToUser(profile, resendKey, briefingForUser);
        sent++;
      } catch (e) {
        errors.push({ user: profile.id, error: e.message });
      }

      // Brief assembly is best-effort and runs independently of the email send.
      // A failure here must not prevent the digest from being delivered.
      try {
        const actionables = await assembleActionables(briefingForUser, profile.id);
        const briefDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        await upsertDailyBrief(profile.id, briefDate, {
          generated_at: new Date().toISOString(),
          actionables,
          raw_triage: briefingForUser?.triage || null,
        });
      } catch (err) {
        console.error(`Brief assembly failed for ${profile.id}:`, err.message);
      }
    }

    return res.status(200).json({
      success: true,
      sent,
      errors,
      personal_briefing_attached: !!personalBriefing,
    });

  } catch (e) {
    console.error('Digest error:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function sendDigestToUser(profile, resendKey, personalBriefing) {
  const toEmail = profile.digest_email;
  const anthropicKey = profile.anthropic_key || process.env.ANTHROPIC_API_KEY;

  if (!toEmail || !anthropicKey || !resendKey) {
    throw new Error(
      `Missing required config (toEmail=${!!toEmail}, anthropicKey=${!!anthropicKey}, resendKey=${!!resendKey})`
    );
  }

  const firstName = firstNameFrom(profile);
  const userId = profile.id;
  const tasks = await sbFetch(`tasks?user_id=eq.${userId}&status=neq.done&order=created_at.desc&limit=100`, true) || [];

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const todayDisplay = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago'
  });

  const dueTodayTasks = tasks.filter(t => t.due_date === today);
  const overdueTasks = tasks.filter(t => t.due_date && t.due_date < today);
  const p1Tasks = tasks.filter(t => t.priority === 'P1');
  const aiCompleteTasks = tasks.filter(t => t.category === 'AI Complete');

  const userProjectRows = await sbFetch(
    `projects?user_id=eq.${userId}&order=sort_order.asc`,
    true
  ) || [];
  const projectColorByName = {};
  userProjectRows.forEach(p => { if (p?.name) projectColorByName[p.name] = p.color || null; });

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  let completedThisWeek = [];
  try {
    completedThisWeek = await sbFetch(`tasks?user_id=eq.${userId}&status=eq.done&created_at=gte.${weekAgoStr}T00:00:00Z&limit=200`, true) || [];
  } catch (e) {}

  const totalThisWeek = tasks.length + completedThisWeek.length;
  const completionRate = totalThisWeek > 0
    ? Math.round((completedThisWeek.length / totalThisWeek) * 100)
    : 0;

  const taskSummary = tasks.slice(0, 30).map(t =>
    `[${t.project}][${t.category}][${t.priority}]${t.due_date ? '[due:' + t.due_date + ']' : ''} ${t.cleaned_task || t.content}`
  ).join('\n');

  const householdContext = buildHouseholdContextForAI(personalBriefing);

  const aiPrompt = `You are STWRD, ${firstName}'s personal AI life manager. Generate a sharp, specific morning briefing.

TODAY: ${todayDisplay}
COMPLETION RATE: ${completionRate}%
DUE TODAY: ${dueTodayTasks.length} tasks
OVERDUE: ${overdueTasks.length} tasks
URGENT (P1): ${p1Tasks.length} tasks
AI CAN HANDLE: ${aiCompleteTasks.length} tasks

ACTIVE TASKS:
${taskSummary || 'No active tasks'}
${householdContext ? `\nHOUSEHOLD CONTEXT (last 24h):\n${householdContext}\n` : ''}
Give exactly ONE sharp, actionable focus recommendation for today. Be specific — name actual tasks. If household context surfaces something genuinely urgent (e.g. high radon, terrible sleep, an unread message from a high-priority contact), you may weave it in. Be direct, warm, brief. Max 2 sentences.

FOCUS: [your recommendation here]`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: aiPrompt }]
    })
  });

  const aiData = await aiRes.json();
  const aiText = aiData.content?.[0]?.text || '';
  const focusMatch = aiText.match(/FOCUS: (.+)/s);
  const focusRaw = focusMatch ? focusMatch[1].trim() : aiText.trim();
  const focusLine = focusRaw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^FOCUS:\s*/i, '').trim();

  const dueTodayHtml = dueTodayTasks.length > 0
    ? dueTodayTasks.slice(0, 5).map(t => {
        const projColor = projectHexFor(t.project, projectColorByName);
        return `<tr>
          <td style="padding:5px 0;">
            <span style="display:inline-block;width:8px;height:8px;background:${projColor};border-radius:50%;margin-right:8px;"></span>
            <span style="font-size:13px;color:#f0f0ff;">${esc(t.cleaned_task || t.content)}</span>
            <span style="font-size:11px;color:#8888aa;margin-left:6px;">${esc(t.project || '')}</span>
          </td>
        </tr>`;
      }).join('') + (dueTodayTasks.length > 5 ? `<tr><td style="font-size:12px;color:#8888aa;padding:4px 0;">+${dueTodayTasks.length - 5} more</td></tr>` : '')
    : '<tr><td style="font-size:13px;color:#8888aa;padding:8px 0;">Nothing due today 🎉</td></tr>';

  const overdueHtml = overdueTasks.length > 0
    ? `<div style="background:#1a0f0f;border:1px solid #ef444440;border-radius:10px;padding:14px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ef4444;margin-bottom:8px;">⚠️ Overdue (${overdueTasks.length})</div>
        ${overdueTasks.slice(0, 3).map(t => `<div style="font-size:13px;color:#f0f0ff;padding:3px 0;">${esc(t.cleaned_task || t.content)} <span style="color:#8888aa;">(${esc(t.due_date)})</span></div>`).join('')}
        ${overdueTasks.length > 3 ? `<div style="font-size:12px;color:#8888aa;margin-top:4px;">+${overdueTasks.length - 3} more overdue</div>` : ''}
      </div>`
    : '';

  const householdHtml = renderHouseholdCard(personalBriefing);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">

    <div style="margin-bottom:24px;">
      <div style="font-size:22px;font-weight:800;color:#7c6fef;letter-spacing:-0.5px;">STWRD</div>
      <div style="font-size:13px;color:#8888aa;margin-top:2px;">${todayDisplay}</div>
    </div>

    <div style="background:#12121a;border:1px solid #7c6fef40;border-radius:14px;padding:18px;margin-bottom:16px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#7c6fef,#f472b6,#10b981);"></div>
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#7c6fef;margin-bottom:8px;">🧠 Today's Focus</div>
      <div style="font-size:14px;color:#f0f0ff;line-height:1.6;">${esc(focusLine)}</div>
    </div>

    ${overdueHtml}

    <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:14px;padding:18px;margin-bottom:16px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8888aa;margin-bottom:10px;">Due Today (${dueTodayTasks.length})</div>
      <table style="width:100%;border-collapse:collapse;">${dueTodayHtml}</table>
    </div>

    ${householdHtml}

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;">
      <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#7c6fef;">${tasks.length}</div>
        <div style="font-size:10px;color:#8888aa;margin-top:2px;">Active</div>
      </div>
      <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#ef4444;">${p1Tasks.length}</div>
        <div style="font-size:10px;color:#8888aa;margin-top:2px;">Urgent</div>
      </div>
      <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#10b981;">${completionRate}%</div>
        <div style="font-size:10px;color:#8888aa;margin-top:2px;">Done Rate</div>
      </div>
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://getstwrd.com" style="display:inline-block;background:linear-gradient(135deg,#7c6fef,#8b5cf6);color:white;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;font-weight:700;letter-spacing:0.5px;">Open STWRD →</a>
    </div>

    <div style="text-align:center;font-size:11px;color:#8888aa;">
      STWRD · Your Household OS · <a href="https://getstwrd.com" style="color:#7c6fef;text-decoration:none;">Open app</a>
    </div>

  </div>
</body>
</html>`;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendKey}`
    },
    body: JSON.stringify({
      from: 'STWRD <onboarding@resend.dev>',
      to: [toEmail],
      subject: `STWRD · ${todayDisplay}`,
      html
    })
  });

  const emailData = await emailRes.json();

  if (!emailRes.ok) {
    console.error('Resend error:', emailData);
    throw new Error(`Email send failed: ${JSON.stringify(emailData)}`);
  }
}

function buildHouseholdContextForAI(briefing) {
  if (!briefing) return '';
  const lines = [];

  const air = briefing.air;
  if (air && air.reading_count) {
    if (air.co2?.current != null) lines.push(`CO2 ${air.co2.current} ppm`);
    if (air.humidity?.current != null) lines.push(`humidity ${air.humidity.current}%`);
    if (air.radon_bq_m3?.current != null) lines.push(`radon ${air.radon_bq_m3.current} Bq/m³`);
    if (air.pm25?.current != null) lines.push(`PM2.5 ${air.pm25.current}`);
    if (Array.isArray(air.anomalies) && air.anomalies.length) {
      lines.push(`air anomalies: ${air.anomalies.join('; ')}`);
    }
  }

  const sleep = briefing.sleep;
  if (sleep) {
    if (sleep.score != null) lines.push(`sleep score ${sleep.score}`);
    if (sleep.readiness != null) lines.push(`readiness ${sleep.readiness}`);
    if (sleep.total_hours != null) lines.push(`total sleep ${sleep.total_hours}h`);
  }

  const triageTexts = briefing.triage?.texts || [];
  const triageEmails = briefing.triage?.emails || [];
  if (triageTexts.length) {
    lines.push('TOP TEXTS NEEDING ATTENTION:');
    triageTexts.slice(0, 2).forEach(t => {
      lines.push(`- ${t.from}: ${t.what} (${t.why})`);
    });
  }
  if (triageEmails.length) {
    lines.push('TOP EMAILS WORTH READING:');
    triageEmails.slice(0, 2).forEach(e => {
      lines.push(`- ${e.from} re: ${e.subject} — ${e.why}`);
    });
  }

  const hh = briefing.household;
  if (hh?.pregnancy_week != null) {
    lines.push(`pregnancy week ${hh.pregnancy_week}, ${hh.weeks_until_due ?? '?'} weeks until due`);
  }

  return lines.join('\n');
}

async function triageInbox(briefing) {
  const rawTexts = briefing?.imessages?.threads || briefing?.imessages?.urgent || [];
  const rawAccounts = briefing?.gmail?.accounts
    || (briefing?.gmail?.urgent ? [{ threads: briefing.gmail.urgent }] : []);

  if (!rawTexts.length && !rawAccounts.length) {
    return { texts: [], emails: [] };
  }

  // Each input carries a stable `id` (deterministic from raw fields). Claude
  // is told to echo the matching id in each surfaced item; we use that to
  // merge metadata back so the Brief view has a real source identifier.
  // _raw stays server-side and is stripped before we send to Claude.
  const textsForClaude = rawTexts.map(t => {
    const sender = t.sender || t.handle || 'unknown';
    const lastInboundAt = t.last_inbound_at || t.last_at || '';
    const id = `imessage:${sender}:${lastInboundAt}`;
    const lastInbound = Array.isArray(t.messages)
      ? [...t.messages].reverse().find(m => !m.from_me)
      : null;
    const lastInboundSnippet = (lastInbound?.text || t.text || '').slice(0, 280);
    return {
      _raw: {
        sender,
        last_inbound_at: lastInboundAt,
        last_inbound_snippet: lastInboundSnippet,
      },
      id,
      from: t.resolved_name || sender,
      relationship: t.relationship,
      last_message_at: t.last_at,
      last_message_from_me: t.last_message_from_me,
      last_inbound_at: lastInboundAt,
      last_outbound_at: t.last_outbound_at,
      messages: t.messages
        ? t.messages.slice(-3).map(m => ({ from_me: m.from_me, text: m.text }))
        : (t.text ? [{ from_me: false, text: t.text }] : []),
    };
  });

  const emailsForClaude = [];
  for (const acct of rawAccounts) {
    for (const th of (acct.threads || [])) {
      const fromAddress = th.from_address || '';
      const subject = th.subject || '';
      const receivedAt = th.received_at || '';
      const id = 'gmail:' + Buffer.from(`${fromAddress}|${subject}|${receivedAt}`)
        .toString('base64url').slice(0, 32);
      emailsForClaude.push({
        _raw: {
          from_address: fromAddress,
          subject,
          snippet: th.snippet || '',
          received_at: receivedAt,
        },
        id,
        account: acct.context || acct.account,
        from: th.from_name || th.from_address || th.from,
        from_address: fromAddress,
        subject,
        snippet: (th.snippet || '').slice(0, 300),
        unread: th.unread,
        received_at: receivedAt,
      });
    }
  }

  const stripRaw = arr => arr.map(({ _raw, ...rest }) => rest);
  const byId = new Map();
  textsForClaude.forEach(t => byId.set(t.id, { kind: 'text', raw: t._raw }));
  emailsForClaude.forEach(e => byId.set(e.id, { kind: 'email', raw: e._raw }));

  const systemPrompt = `You are triaging Vijay's inbox for his daily morning digest. You know his life:

- Partner: Mia (currently 27 weeks pregnant, due July 31). Anything from Mia defaults to surfacing — even casual messages.
- Businesses:
  - GNE (Good News Entertainment) — DJ/MC business. Bark leads, Wedding Wire inquiries, HoneyBook notifications, VIBO events, direct couple inquiries are time-sensitive money.
  - Caliber — Director of Internal Controls. Colleagues by name: Craig, Grant Willard, Joel Odelson, Tom Springfield, Amit Patel, Brian Telthorst.
  - ServeAnts LLC / STWRD / Knot — his side projects.
- Family / pregnancy: anything medical, OB-related, family logistics around the baby = top priority.

Surface only items that genuinely need attention today. Skip:
- Marketing and promotional email (Temu, deals, newsletters)
- "Your package shipped" / no-reply automated notifications
- Social pleasantries that don't need a response
- Anything that can wait a week with zero consequence

Order matters — the most important item is first in each list. Order IS the priority signal. Do not include numeric scores or priority labels.

Each text thread includes direction data. \`last_message_from_me: true\` means Vijay already replied — the loop is likely closed; only surface it if his reply was clearly partial or left a question open. \`last_message_from_me: false\` means the other person is waiting on him — this is the primary "needs a reply" signal. Each message also has \`from_me\` so you can see who said what. For group chats, weigh whether the last inbound is genuinely pressing or just ongoing chatter.

For "why": one sentence. Not a summary of the message — the REASON it earned attention. Examples:
- "she already picked Hat Creek, just confirm to the group"
- "10 fresh GNE leads, these decay in hours"
- "Taylor is following up a second time on a meeting that was supposed to close last week"

Each input item has an \`id\` field. You MUST copy that id verbatim into the matching surfaced item so downstream code can link your judgment back to the source.

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "texts": [{ "id": "...", "from": "...", "what": "...", "why": "..." }],
  "emails": [{ "id": "...", "from": "...", "subject": "...", "why": "..." }]
}

If nothing in a category warrants surfacing, return an empty array for that category. Empty arrays are fine and expected — quiet morning is real signal.`;

  const userPrompt = `INBOUND TEXTS (last 24h):
${JSON.stringify(stripRaw(textsForClaude), null, 2)}

UNREAD/RECENT EMAILS (last 24h, after noise filtering):
${JSON.stringify(stripRaw(emailsForClaude), null, 2)}

Triage. Return JSON only.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      console.error('triageInbox: Claude API non-OK', resp.status);
      return { texts: [], emails: [] };
    }
    const data = await resp.json();
    const text = data?.content?.[0]?.text || '';
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    // Merge raw metadata onto Claude's output via id lookup. When Claude
    // omits or hallucinates an id, the item still flows through to the
    // email digest (which only needs from/what/why/subject), but it lacks
    // the fields the Brief view needs and will be dropped by
    // assembleActionables. Email behavior unchanged.
    const enrichItem = (item, expectedKind) => {
      const meta = item.id ? byId.get(item.id) : null;
      if (!meta || meta.kind !== expectedKind) return item;
      return { ...item, ...meta.raw };
    };

    return {
      texts: Array.isArray(parsed.texts)
        ? parsed.texts.map(t => enrichItem(t, 'text'))
        : [],
      emails: Array.isArray(parsed.emails)
        ? parsed.emails.map(e => enrichItem(e, 'email'))
        : [],
    };
  } catch (err) {
    console.error('triageInbox failed:', err.message);
    return { texts: [], emails: [] };
  }
}

function renderHouseholdCard(briefing) {
  if (!briefing) return '';

  const sections = [];

  const air = briefing.air;
  if (air && air.reading_count) {
    const stats = [];
    if (air.co2?.current != null) stats.push(`CO₂ <strong style="color:#f0f0ff;">${air.co2.current}</strong>`);
    if (air.humidity?.current != null) stats.push(`Humidity <strong style="color:#f0f0ff;">${air.humidity.current}%</strong>`);
    if (air.temp_c?.current != null) stats.push(`Temp <strong style="color:#f0f0ff;">${air.temp_c.current}°C</strong>`);
    if (air.radon_bq_m3?.current != null) stats.push(`Radon <strong style="color:#f0f0ff;">${air.radon_bq_m3.current}</strong>`);
    const anomalies = Array.isArray(air.anomalies) && air.anomalies.length
      ? `<div style="font-size:11px;color:#fbbf24;margin-top:6px;">⚠ ${esc(air.anomalies.join(' · '))}</div>`
      : '';
    if (stats.length) {
      sections.push(`
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8888aa;margin-bottom:6px;">Air</div>
          <div style="font-size:12px;color:#aaaac8;line-height:1.5;">${stats.join(' · ')}</div>
          ${anomalies}
        </div>
      `);
    }
  }

  const sleep = briefing.sleep;
  if (sleep && (sleep.score != null || sleep.readiness != null || sleep.total_hours != null)) {
    const bits = [];
    if (sleep.score != null) bits.push(`Sleep <strong style="color:#f0f0ff;">${sleep.score}</strong>`);
    if (sleep.readiness != null) bits.push(`Readiness <strong style="color:#f0f0ff;">${sleep.readiness}</strong>`);
    if (sleep.total_hours != null) bits.push(`<strong style="color:#f0f0ff;">${sleep.total_hours}h</strong> in bed`);
    sections.push(`
      <div style="margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8888aa;margin-bottom:6px;">Recovery</div>
        <div style="font-size:12px;color:#aaaac8;line-height:1.5;">${bits.join(' · ')}</div>
      </div>
    `);
  }

  const triageTexts = briefing.triage?.texts || [];
  if (triageTexts.length) {
    const rows = triageTexts.slice(0, 4).map(t => {
      const from = esc(t.from || 'Unknown');
      const what = esc((t.what || '').slice(0, 140));
      const why = esc((t.why || '').slice(0, 140));
      return `<div style="font-size:12px;color:#f0f0ff;padding:6px 0;border-bottom:1px solid #1f1f2d;">
        <div><span style="color:#7c6fef;font-weight:600;">${from}</span><span style="color:#aaaac8;"> · ${what}</span></div>
        ${why ? `<div style="color:#8888aa;font-size:11px;font-style:italic;margin-top:2px;">${why}</div>` : ''}
      </div>`;
    }).join('');
    const more = triageTexts.length > 4
      ? `<div style="font-size:11px;color:#8888aa;margin-top:6px;">+${triageTexts.length - 4} more</div>`
      : '';
    sections.push(`
      <div style="margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8888aa;margin-bottom:6px;">📱 Texts That Need You</div>
        ${rows}
        ${more}
      </div>
    `);
  }

  const triageEmails = briefing.triage?.emails || [];
  if (triageEmails.length) {
    const rows = triageEmails.slice(0, 4).map(e => {
      const from = esc(e.from || '');
      const subject = esc((e.subject || '(no subject)').slice(0, 100));
      const why = esc((e.why || '').slice(0, 140));
      return `<div style="font-size:12px;color:#f0f0ff;padding:6px 0;border-bottom:1px solid #1f1f2d;">
        <div><span style="color:#7c6fef;font-weight:600;">${subject}</span></div>
        ${from ? `<div style="color:#aaaac8;font-size:11px;margin-top:1px;">${from}</div>` : ''}
        ${why ? `<div style="color:#8888aa;font-size:11px;font-style:italic;margin-top:2px;">${why}</div>` : ''}
      </div>`;
    }).join('');
    const more = triageEmails.length > 4
      ? `<div style="font-size:11px;color:#8888aa;margin-top:6px;">+${triageEmails.length - 4} more</div>`
      : '';
    sections.push(`
      <div style="margin-bottom:4px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8888aa;margin-bottom:6px;">✉️ Email Worth Reading</div>
        ${rows}
        ${more}
      </div>
    `);
  }

  if (Array.isArray(briefing.errors) && briefing.errors.length) {
    console.error('morning-briefing partial errors:', briefing.errors);
  }

  if (!sections.length) return '';

  return `
    <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:14px;padding:18px;margin-bottom:16px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#10b981;margin-bottom:12px;">🏠 Household</div>
      ${sections.join('')}
    </div>
  `;
}

// ============================================================================
// Brief view (Phase 1) — structured actionables persisted per user per day.
//
// assembleActionables transforms the same triage data that powers the email
// household card into a checkbox-friendly shape the client can render and
// promote to STWRD tasks. The email digest is unaffected.
//
// Item categories surfaced in v1:
//   needs_reply  — iMessage / Gmail threads Claude flagged as worth a response
//   stale_task   — STWRD tasks older than 7 days that are still open
//
// The item id is the source_dedup_key for needs_reply items (built from
// stable handle + last-inbound timestamp), so re-running the digest the
// same day will reproduce the same key, but a follow-up message gets a
// fresh key. stale_task ids carry the task uuid; they're review-only in v1
// and source_dedup_key stays null since the task already exists.
// ============================================================================

async function assembleActionables(briefing, userId) {
  const items = [];
  const triage = briefing?.triage || { texts: [], emails: [] };

  for (const t of triage.texts || []) {
    if (!t.id || !t.sender) continue; // skip items triageInbox couldn't enrich
    const from = t.from || t.sender;
    const snippet = (t.last_inbound_snippet || t.what || '').slice(0, 140);
    items.push({
      id: t.id,
      category: 'needs_reply',
      subtype: 'imessage',
      title: `${from} · needs your reply`,
      snippet,
      reason: t.why || '',
      source_type: 'imessage',
      source_id: t.id,
      source_dedup_key: t.id,
      task_title: `Reply to ${from}`,
      promoted: false,
    });
  }

  for (const e of triage.emails || []) {
    if (!e.id || !e.from_address) continue;
    const subject = e.subject || '(no subject)';
    const snippet = (e.snippet || '').slice(0, 140);
    items.push({
      id: e.id,
      category: 'needs_reply',
      subtype: 'gmail',
      title: subject,
      snippet,
      reason: e.why || '',
      source_type: 'gmail',
      source_id: e.id,
      source_dedup_key: e.id,
      task_title: `Reply: ${subject}`,
      promoted: false,
    });
  }

  try {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoIso = weekAgo.toISOString();
    const staleTasks = await sbFetch(
      `tasks?user_id=eq.${userId}&status=neq.done&created_at=lt.${encodeURIComponent(weekAgoIso)}&order=created_at.asc&limit=10`,
      true
    ) || [];

    for (const task of staleTasks) {
      const title = task.cleaned_task || task.content || '(untitled task)';
      const meta = [task.project, task.priority].filter(Boolean).join(' · ');
      items.push({
        id: `stale_task:${task.id}`,
        category: 'stale_task',
        title,
        snippet: meta,
        reason: '',
        source_type: 'stwrd_task',
        source_id: String(task.id),
        source_dedup_key: null,
        task_title: title,
        action: 'review',
        promoted: false,
      });
    }
  } catch (err) {
    console.error(`assembleActionables: stale tasks query failed for ${userId}:`, err.message);
  }

  return items;
}

async function upsertDailyBrief(userId, briefDate, payload) {
  const serviceKey = getServiceKey();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_briefs?on_conflict=user_id,brief_date`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        brief_date: briefDate,
        payload,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`daily_briefs upsert ${res.status}: ${errText.slice(0, 300)}`);
  }
}
