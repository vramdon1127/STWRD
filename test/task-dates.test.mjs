// test/task-dates.test.mjs — unit tests for humanDueLabel and daysBetween.
// Run with `node --test`. today is always passed in explicitly so these stay
// deterministic regardless of when the suite runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanDueLabel, daysBetween } from '../lib/task-dates.mjs';

const TODAY = '2026-07-11'; // Saturday

test('daysBetween: whole-day difference between two dates', () => {
  assert.equal(daysBetween('2026-07-11', '2026-07-11'), 0);
  assert.equal(daysBetween('2026-07-11', '2026-07-12'), 1);
  assert.equal(daysBetween('2026-07-11', '2026-07-04'), -7);
});

test('humanDueLabel: Today', () => {
  assert.equal(humanDueLabel('2026-07-11', TODAY), 'Today');
});

test('humanDueLabel: Tomorrow', () => {
  assert.equal(humanDueLabel('2026-07-12', TODAY), 'Tomorrow');
});

test('humanDueLabel: Yesterday', () => {
  assert.equal(humanDueLabel('2026-07-10', TODAY), 'Yesterday');
});

test('humanDueLabel: weekday label within the next 6 days', () => {
  // TODAY is Saturday 2026-07-11; +4 days is Wednesday 2026-07-15.
  assert.equal(humanDueLabel('2026-07-15', TODAY), 'Wed');
});

test('humanDueLabel: "N days overdue" for 2-6 days in the past', () => {
  assert.equal(humanDueLabel('2026-07-08', TODAY), '3 days overdue');
});

test('humanDueLabel: MM/DD fallback for far future within the same year', () => {
  // +20 days is beyond the "Next <day>" window (<=13).
  assert.equal(humanDueLabel('2026-07-31', TODAY), '07/31');
});

test('humanDueLabel: MM/DD/YY fallback for far future in a different year', () => {
  assert.equal(humanDueLabel('2027-01-15', TODAY), '01/15/27');
});

test('humanDueLabel: MM/DD overdue fallback for more than 6 days in the past', () => {
  assert.equal(humanDueLabel('2026-06-01', TODAY), '06/01 overdue');
});
