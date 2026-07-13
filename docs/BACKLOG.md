# STWRD Backlog

Living list of bugs, tech debt, follow-ups, and feature ideas. Add to it freely. When picking up a session, scan this first.

Last updated: 2026-07-13 (pruned: removed items shipped 7/11-7/12; verified each against current code)

VERIFY BEFORE YOU QUEUE: check an item's premise against the current code before acting on it (or handing it to the background agent). A wrong premise produces a plausible, gate-passing, but pointless or harmful change. Several items below were carried as "open" long after they shipped.

---

## NOW (pick up next)

- **loadPartner storm.** ~4-8 invocations of loadPartner per partner-view switch. Real cause unclear — switchView re-fires, realtime subscription, or auth event re-trigger. Needs TRACING first; not a code-edit the background agent should attempt. Don't add a naive `if (partnerData) return` guard without first tracing.

- **Beta guide PDF refresh.** Doesn't reflect partner calendar feature, life areas hide, or the silent-auth-refresh behavior. Product judgment + PDF work. Update before next beta-onboarding moment.

## iMessage sync — capture sent messages + surface in Brief

Two separate loops, do not bundle:

1. Sync pipeline change: capture MY sent messages, not just incoming.
   - PRIVACY REVIEW REQUIRED before building. This expands what personal
     message data flows local Mac -> Supabase imessages table -> digest.
     Decide explicitly: what gets stored, what the digest does with it,
     what the surface looks like with beta couples involved.
   - Scope this as its own loop. Touches the local Node.js pipeline.

2. Brief tab surfacing: show message-derived reminders in the Brief tab
   itself, not only the digest.
   - Separate loop. Touches Brief rendering in index.html.
   - Depends on loop 1 landing first (needs the sent-message data).

Captured 5/14/26. Needs a fresh session, clear head, one loop at a time.

---

## Bugs / cleanup (real, observable)

- **Two stale Vijay profiles in DB.** Active is 2e5683e0-c6ad-483f-b31d-c93f097c0aeb. Stale is 52813d71-b9b3-4ef0-abce-270f60d0902b. Should be removed (or investigated as to how it got created). NOTE: this is a data deletion — do by hand, not via the agent.

## Investigations needed

- **"Needs Attention" badges on Vercel env vars.** ANTHROPIC_API_KEY, SUPABASE_SERVICE_KEY, RESEND_API_KEY all show this badge. Unclear why; may be fine but worth checking before next deploy that touches env.

## Features (Season 2+)

- **Routines analysis for briefings.** Daily logistics + trend optimization. Examples: "leave by 7:15am to get Sail to school," "you're consistently 10 min late, wake earlier," recurring patterns identified across days/weeks.

- **C2 follow-ups for iCal.** RRULE recurring event support, ETag caching, multi-feed support, "Test feed" button on Settings page.

- **One-tap OAuth integrations (Season 2 vision).** Google Calendar, Gmail, Plaid — couples connect accounts like Mint/YNAB, STWRD merges both partners' data into the digest automatically. Don't build until beta couples signal which integrations matter most.

## Tested-module extraction (background-agent-friendly pattern)

The section/ordering/date/stats logic is now extracted into tested `lib/*.mjs` modules (see below). Remaining inline functions in index.html are mostly render-coupled (they build DOM strings), which do NOT fit the pure-extraction pattern. Only queue a further extraction if the target is genuinely pure; otherwise it needs a human.

---

## Recently shipped

Pruning policy: drop entries older than ~2 weeks during weekly review.

- 2026-07-12 lib/task-ordering merged into lib/task-sections.mjs (dd1849c): PRIORITY_RANK, priorityRank, sortWithinSection, groupTasksBySections now pure + tested. Background agent; reviewed; 36 tests total pass.
- 2026-07-12 lib/task-sections.mjs (42d7fcb): isOverdue, taskDateSection, TASK_SECTION_ORDER/LABELS extracted + tested. Background agent.
- 2026-07-12 lib/task-dates.mjs (d9949af): humanDueLabel, daysBetween extracted + tested. First fully-autonomous clean merge.
- 2026-07-12 renderStats partner/self mixing RESOLVED: renderStats resolves viewedUserId/viewedUserName from viewingPartner and passes them through computeStats (lib/stats.mjs, 94b5e0e). Was listed as a NOW bug; verified fixed.
- 2026-07-12 fetchCalendarEvents / fetchCalendarEventsRange 401 handling: closed BY DESIGN. Both throw CalendarAuthExpiredError on 401/403 (Loop E) to surface the reauth banner instead of silently retrying. The old "wipes self localStorage" premise no longer holds. Do NOT re-queue the "mirror listUserCalendars retry" item.
- 2026-07-12 generateBriefing anthropic_key fallback (680dcdf): now `currentUserProfile?.anthropic_key || localStorage.getItem('apiKey') || null`.
- 2026-07-12 Inline "life area" user-facing copy cleanup (e33697c).
- 2026-07-12 Unified api/ JSON error shape to `{ error: { message } }` + client readers (0dd37ff).
- 2026-07-12 reconnectGcal clears calendarListCache on reconnect (e251f02).
- 2026-07-11 window.__sb dev-only Supabase handle (50d6e1d).
- 2026-05-04 Auth refresh path: client-side refreshGcalToken + ensureCalendarToken (d6d7e57). Closes C1 Phase 2.
- 2026-05-03 Life Areas UI hide: CSS-only hide of 6 surfaces, reversible (29d8648).
- 2026-05-03 C2 iCal feed support: api/fetch-ical.js + briefing integration (f856119).
