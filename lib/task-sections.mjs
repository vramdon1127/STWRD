// lib/task-sections.mjs — pure task-section helpers extracted from index.html.
// isOverdue and taskDateSection take the caller's "today" as an explicit
// YYYY-MM-DD string instead of reading the clock (todayStr()) internally, so
// they're deterministic and unit-testable without mocking time.
//
// Browser bridge (no build step): index.html loads this as a module and
// exposes it to the classic inline script, e.g. near the top of <head>:
//   <script type="module">
//     import { isOverdue, taskDateSection, TASK_SECTION_ORDER, TASK_SECTION_LABELS } from './lib/task-sections.mjs';
//     window.isOverdue = isOverdue;
//     window.taskDateSection = taskDateSection;
//     window.TASK_SECTION_ORDER = TASK_SECTION_ORDER;
//     window.TASK_SECTION_LABELS = TASK_SECTION_LABELS;
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
