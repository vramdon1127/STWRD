// C2 follow-up — fetch a user's iCal feed and return events overlapping a window.
// Mirrors api/refresh-gcal-token.js auth model:
//   1. Caller sends Supabase JWT in Authorization header + {userId, timeMin, timeMax} in body
//   2. Verify JWT against /auth/v1/user, extract requesterId
//   3. If userId === requesterId, skip partnership check (self)
//   4. Else, call is_partner_or_self() RPC with caller's JWT (RLS enforces partnership)
//   5. Use SERVICE_KEY to read profiles.ical_feed_url for the target user
//   6. Rewrite webcal:// → https://, fetch raw text, parse minimally
//   7. Skip RRULE events (recurring) tonight — too risky without a real iCal lib
//   8. Filter to events overlapping [timeMin, timeMax], return Google-shaped events
//
// Why no library: node-ical / ical.js carry runtime risk on Vercel and we have no
// package.json today. A 50-line parser handles the SUMMARY / DTSTART / DTEND /
// LOCATION / DESCRIPTION / UID subset that briefings need.

const SUPABASE_URL = 'https://fnnegalrrdzcgoelljmi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZubmVnYWxycmR6Y2dvZWxsam1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDMwNjksImV4cCI6MjA5MTUxOTA2OX0.bhgk6czCQYTuUGnu5Zv7pml9uMuPrp4I1VBSzVIHwqw';

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

// Minimal iCal parser. Produces Google-shaped event objects:
//   { id, summary, start: {dateTime|date}, end: {...}, location?, description?,
//     _calendarId: 'ical', _calendarName: 'iCal Feed', attendee_count: 0 }
// Skips events with RRULE. Caller filters by overlap window.
function parseIcalEvents(rawText) {
  // Step 1: unfold continuation lines (RFC 5545 §3.1: next line starts with space/tab).
  const folded = String(rawText).replace(/\r\n/g, '\n');
  const lines = [];
  for (const ln of folded.split('\n')) {
    if (lines.length > 0 && (ln.startsWith(' ') || ln.startsWith('\t'))) {
      lines[lines.length - 1] += ln.slice(1);
    } else {
      lines.push(ln);
    }
  }

  // Step 2: walk lines, collect VEVENT blocks.
  const events = [];
  let cur = null;
  for (const ln of lines) {
    if (ln === 'BEGIN:VEVENT') {
      cur = {};
    } else if (ln === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const colonIdx = ln.indexOf(':');
      if (colonIdx === -1) continue;
      const lhs = ln.slice(0, colonIdx);
      const value = ln.slice(colonIdx + 1);
      // lhs is either "KEY" or "KEY;PARAM=...;PARAM=..."
      const semiIdx = lhs.indexOf(';');
      const key = (semiIdx === -1 ? lhs : lhs.slice(0, semiIdx)).toUpperCase();
      const params = semiIdx === -1 ? '' : lhs.slice(semiIdx + 1);
      cur[key] = { value, params };
    }
  }

  // Step 3: convert raw blocks → Google-shaped events. Skip recurring (RRULE).
  const out = [];
  for (const ev of events) {
    if (ev.RRULE) continue; // skip recurring per scope
    const dtstartRaw = ev.DTSTART;
    const dtendRaw = ev.DTEND;
    if (!dtstartRaw) continue; // malformed; skip
    const start = icalDateToGoogle(dtstartRaw);
    const end = dtendRaw ? icalDateToGoogle(dtendRaw) : start;
    if (!start) continue;
    const uid = ev.UID?.value || `ical-${Math.random().toString(36).slice(2)}`;
    out.push({
      id: uid,
      summary: unescapeIcalText(ev.SUMMARY?.value || ''),
      start,
      end,
      location: ev.LOCATION ? unescapeIcalText(ev.LOCATION.value) : undefined,
      description: ev.DESCRIPTION ? unescapeIcalText(ev.DESCRIPTION.value) : undefined,
      attendee_count: 0,
      _calendarId: 'ical',
      _calendarName: 'iCal Feed'
    });
  }
  return out;
}

// Convert {value, params} from DTSTART/DTEND to Google {dateTime} or {date}.
// Floating times (no Z, no TZID) are treated as UTC for filter consistency —
// the brief may render the wrong wall-clock time but the date filter stays sane.
function icalDateToGoogle(raw) {
  const v = raw.value;
  const isDateOnly = /VALUE=DATE(?:[^-]|$)/i.test(raw.params || '');
  if (isDateOnly || /^\d{8}$/.test(v)) {
    // YYYYMMDD all-day
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // Datetime: YYYYMMDDTHHMMSS[Z]
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || 'Z'}`;
  return { dateTime: iso };
}

function unescapeIcalText(s) {
  return String(s)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Event overlap filter. Inputs are ms epochs. Event missing a key gets ±Infinity
// so partial events still match if any side overlaps the window.
function eventEpochs(ev) {
  const startMs = ev.start?.dateTime ? Date.parse(ev.start.dateTime)
                : ev.start?.date     ? Date.parse(ev.start.date + 'T00:00:00Z')
                :                      null;
  const endMs   = ev.end?.dateTime   ? Date.parse(ev.end.dateTime)
                : ev.end?.date       ? Date.parse(ev.end.date + 'T00:00:00Z')
                :                      startMs;
  return [startMs, endMs];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('[fetch-ical] SUPABASE_SERVICE_KEY not configured');
    return res.status(500).json({ error: 'service_key_not_configured' });
  }

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) {
    return res.status(401).json({ error: 'missing_auth' });
  }

  const { userId, timeMin, timeMax } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'missing_user_id' });
  }
  if (!timeMin || !timeMax) {
    return res.status(400).json({ error: 'missing_time_window' });
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

    // Step 3: Read iCal feed URL (service role)
    const profileRes = await sbFetch(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=ical_feed_url`,
      { useServiceRole: true }
    );
    if (!profileRes.ok) {
      console.error('[fetch-ical] profile read failed', profileRes.status);
      return res.status(500).json({ error: 'profile_read_failed' });
    }
    const rawUrl = profileRes.data?.[0]?.ical_feed_url;
    if (!rawUrl) {
      return res.status(404).json({ error: 'no_ical_feed' });
    }

    // Step 4: Normalize webcal:// → https:// and fetch the feed.
    const feedUrl = rawUrl.replace(/^webcal:\/\//i, 'https://');
    const feedRes = await fetch(feedUrl, {
      redirect: 'follow',
      headers: { 'Accept': 'text/calendar, text/plain, */*' }
    });
    if (!feedRes.ok) {
      console.error('[fetch-ical] feed fetch failed', feedRes.status, feedUrl);
      return res.status(502).json({ error: 'feed_fetch_failed' });
    }
    const feedText = await feedRes.text();

    // Step 5: Parse and filter to overlap window.
    const all = parseIcalEvents(feedText);
    const minMs = Date.parse(timeMin);
    const maxMs = Date.parse(timeMax);
    const filtered = all.filter(ev => {
      const [s, e] = eventEpochs(ev);
      if (s == null) return false;
      // Overlap: event starts before window ends AND ends after window starts.
      return s <= maxMs && (e == null ? s : e) >= minMs;
    });

    return res.status(200).json({ events: filtered });
  } catch (err) {
    console.error('[fetch-ical] unexpected error', err);
    return res.status(500).json({ error: 'unexpected_error' });
  }
}
