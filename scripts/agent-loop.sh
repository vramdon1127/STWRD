#!/usr/bin/env bash
# ============================================================================
# STWRD background backlog agent — ONE item per run, on a review branch, stop.
# ============================================================================
#
# Loop (from the 2026-07-07 plan): pick the next item, run Claude Code headless
# with a bounded tool allowlist, run the validation gate, and commit to a
# claude/auto-<date> review branch ONLY if the gate passes and no forbidden
# file was touched. Never pushes, never touches main, migrations, .env, or
# .github. You review the branch and merge by hand.
#
# The gate is authoritative: even if the agent skips or fudges its own check,
# this script re-runs `node scripts/validate.mjs` and discards the branch on
# any non-zero exit.
#
# Usage:
#   scripts/agent-loop.sh "renderStats partner/self mixing: audit user_id ..."
#   scripts/agent-loop.sh          # no arg → first unchecked item in agent/queue.md
#
# Env overrides:
#   STWRD_AGENT_MODEL   (default: sonnet)
#   STWRD_AGENT_TURNS   (default: 50)
#   STWRD_BASE_BRANCH   (default: main)
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BASE_BRANCH="${STWRD_BASE_BRANCH:-main}"
MODEL="${STWRD_AGENT_MODEL:-sonnet}"
TURNS="${STWRD_AGENT_TURNS:-50}"
QUEUE="$REPO_ROOT/agent/queue.md"
RUN_DIR="$REPO_ROOT/agent/runs"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
BRANCH="claude/auto-$STAMP"
FROM_QUEUE=0
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/$STAMP.md"

# Concurrency guard: only one run at a time. mkdir is atomic, so overlapping
# scheduled + manual runs can't both proceed and scramble the queue/branches.
# The lock lives under agent/runs/ (gitignored), so it never dirties the tree.
# The trap is armed ONLY after we win the lock, so a losing run can't delete it.
LOCK="$RUN_DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another agent-loop run is active ($LOCK); exiting." >&2
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

log() { echo "$@" | tee -a "$LOG" ; }

discard_branch() {
  git reset --hard --quiet 2>/dev/null || true
  git clean -fd --quiet 2>/dev/null || true
  git checkout "$BASE_BRANCH" --quiet 2>/dev/null || true
  git branch -D "$BRANCH" --quiet 2>/dev/null || true
}

# Advance the queue after an item is processed so scheduled/unattended runs move
# to the next item instead of redoing the first one forever. Marks the first
# unchecked item done with the outcome. Only ever edits agent/queue.md, which is
# gitignored, so it never dirties the tree for the next run's preflight. No-op
# for manual runs (item passed as an argument, FROM_QUEUE=0).
mark_done() {
  [ "$FROM_QUEUE" = "1" ] || return 0
  QUEUE="$QUEUE" OUTCOME="$1" STAMP="$STAMP" python3 - <<'PY' 2>/dev/null || true
import os
q, outcome, stamp = os.environ['QUEUE'], os.environ['OUTCOME'], os.environ['STAMP']
try:
    lines = open(q, encoding='utf-8').read().split('\n')
except FileNotFoundError:
    raise SystemExit(0)
for i, l in enumerate(lines):
    if l.startswith('- [ ] '):
        lines[i] = '- [x] ' + l[6:] + f'  → {outcome} ({stamp})'
        break
open(q, 'w', encoding='utf-8').write('\n'.join(lines))
PY
}

# --- 0. Preflight -----------------------------------------------------------
if [ ! -f scripts/validate.mjs ]; then
  log "ABORT: scripts/validate.mjs not found. Merge the validation-gate PR into $BASE_BRANCH first."
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  log "ABORT: 'claude' CLI not on PATH."
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  log "ABORT: working tree is not clean. Commit or stash first."
  exit 1
fi

