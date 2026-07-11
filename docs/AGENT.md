# STWRD background backlog agent

A headless loop that lets Claude Code work one backlog item at a time, produce a
reviewable branch, and stop. It is deliberately human-in-the-loop: the agent
never pushes, never merges, and never touches production. You review and merge.

## The loop

`scripts/agent-loop.sh` does, per run:

1. Preflight: confirm `scripts/validate.mjs` exists, `claude` is on PATH, and the
   working tree is clean. Abort otherwise.
2. Pick one item: the argument you pass, or the first `- [ ]` line in `agent/queue.md`.
3. Branch `claude/auto-<timestamp>` off an up-to-date base (`main`).
4. Run Claude Code headless with a tight tool allowlist (`Read`, `Edit`, and only
   `Bash(node scripts/validate.mjs)`) and guardrail instructions. Everything else,
   including git, network, `.env`, `migrations/`, and `.github/`, is blocked.
5. Scope guard: if the agent changed any forbidden path, discard and stop.
6. Gate: re-run `node scripts/validate.mjs`. This is authoritative — if it exits
   non-zero, the branch is discarded and the base is left untouched.
7. On pass: commit to the review branch. It is **not** pushed.

## Why it is safe

The gate is enforced by the script, not trusted to the agent, so a run that
breaks syntax, leaks a key, or fails the batteries can never produce a kept
branch. The agent can't reach main, migrations, secrets, or the network. The
worst case of a bad run is a discarded branch and a log — your base branch and
production are never affected. This matches the CLAUDE.md guidance to avoid full
auto mode (the permission classifier misses roughly one in six overeager
actions), so a human still approves every merge.

## Running it

By hand, one item, first:

    ./scripts/agent-loop.sh "Add window.__sb = sbClient in dev mode only for console debugging"

Or queue-driven (works the first unchecked item in `agent/queue.md`):

    ./scripts/agent-loop.sh

Then review and merge yourself:

    git log -p claude/auto-<timestamp>
    git checkout main && git merge --no-ff claude/auto-<timestamp>
    git push           # you push; the agent never does

Run logs land in `agent/runs/<timestamp>.md` (gitignored).

## Prerequisites

- The validation-gate PR must be merged into `main` so `scripts/validate.mjs`
  is present on the base branch.
- The `claude` CLI installed and authenticated on the machine that runs it.

## Scheduling (optional, do last)

Only after a manual run looks right, install `agent/com.stwrd.agent-loop.plist`
(edit the paths first) to run one loop each morning. See the comments in that
file. It still only produces a review branch.

## Tuning

Environment overrides: `STWRD_AGENT_MODEL` (default `sonnet`),
`STWRD_AGENT_TURNS` (default `25`), `STWRD_BASE_BRANCH` (default `main`).

## Queue hygiene

Only queue small, concrete, gate-checkable items. Items that need a live API
battery to prove correctness should be run by hand with
`node scripts/validate.mjs --batteries`. Never queue work under `migrations/`,
`.env`, or `.github/` — the agent is blocked from those by design.
