# STWRD Backlog

Living list of bugs, tech debt, follow-ups, and feature ideas. Add to it freely. When picking up a session, scan this first.

Last updated: 2026-05-03 (post-Phase 2b ship)

---

## Bugs (real, observable)

- **loadPartner storm.** ~8 invocations of loadPartner per partner-view switch (visible as 8x `[STWRD] loadPartner found` + `[STWRD] Partner loaded` log pairs in console). Only 3 callers in code (init at 1903, switchView fallback at 6911, acceptInvite at 7101). Real cause unclear; could be switchView called multiple times, realtime subscription re-trigger, or auth event re-fire. Don't add a naive `if (partnerData) return` guard without first tracing — could mask legitimate refresh triggers.

- **fetchCalendarEvents and fetchCalendarEventsRange lack partner-aware 401 retry.** Phase 2b patched this for listUserCalendars (lines 2239-2241) but the same pattern is missing in the other two fetch sites. Risk: partner's expired token could trigger clearGcalToken() and wipe self localStorage. Mirror the listUserCalendars fix.

- **reconnectGcal does not clear calendarListCache.** Only clears calendarRangeCache (via clearCalendarCache at line 2081). On reconnect, stale calendar list could be served for up to GCAL_LIST_TTL_MS.

- **Two stale Vijay profiles in DB.** Active is 2e5683e0-c6ad-483f-b31d-c93f097c0aeb. Stale is 52813d71-b9b3-4ef0-abce-270f60d0902b. Should be removed (or investigated as to how it got created).

- **renderStats partner/self mixing.** Flagged from earlier session. Stats counts may include the wrong user when viewingPartner toggles.

## Tech debt

- **.gitignore missing `.DS_Store` and `.claude/`.** Both currently show as untracked. Add them.

- **No global escape hatch for Supabase client.** Setting `window.__sb = sbClient` in dev mode would dramatically speed up debugging (we wasted ~30 min last session digging localStorage adapters because sbClient wasn't accessible from console).

- **Three error response shapes across api/.** digest.js, refresh-gcal-token.js, and other endpoints use slightly different JSON error formats. Unify.

- **Beta guide PDF needs update.** Doesn't reflect partner calendar feature.

## Investigations needed

- **"Needs Attention" badges on Vercel env vars.** ANTHROPIC_API_KEY, SUPABASE_SERVICE_KEY, RESEND_API_KEY all show this badge. Unclear why; may be fine but worth checking before next deploy that touches env.

## Features (Season 2+)

- **Routines analysis for briefings.** Daily logistics + trend optimization. Examples: "leave by 7:15am to get Sail to school," "you're consistently 10 min late, wake earlier," recurring patterns identified across days/weeks.

---

## Recently shipped (kept for reference, prune later)

- 2026-05-03 Phase 2b: client wrapper getCalendarTokenForUser (commit 43584ff)
- 2026-05-02 Phase 2: server endpoint api/refresh-gcal-token.js (commit ace5a6a)
- 2026-05-02 Phase 1: gcal_refresh_token persistence on PKCE sign-in (commit 5a52dd1)
