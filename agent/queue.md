# STWRD agent queue

The background agent (`scripts/agent-loop.sh`) works the FIRST unchecked
`- [ ]` line below, one per run. Keep items small, self-contained, and
verifiable by the gate. Only queue work you'd be comfortable letting the
agent attempt unattended; you still review every branch before merging.

Mark an item `- [x]` once its branch is merged. Delete stale items freely.

## Queue

<!-- Good starter items (gate gives them real done-states). Uncomment to enable: -->
<!-- - [ ] Add `window.__sb = sbClient` in dev mode only, for console debugging (tech-debt item in docs/BACKLOG.md). -->
<!-- - [ ] Unify the JSON error shape across api/digest.js, api/refresh-gcal-token.js, api/fetch-ical.js into one { error: { message } } form. -->

## Do NOT queue here
- Anything touching migrations/, .env, or .github/ (the agent is blocked from these by design).
- Anything needing a live API battery to prove correctness — run those by hand with `node scripts/validate.mjs --batteries`.
- Vague items ("improve mobile UX"). The agent needs a concrete, checkable task.
