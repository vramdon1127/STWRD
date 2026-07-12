// lib/stats.mjs — pure stats computation extracted from renderStats() in
// index.html. No DOM, no network, no globals: everything it needs is passed in,
// so it can be unit-tested without a browser. renderStats stays responsible for
// resolving the viewed user, fetching `completed`, and rendering; this module
// owns the counting.
//
// Extracted 2026-07-11 as the first step toward test-covered UI logic so the
// validation gate can catch behavioral regressions (e.g. the partner/self
// mixing the backlog flagged), not just syntax.
//
// Browser bridge (no build step): index.html loads this as a module and exposes
// it to the classic inline script, e.g. near the top of <body>:
//   <script type="module">
//     import { computeStats } from './lib/stats.mjs';
//     window.computeStats = computeStats;
//   </script>
// Then renderStats replaces its inline computation with one destructuring call
// (see the integration note delivered alongside this file).

/**
 * Compute dashboard stats from already-resolved inputs.
 *
 * @param {Object}   args
 * @param {Array}    args.active         The active task list for the viewed user
 *                                       (the global `tasks` array, already swapped
 *                                       for partner view by the caller).
 * @param {Array}    args.completed      Completed tasks for the viewed user.
 * @param {Array}    args.userHats       [{ name, color }] project "hats".
 * @param {string}   args.viewedUserName Display name of the viewed user; drives
 *                                       the You/Team split. MUST be the viewed
 *                                       user, not always the logged-in user —
 *                                       this is the partner/self correctness point.
 * @param {string}   args.today          Local date 'YYYY-MM-DD' (America/Chicago).
 * @param {string}   args.weekAgoStr     Local date 'YYYY-MM-DD' seven days ago.
 * @returns {Object} All values the renderStats template reads, same names.
 */
export function computeStats({ active, completed, userHats, viewedUserName, today, weekAgoStr }) {
  active = Array.isArray(active) ? active : [];
  completed = Array.isArray(completed) ? completed : [];
  userHats = Array.isArray(userHats) ? userHats : [];

  const total = active.length;
  const p1 = active.filter(t => t.priority === 'P1').length;
  const dueToday = active.filter(t => t.due_date === today).length;
  const aiComplete = active.filter(t => t.category === 'AI Complete').length;
  const aiAssist = active.filter(t => t.category === 'AI Assist').length;
  const manual = active.filter(t => t.category === 'Manual').length;

  const completedThisWeek = completed.filter(t => t.created_at >= weekAgoStr).length;
  const addedThisWeek = active.filter(t => t.created_at >= weekAgoStr).length + completedThisWeek;
  const completionRate = addedThisWeek > 0 ? Math.round((completedThisWeek / addedThisWeek) * 100) : 0;

  const projData = userHats.map(hat => ({
    name: hat.name,
    color: hat.color || 'var(--accent)',
    count: active.filter(t => t.project === hat.name).length,
  }));
  const maxProj = Math.max(...projData.map(p => p.count), 1);

  const totalCat = (aiComplete + aiAssist + manual) || 1;
  const aiPct = Math.round(((aiComplete + aiAssist) / totalCat) * 100);

  // You vs Team is measured against the VIEWED user, so it stays correct when
  // viewingPartner is on. Tasks with no added_by are excluded from Team.
  const myCount = active.filter(t => t.added_by === viewedUserName).length;
  const teamCount = active.filter(t => t.added_by !== viewedUserName && t.added_by).length;

  return {
    total, p1, dueToday,
    aiComplete, aiAssist, manual,
    completedThisWeek, addedThisWeek, completionRate,
    projData, maxProj,
    totalCat, aiPct,
    myCount, teamCount,
  };
}
