// test/task-ordering.test.mjs — unit tests for priorityRank, sortWithinSection,
// and groupTasksBySections. Run with `node --test`. today is always passed in
// explicitly so these stay deterministic regardless of when the suite runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorityRank, sortWithinSection, groupTasksBySections, TASK_SECTION_ORDER, TASK_SECTION_LABELS } from '../lib/task-sections.mjs';

const TODAY = '2026-07-11'; // Saturday

test('priorityRank: maps P1..P4 to 1..4', () => {
  assert.equal(priorityRank({ priority: 'P1' }), 1);
  assert.equal(priorityRank({ priority: 'P2' }), 2);
  assert.equal(priorityRank({ priority: 'P3' }), 3);
  assert.equal(priorityRank({ priority: 'P4' }), 4);
});

test('priorityRank: unknown or missing priority ranks 99', () => {
  assert.equal(priorityRank({ priority: 'P5' }), 99);
  assert.equal(priorityRank({ priority: null }), 99);
  assert.equal(priorityRank({}), 99);
});

test('sortWithinSection: orders by priority ascending', () => {
  const list = [
    { id: 'a', priority: 'P3' },
    { id: 'b', priority: 'P1' },
    { id: 'c', priority: 'P2' },
  ];
  assert.deepEqual(sortWithinSection(list).map(t => t.id), ['b', 'c', 'a']);
});

test('sortWithinSection: within same priority, orders by due_date ascending', () => {
  const list = [
    { id: 'a', priority: 'P1', due_date: '2026-07-15' },
    { id: 'b', priority: 'P1', due_date: '2026-07-11' },
    { id: 'c', priority: 'P1', due_date: '2026-07-13' },
  ];
  assert.deepEqual(sortWithinSection(list).map(t => t.id), ['b', 'c', 'a']);
});

test('sortWithinSection: null due_date sorts last within same priority', () => {
  const list = [
    { id: 'a', priority: 'P1', due_date: null },
    { id: 'b', priority: 'P1', due_date: '2026-07-11' },
    { id: 'c', priority: 'P1', due_date: null },
  ];
  assert.deepEqual(sortWithinSection(list).map(t => t.id), ['b', 'a', 'c']);
});

test('groupTasksBySections: returns sections in TASK_SECTION_ORDER with correct labels and counts', () => {
  const list = [
    { id: 'overdue1', status: 'todo', priority: 'P1', due_date: '2026-07-01' },
    { id: 'today1', status: 'todo', priority: 'P2', due_date: '2026-07-11' },
    { id: 'week1', status: 'todo', priority: 'P1', due_date: '2026-07-14' },
    { id: 'later1', status: 'todo', priority: 'P3', due_date: '2026-07-25' },
    { id: 'nodate1', status: 'todo', priority: 'P4', due_date: null },
    { id: 'done1', status: 'done', priority: 'P1', due_date: '2026-07-01' },
  ];
  const sections = groupTasksBySections(list, TODAY);
  const presentKeys = sections.map(s => s.key);
  assert.deepEqual(presentKeys, TASK_SECTION_ORDER.filter(k => presentKeys.includes(k)));
  assert.deepEqual(presentKeys, ['overdue', 'today', 'this_week', 'later', 'no_date', 'done']);

  for (const sec of sections) {
    assert.equal(sec.label, TASK_SECTION_LABELS[sec.key]);
    assert.equal(sec.count, sec.tasks.length);
  }

  const overdueSec = sections.find(s => s.key === 'overdue');
  assert.equal(overdueSec.count, 1);
  assert.deepEqual(overdueSec.tasks.map(t => t.id), ['overdue1']);
});

test('groupTasksBySections: sorts tasks within each section by priority then due_date', () => {
  const list = [
    { id: 'a', status: 'todo', priority: 'P3', due_date: '2026-07-17' },
    { id: 'b', status: 'todo', priority: 'P1', due_date: '2026-07-13' },
    { id: 'c', status: 'todo', priority: 'P1', due_date: '2026-07-12' },
  ];
  const sections = groupTasksBySections(list, TODAY);
  const weekSec = sections.find(s => s.key === 'this_week');
  assert.deepEqual(weekSec.tasks.map(t => t.id), ['c', 'b', 'a']);
});

test('groupTasksBySections: omits empty sections', () => {
  const list = [{ id: 'a', status: 'todo', priority: 'P1', due_date: TODAY }];
  const sections = groupTasksBySections(list, TODAY);
  assert.deepEqual(sections.map(s => s.key), ['today']);
});
