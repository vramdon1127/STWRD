# Task-view improvements — ideation

Small, high-leverage sharpening passes on how tasks are **displayed, sorted,
filtered, and interacted with** in existing views. No new data, no new
integrations, no schema changes. Companion to the priority-sort commit
(`4b6126e`).

Ranking is by expected beta impact × efficiency — the items at the top will
move the needle furthest for Mia on day 1 relative to the effort they cost.

---

## 1. Overdue treatment in the project view

- **What:** Today view already highlights overdue tasks with a red header
  and red accent bar. Project view does not — an overdue task sits in the
  list with nothing but a date chip. Give overdue tasks the same visual
  treatment in the project view (red left-bar, subtle tint, "Overdue"
  label) and float them above everything else, including P1.
- **Size:** small
- **Beta impact:** high — Mia is likely to live in project views more than
  the Today view, so an overdue task can currently go silently unseen
- **Dependencies:** reuses the `.pri-p1` card CSS just landed; no blockers

## 2. Humanized due-date labels

- **What:** Due dates currently render as `04/23/26` — readable but
  requires a mental conversion. Show "Today", "Tomorrow", "In 3 days",
  "Last Tuesday", "Next Wed" depending on proximity. Fall back to
  `MMM D` for dates >2 weeks away.
- **Size:** small
- **Beta impact:** high — lowers the reading-cost of every task card,
  every day
- **Dependencies:** none. Swap the date chip formatter in five render
  sites (`renderHatTasks`, `renderTodayCard`, drilldown x2, life
  drilldown)

## 3. Date-window section dividers in the project view

- **What:** Within a project, group tasks under "Overdue / Today / This
  Week / Later / No due date" headers (still priority-sorted inside each
  section). Mia scans *when* before *what*.
- **Size:** medium
- **Beta impact:** high — the single biggest cognitive load in a project
  view is figuring out which tasks are time-sensitive. This solves it.
- **Dependencies:** layers on top of #1 and the priority sort. Should
  ship after #1 so overdue styling is already in place.

## 4. Collapsible "Completed" section at the bottom

- **What:** Completed tasks currently sink to the bottom (as of the
  priority-sort commit) but still render inline. After ~3 completed
  tasks, collapse them behind a `✓ Completed (12) ▾` toggle that
  expands on tap.
- **Size:** small
- **Beta impact:** medium — active projects accumulate completions
  quickly and currently crowd out the live work
- **Dependencies:** depends on the priority-sort commit (done). No other
  blockers.

## 5. Count badges on the category-filter chips

- **What:** The filter row in the project view is `All | AI Complete |
  AI Assist | Manual`. Tapping into an empty category is silently dead
  — user sees the empty state and has to back out. Show counts on each
  chip: `All (12) | AI Complete (3) | AI Assist (5) | Manual (4)`.
- **Size:** small
- **Beta impact:** medium — small friction win, compounds across every
  session
- **Dependencies:** none

## 6. Project-view header with P1 / overdue summary

- **What:** When a project is open, the sticky header shows only the
  project name. Add a one-line subtitle: `3 urgent · 2 overdue · 12
  total`. Turns the header into a status bar instead of a label.
- **Size:** small
- **Beta impact:** medium — gives Mia a sense of "where I stand" in
  each project without having to scan the list
- **Dependencies:** wants #1 (overdue concept wired through project
  view) to be meaningful. Ship after or alongside #1.

## 7. Per-scenario empty states

- **What:** Current empty state is one-size-fits-all ("No tasks here").
  Branch on context:
  - all-tasks-completed → "🎉 All clear in {project} — well done"
  - filter returned zero but project has tasks → "No AI Complete tasks
    yet. Try adding one from the capture bar."
  - project genuinely empty → current copy
- **Size:** small
- **Beta impact:** medium — shows the product noticing what the user
  is doing, a small but real trust-builder for a non-technical couple
- **Dependencies:** none

## 8. Swipe-to-complete (mobile)

- **What:** Left-swipe a task card → snap animation → mark done. Current
  flow is tap-the-round-checkbox, which is a small target on a phone and
  requires precision. Long-press for multi-select already exists and
  should continue to take priority over swipe.
- **Size:** medium
- **Beta impact:** medium — real quality-of-life win on phone, but not
  discoverable without onboarding so impact is gradual, not day-1
- **Dependencies:** must not conflict with existing long-press
  selection and the scroll direction; needs a small gesture-guard
  (angle/threshold) before implementing

---

## Not included — explicitly out of scope

These got considered and cut because they either belong to a different
category or break the "no new data/schema/integrations" rule:

- Keyboard shortcuts (`/` to focus capture, `esc` to exit selection,
  `1–4` to set priority) — useful but Mia is a mobile user; ship after
  desktop becomes a real second-surface
- Drag-to-reorder — already listed in LATER backlog; this is a
  different category (manual ordering vs. smart display)
- Task grouping/clustering by theme — already in LATER; needs Claude
  classification, not a display change
- Due-date or priority setting from within the card — this is
  *creation/editing*, which the prompt explicitly excluded

## Recommended pick for the next loop

If you want to pick one: **#1 (overdue treatment in project view)** is
the highest-leverage small commit. It reuses the CSS pattern that just
landed, reduces a real risk (Mia missing an overdue task), and unlocks
#3 and #6. **#2 (humanized dates)** is the second-cheapest universal
upgrade and pairs well with #1 in one short session.
