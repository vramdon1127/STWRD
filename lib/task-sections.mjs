// lib/task-sections.mjs — pure task-section and task-ordering helpers
// extracted from index.html. isOverdue, taskDateSection, and
// groupTasksBySections take the caller's "today" as an explicit YYYY-MM-DD
// string instead of reading the clock (todayStr()) internally, so they're
// deterministic and unit-testable without mocking time.
//
// Browser bridge (no build step): index.html loads this as a module and
// exposes it to the classic inline script, e.g. near the top of <head>:
//   <script type="module">
//     import { isOverdue, taskDateSection, TASK_SECTION_ORDER, TASK_SECTION_LABELS, priorityRank, sortWithinSection, groupTasksBySections } from './lib/task-sections.mjs';
//     window.isOverdue = isOverdue;
//     window.taskDateSection = taskDateSection;
//     window.TASK_SECTION_ORDER = TASK_SECTION_ORDER;
//     window.TASK_SECTION_LABELS = TASK_SECTION_LABELS;
//     window.priorityRank = priorityRank;
//     window.sortWithinSection = sortWithinSection;
//     window.groupTasksBySections = groupTasksBySections;
//   </script>

import { daysBetween } from './task-dates.mjs';

/**
 * @param {object} task
 * @param {string} today YYYY-MM-DD "today", supplied by the caller.
 */
export function isOverdue(task, today) {
  if (!task.due_date || task.status === 'done') return false;
  return task.due_date < today;
}

// Single source of truth for date-window classification.
// Order matters: completed wins, then overdue, then today, then near-future, then far-future, then undated.
/**
 * @param {object} task
 * @param {string} today YYYY-MM-DD "today", supplied by the caller.
 */
export function taskDateSection(task, today) {
  if (task.status === 'done' || task.completed_at) return 'done';
  if (isOverdue(task, today)) return 'overdue';
  if (!task.due_date) return 'no_date';
  if (task.due_date === today) return 'today';
  const delta = daysBetween(today, task.due_date);
  if (delta >= 1 && delta <= 6) return 'this_week';
  return 'later';
}

export const TASK_SECTION_ORDER = ['overdue', 'today', 'this_week', 'later', 'no_date', 'done'];
export const TASK_SECTION_LABELS = {
  overdue: 'Overdue',
  today: 'Today',
  this_week: 'This Week',
  later: 'Later',
  no_date: 'No due date',
  done: 'Completed',
};

// Priority sort rank: P1→P4 map to 1..4, unknown/missing sinks to 99.
export const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
export function priorityRank(task) {
  return PRIORITY_RANK[task.priority] || 99;
}

// Sort within a section: priority ASC, due_date ASC NULLS LAST.
// No overdue-float tier — the section itself expresses that.
// No done-sink tier — the Completed section itself expresses that.
export function sortWithinSection(list) {
  return [...list].sort((a, b) => {
    const pr = priorityRank(a) - priorityRank(b);
    if (pr !== 0) return pr;
    const aDue = a.due_date || null;
    const bDue = b.due_date || null;
    if (aDue === bDue) return 0;
    if (!aDue) return 1;
    if (!bDue) return -1;
    return aDue < bDue ? -1 : 1;
  });
}

// Returns [{ key, label, count, tasks }, ...] in display order; empty sections omitted.
/**
 * @param {object[]} list
 * @param {string} today YYYY-MM-DD "today", supplied by the caller.
 */
export function groupTasksBySections(list, today) {
  const buckets = { overdue: [], today: [], this_week: [], later: [], no_date: [], done: [] };
  list.forEach(t => buckets[taskDateSection(t, today)].push(t));
  return TASK_SECTION_ORDER
    .filter(k => buckets[k].length > 0)
    .map(k => ({
      key: k,
      label: TASK_SECTION_LABELS[k],
      count: buckets[k].length,
      tasks: sortWithinSection(buckets[k]),
    }));
}
