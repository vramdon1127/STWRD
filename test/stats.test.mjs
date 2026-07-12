// test/stats.test.mjs — unit tests for computeStats. Run with `node --test`.
// These lock in the counting logic so the background agent (or a human) can
// refactor renderStats without silently breaking the dashboard, and pin the
// partner/self behavior the backlog flagged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../lib/stats.mjs';

const TODAY = '2026-07-11';
const WEEK_AGO = '2026-07-04';

// A small fixture: Vijay (self) and Mia (partner) both add tasks.
const tasks = [
  { priority: 'P1', due_date: TODAY, category: 'AI Complete', project: 'GNE',      added_by: 'Vijay', created_at: '2026-07-10' },
  { priority: 'P2', due_date: '2026-07-20', category: 'AI Assist', project: 'GNE',  added_by: 'Vijay', created_at: '2026-07-05' },
  { priority: 'P3', due_date: TODAY, category: 'Manual', project: 'Personal',       added_by: 'Mia',   created_at: '2026-07-01' },
  { priority: 'P1', due_date: null, category: 'AI Complete', project: 'Personal',   added_by: null,    created_at: '2026-07-09' },
];

test('basic counts', () => {
  const s = computeStats({ active: tasks, completed: [], userHats: [], viewedUserName: 'Vijay', today: TODAY, weekAgoStr: WEEK_AGO });
  assert.equal(s.total, 4);
  assert.equal(s.p1, 2);
  assert.equal(s.dueToday, 2);
  assert.equal(s.aiComplete, 2);
  assert.equal(s.aiAssist, 1);
  assert.equal(s.manual, 1);
});

test('completion rate: completed vs added this week', () => {
  const completed = [
    { created_at: '2026-07-08' }, // this week
    { created_at: '2026-06-01' }, // older, excluded
  ];
  const s = computeStats({ active: tasks, completed, userHats: [], viewedUserName: 'Vijay', today: TODAY, weekAgoStr: WEEK_AGO });
  // active created this week: 3 (07-10, 07-05, 07-09) + completedThisWeek 1 = addedThisWeek 4
  assert.equal(s.completedThisWeek, 1);
  assert.equal(s.addedThisWeek, 4);
  assert.equal(s.completionRate, 25);
});

test('completion rate is 0 when nothing added this week (no divide-by-zero)', () => {
  const s = computeStats({ active: [], completed: [], userHats: [], viewedUserName: 'Vijay', today: TODAY, weekAgoStr: WEEK_AGO });
  assert.equal(s.addedThisWeek, 0);
  assert.equal(s.completionRate, 0);
  assert.equal(s.aiPct, 0); // totalCat falls back to 1, (0/1)*100 = 0
  assert.equal(s.maxProj, 1); // never 0, so bar math never divides by zero
});

test('project breakdown counts per hat and falls back on color', () => {
  const hats = [{ name: 'GNE', color: '#f00' }, { name: 'Personal' }];
  const s = computeStats({ active: tasks, completed: [], userHats: hats, viewedUserName: 'Vijay', today: TODAY, weekAgoStr: WEEK_AGO });
  assert.deepEqual(s.projData, [
    { name: 'GNE', color: '#f00', count: 2 },
    { name: 'Personal', color: 'var(--accent)', count: 2 },
  ]);
  assert.equal(s.maxProj, 2);
});

// The partner/self correctness point: You/Team must follow the VIEWED user.
test('self view: You = Vijay-added, Team = others (excluding null added_by)', () => {
  const s = computeStats({ active: tasks, completed: [], userHats: [], viewedUserName: 'Vijay', today: TODAY, weekAgoStr: WEEK_AGO });
  assert.equal(s.myCount, 2);   // two Vijay tasks
  assert.equal(s.teamCount, 1); // Mia's one; the null added_by task is excluded
});

test('partner view: same tasks, viewedUserName = Mia flips You/Team', () => {
  const s = computeStats({ active: tasks, completed: [], userHats: [], viewedUserName: 'Mia', today: TODAY, weekAgoStr: WEEK_AGO });
  assert.equal(s.myCount, 1);   // Mia's one task is now "You"
  assert.equal(s.teamCount, 2); // Vijay's two are now "Team"; null still excluded
});

test('handles non-array inputs without throwing', () => {
  const s = computeStats({ active: undefined, completed: null, userHats: undefined, viewedUserName: 'Vijay', today: TODAY, weekAgoStr: WEEK_AGO });
  assert.equal(s.total, 0);
  assert.equal(s.completionRate, 0);
  assert.deepEqual(s.projData, []);
});
