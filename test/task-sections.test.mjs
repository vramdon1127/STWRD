// test/task-sections.test.mjs — unit tests for isOverdue and taskDateSection.
// Run with `node --test`. today is always passed in explicitly so these stay
// deterministic regardless of when the suite runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverdue, taskDateSection } from '../lib/task-sections.mjs';

const TODAY = '2026-07-11';

test('isOverdue: true when due_date is strictly before today', () => {
  assert.equal(isOverdue({ due_date: '2026-07-10', status: 'todo' }, TODAY), true);
});

test('isOverdue: false at the day boundary (due_date === today)', () => {
  assert.equal(isOverdue({ due_date: '2026-07-11', status: 'todo' }, TODAY), false);
});

test('isOverdue: false when due_date is after today', () => {
  assert.equal(isOverdue({ due_date: '2026-07-12', status: 'todo' }, TODAY), false);
});

test('isOverdue: false when there is no due_date', () => {
  assert.equal(isOverdue({ due_date: null, status: 'todo' }, TODAY), false);
});

test('isOverdue: false for done tasks even if due_date is in the past', () => {
  assert.equal(isOverdue({ due_date: '2026-07-01', status: 'done' }, TODAY), false);
});

test('taskDateSection: done status wins regardless of due_date', () => {
  assert.equal(taskDateSection({ due_date: '2026-07-01', status: 'done' }, TODAY), 'done');
});

test('taskDateSection: completed_at wins regardless of status', () => {
  assert.equal(
    taskDateSection({ due_date: '2026-07-01', status: 'todo', completed_at: '2026-07-05T00:00:00Z' }, TODAY),
    'done'
  );
});

test('taskDateSection: overdue when due_date is in the past and not done', () => {
  assert.equal(taskDateSection({ due_date: '2026-07-10', status: 'todo' }, TODAY), 'overdue');
});

test('taskDateSection: today when due_date equals today', () => {
  assert.equal(taskDateSection({ due_date: '2026-07-11', status: 'todo' }, TODAY), 'today');
});

test('taskDateSection: this_week for 1-6 days out', () => {
  assert.equal(taskDateSection({ due_date: '2026-07-12', status: 'todo' }, TODAY), 'this_week');
  assert.equal(taskDateSection({ due_date: '2026-07-17', status: 'todo' }, TODAY), 'this_week');
});

test('taskDateSection: later for 7+ days out', () => {
  assert.equal(taskDateSection({ due_date: '2026-07-18', status: 'todo' }, TODAY), 'later');
});

test('taskDateSection: no_date when there is no due_date and not done', () => {
  assert.equal(taskDateSection({ due_date: null, status: 'todo' }, TODAY), 'no_date');
});