# --- 1. Pick the item -------------------------------------------------------
ITEM="${1:-}"
if [ -z "$ITEM" ] && [ -f "$QUEUE" ]; then
  ITEM="$(grep -m1 '^- \[ \] ' "$QUEUE" | sed 's/^- \[ \] //' || true)"
  [ -n "$ITEM" ] && FROM_QUEUE=1
fi
if [ -z "$ITEM" ]; then
  log "No item to work. Pass one as an argument, or add a '- [ ] ...' line to agent/queue.md."
  exit 0
fi

# --- 2. Fresh review branch off an up-to-date base --------------------------
git checkout "$BASE_BRANCH" --quiet
git pull --ff-only --quiet 2>/dev/null || log "(note: could not fast-forward $BASE_BRANCH; using local state)"
git checkout -b "$BRANCH" --quiet

log "# STWRD agent run $STAMP"
log ""
log "- item: $ITEM"
log "- branch: $BRANCH (base: $BASE_BRANCH)"
log "- model: $MODEL, max-turns: $TURNS"
log ""

# --- 3. Run Claude Code, bounded --------------------------------------------
GUARDRAILS=$(cat <<'EOF'
You are the STWRD background backlog agent. Rules, in priority order:
1. Work ONLY the single task you are given. Do not expand scope.
2. Make the smallest change that resolves it. Prefer root cause over symptom.
3. You MUST run `node scripts/validate.mjs` and confirm it exits 0 before finishing.
4. Do NOT run git, push, deploy, or apply any database migration.
5. Do NOT edit .env files, anything under migrations/, or anything under .github/.
6. If the task is unclear, risky, or you are not confident, make NO changes and
   explain why. A clean no-op is a valid, preferred outcome over a risky guess.
EOF
)

set +e
claude -p "Task: $ITEM" \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Bash(node scripts/validate.mjs)" \
  --disallowedTools "Edit(.env),Edit(.env.*),Edit(migrations/**),Edit(.github/**),Read(.env),Read(.env.*)" \
  --max-turns "$TURNS" \
  --model "$MODEL" \
  --append-system-prompt "$GUARDRAILS" \
  --output-format json > "$RUN_DIR/$STAMP.claude.json" 2>>"$LOG"
CLAUDE_RC=$?
set -e
log "claude exit code: $CLAUDE_RC"

# --- 4. Deterministic scope guard (independent of the agent) ----------------
CHANGED="$(git status --porcelain | sed 's/^...//')"
if [ -z "$CHANGED" ]; then
  log "No file changes produced. Discarding branch; base untouched."
  mark_done "no changes"
  discard_branch
  exit 0
fi
log ""
log "changed files:"
printf '%s\n' "$CHANGED" | sed 's/^/  - /' | tee -a "$LOG"
if printf '%s\n' "$CHANGED" | grep -Eq '(^|/)\.env|^migrations/|^\.github/'; then
  log "ABORT: agent touched a forbidden path (.env / migrations / .github). Discarding."
  mark_done "aborted: forbidden path"
  discard_branch
  exit 1
fi

# --- 5. The gate is authoritative ------------------------------------------
set +e
node scripts/validate.mjs >>"$LOG" 2>&1
GATE_RC=$?
set -e
log "validate.mjs exit code: $GATE_RC"
if [ "$GATE_RC" -ne 0 ]; then
  log "GATE FAILED. Discarding branch; base untouched. See log above."
  mark_done "gate failed"
  discard_branch
  exit 1
fi

# --- 6. Commit to the review branch (NEVER push) ----------------------------
git add -A
git commit -q \
  -m "auto: ${ITEM:0:72}" \
  -m "Worked by the STWRD background agent on $STAMP. Validation gate passed. Review before merging; this branch was never pushed automatically."
log ""
log "COMMITTED to $BRANCH (not pushed)."
log "Review:  git log -p $BRANCH"
log "Merge:   git checkout $BASE_BRANCH && git merge --no-ff $BRANCH   (then push yourself)"
git checkout "$BASE_BRANCH" --quiet
mark_done "committed $BRANCH"
log "Back on $BASE_BRANCH. Done."
