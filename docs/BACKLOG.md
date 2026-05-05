# STWRD Backlog

Living list of bugs, tech debt, follow-ups, and feature ideas. Add to it freely. When picking up a session, scan this first.

Last updated: 2026-05-04 (post-auth-refresh fix + Sunday ships + repo cleanup)

---

## NOW (pick up next)

- **loadPartner storm.** ~4-8 invocations of loadPartner per partner-view switch. Real cause unclear — switchView re-fires, realtime subscription, or auth event re-trigger. Don't add a naive `if (partnerData) return` guard without first tracing.

- **renderStats partner/self mixing.** Stats counts may include the wrong user when viewingPartner toggles. Audit which user_id is filtered at each call site.

- **Beta guide PDF refresh.** Doesn't reflect partner calendar feature, life areas hide, or tonight's silent-auth-refresh behavior. Update before next beta-onboarding moment.

---

## Bugs (real, observable)

- **fetchCalendarEvents and fetchCalendarEventsRange lack partner-aware 401 retry.** Phase 2b patched this for listUserCalendars (lines 2239-2241) but the same pattern is missing in the other two fetch sites. Risk: partner's expired token could trigger clearGcalToken() and wipe self localStorage. Mirror the listUserCalendars fix.

- **reconnectGcal does not clear calendarListCache.** Only clears calendarRangeCache (via clearCalendarCache at line 2081). On reconnect, stale calendar list could be served for up to GCAL_LIST_TTL_MS.

- **Two stale Vijay profiles in DB.** Active is 2e5683e0-c6ad-483f-b31d-c93f097c0aeb. Stale is 52813d71-b9b3-4ef0-abce-270f60d0902b. Should be removed (or investigated as to how it got created).

## Tech debt

- **No global escape hatch for Supabase client.** Setting `window.__sb = sbClient` in dev mode would dramatically speed up debugging (we wasted ~30 min last session digging localStorage adapters because sbClient wasn't accessible from console).

- **Three error response shapes across api/.** digest.js, refresh-gcal-token.js, fetch-ical.js, and other endpoints use slightly different JSON error formats. Unify.

- **Inline "life area" copy cleanup.** index.html lines 972, 1208, 1579, 3663 still mention "life area" in user-facing copy even though the feature is hidden. CSS-only hide (commit 29d8648) is restoreable, but the copy reads strangely until the feature ships again. Either rephrase or also hide via CSS.

- **`generateBriefing` apiKey fallback.** Doesn't fall back to `currentUserProfile?.anthropic_key` — real correctness gap from C2.

## Investigations needed

- **"Needs Attention" badges on Vercel env vars.** ANTHROPIC_API_KEY, SUPABASE_SERVICE_KEY, RESEND_API_KEY all show this badge. Unclear why; may be fine but worth checking before next deploy that touches env.

## Features (Season 2+)

- **Routines analysis for briefings.** Daily logistics + trend optimization. Examples: "leave by 7:15am to get Sail to school," "you're consistently 10 min late, wake earlier," recurring patterns identified across days/weeks.

- **C2 follow-ups for iCal.** RRULE recurring event support, ETag caching, multi-feed support, "Test feed" button on Settings page.

- **One-tap OAuth integrations (Season 2 vision).** Google Calendar, Gmail, Plaid — couples connect accounts like Mint/YNAB, STWRD merges both partners' data into the digest automatically. Don't build until beta couples signal which integrations matter most.

---

## Recently shipped

Pruning policy: drop entries older than ~2 weeks during weekly review.

- 2026-05-04 Auth refresh path: client-side refreshGcalToken + ensureCalendarToken integration (commit d6d7e57). **Closes C1 Phase 2.** Calendar features no longer prompt for re-auth every ~hour.
- 2026-05-04 Repo cleanup: gitignore .DS_Store + .claude/ (commit 0773780); 17 stale claude/* branches deleted (no commit, branch ops only).
- 2026-05-03 Life Areas UI hide: CSS-only hide of 6 surfaces, data + backend preserved, fully reversible (commit 29d8648).
- 2026-05-03 Settings UI for ical_feed_url + calendar_source_user_id (commit 446cd8c).
- 2026-05-03 C2 iCal feed support: api/fetch-ical.js + briefing integration (commit f856119).
- 2026-05-03 C2 calendar-source override + cache fixes: per-userId Maps replacing singletons (commits 194809b, 27bf813).
- 2026-05-03 Phase 2b: client wrapper getCalendarTokenForUser (commit 43584ff).
- 2026-05-02 Phase 2: server endpoint api/refresh-gcal-token.js (commit ace5a6a).
- 2026-05-02 Phase 1: gcal_refresh_token persistence on PKCE sign-in (commit 5a52dd1).
