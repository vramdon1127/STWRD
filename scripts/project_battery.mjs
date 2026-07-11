// Live project-routing battery. Calls /api/process for each task in the
// 15-case battery and prints the routed PROJECT (after replicating the
// client-side guard from index.html processTask) alongside the expected
// value. Run before merging any change to the categorization prompt or the
// project guard; all 15 must pass.
//
// Why this exists: the client guard and the i3 DB trigger make bad routing
// harmless (fallback to Personal) but invisible — a regression that silently
// dumps everything into Personal would never surface in the app. This
// battery makes routing regressions visible.
//
// Unlike category_battery.mjs (which stubs PROJECTS to isolate category
// rules), this battery fetches the user's REAL projects, knowledge blurbs,
// and life areas from Supabase at runtime and assembles the prompt exactly
// as processTask does. If the fetch fails it aborts loudly — never a silent
// fallback to a stale hardcoded list.
//
// The one deliberate divergence from a live user's prompt: RECENT TASK
// HISTORY and CORRECTIONS use production's empty-state strings, so routing
// is isolated to the prompt rules and not a specific user's task history.
//
// Usage:
//   SUPABASE_SERVICE_KEY=... STWRD_USER_ID=<uuid> node scripts/project_battery.mjs
//   STWRD_ENDPOINT=http://localhost:3000/api/process ... node scripts/project_battery.mjs
//
//   Print the assembled prompt for case N (no /api/process call):
//   ... node scripts/project_battery.mjs --print-prompt 1
//
//   Parity check against index.html without live credentials (fixture data,
//   never used for real runs):
//   node scripts/project_battery.mjs --print-prompt 1 --fixture
//
// The prompt template below is copied VERBATIM from processTask in
// index.html (commit fc980e2). If you change the prompt there, update it
// here and re-run the parity diff (see docs in that commit / --print-prompt).

const ENDPOINT = process.env.STWRD_ENDPOINT || 'https://getstwrd.com/api/process';
const SUPABASE_URL = 'https://fnnegalrrdzcgoelljmi.supabase.co';

// warnOnly cases invite the model to invent a project; the pass bar is that
// the guard lands Personal. If the raw output maps onto a REAL project by
// association instead, that's reported as WARN (visible, not a failure).
// offline cases never hit the API: the string is fed straight through the
// parser + guard, proving the fallback logic itself.
const cases = [
  { n: 1,  task: 'Fix the AI Complete button bug in STWRD', expect: 'App Development' },
  { n: 2,  task: 'Review the Knot ISSUES.md and prioritize the open bugs', expect: 'App Development' },
  // The original STWRD-to-ServeAnts collision — the regression tripwire.
  { n: 3,  task: 'Refactor the STWRD capture flow into modules', expect: 'App Development' },
  { n: 4,  task: 'Add a dark theme to the STWRD daily digest email', expect: 'App Development' },
  { n: 5,  task: 'File the ServeAnts LLC annual report with the state', expect: 'ServeAnts' },
  { n: 6,  task: "Prep the Johnson family's tax return documents", expect: 'ServeAnts' },
  { n: 7,  task: 'Reply to the registered agent renewal notice email', expect: 'ServeAnts' },
  { n: 8,  task: "Text Eddie to confirm he's covering Saturday's DJ set", expect: 'GNE' },
  { n: 9,  task: 'Book a sitter for Friday date night', expect: 'Family' },
  { n: 10, task: "Renew my driver's license before it expires", expect: 'Personal' },
  { n: 11, task: 'Set up an Oura sleep dashboard for my new biohacking side venture', expect: 'Personal', warnOnly: true },
  { n: 12, task: 'Plan the Q3 launch for Project Nimbus', expect: 'Personal', warnOnly: true },
  { n: 13, task: '(offline) guard unit check: synthetic PROJECT value', expect: 'Personal', offline: 'PROJECT: Slime Empire' },
  { n: 14, task: 'Prep for the SOX walkthrough with Grant Willard', expect: 'Caliber' },
  { n: 15, task: 'Schedule the annual furnace inspection', expect: 'Home' },
];

// Fixture context for --print-prompt --fixture ONLY (prompt-parity checks
// without live credentials). Real runs always fetch live data.
const FIXTURE_CTX = {
  currentUser: 'Vijay',
  userHats: [
    { name: 'Personal' },
    { name: 'Family' },
    { name: 'GNE' },
    { name: 'Caliber' },
    { name: 'ServeAnts' },
    { name: 'App Development' },
    { name: 'Home' },
  ],
  knowledgeBase: {
    'Personal': 'Personal errands and life admin',
    'Family': 'Family logistics and kids',
    'GNE': 'Good News Entertainment DJ business',
    'Caliber': 'Day job — Director of Internal Controls at Caliber Collision',
    'ServeAnts': 'ServeAnts LLC CPA business — tax prep, client work, filings',
    'App Development': 'Building the STWRD and Knot apps',
    'Home': 'Household infrastructure and maintenance',
  },
  userLifeCategories: [],
};

async function sbGet(path, key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${path.split('?')[0]}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchContext() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const userId = process.env.STWRD_USER_ID;
  if (!key || !userId) {
    console.error('ABORT: SUPABASE_SERVICE_KEY and STWRD_USER_ID env vars are required.');
    console.error('This battery refuses to run against a hardcoded project list — the whole');
    console.error('point is parity with the live projects table.');
    process.exit(1);
  }

  const [projectRows, knowledgeRows, lifeRows] = await Promise.all([
    sbGet(`projects?user_id=eq.${userId}&order=sort_order.asc`, key),
    sbGet(`knowledge?user_id=eq.${userId}&select=project,context`, key),
    sbGet(`life_categories?user_id=eq.${userId}&active=eq.true&order=sort_order.asc`, key),
  ]);

  if (!projectRows || projectRows.length === 0) {
    console.error(`ABORT: no rows in projects for user ${userId}.`);
    process.exit(1);
  }

  // Dedup by name, same as loadUserHats / loadUserLifeCategories in index.html.
  const dedup = (rows) => {
    const seen = new Set();
    return rows.filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; });
  };
  const userHats = dedup(projectRows);
  const userLifeCategories = lifeRows && lifeRows.length > 0 ? dedup(lifeRows) : [];
  const knowledgeBase = {};
  (knowledgeRows || []).forEach(row => { knowledgeBase[row.project] = row.context; });

  return { currentUser: process.env.STWRD_USER_NAME || 'Vijay', userHats, knowledgeBase, userLifeCategories };
}

// Prompt assembly — slot expressions and template copied VERBATIM from
// processTask in index.html (fc980e2). taskHistory/corrections are empty,
// which renders production's own empty-state strings.
function buildPrompt(raw, ctx) {
  const { currentUser, userHats, knowledgeBase, userLifeCategories } = ctx;
  const taskHistory = '';
  const corrections = [];

  const projectContext = userHats.map(p => {
    const kb = knowledgeBase[p.name] || '';
    return `${p.name.toUpperCase()}: ${kb || p.name + ' tasks'}`;
  }).join('\n\n');

  const projectNames = userHats.map(p => p.name).join(' OR ');
  const lifeAreaNames = userLifeCategories.length > 0
    ? userLifeCategories.map(c => c.name).join(' OR ')
    : 'Work OR Family OR Health OR Faith OR Finance OR Growth OR Recharge';

  return `You are STWRD, a personal AI life manager. You help ${currentUser} manage their life and work.

PROJECTS:
${projectContext}

LIFE AREAS (for life balance tracking):
${userLifeCategories.length > 0 ? userLifeCategories.map(c => `${c.name}: ${Array.isArray(c.keywords) ? c.keywords.join(', ') : ''}`).join('\n') : 'Work, Family, Health, Faith, Finance, Growth, Recharge'}

RECENT TASK HISTORY (use these patterns to categorize accurately):
${taskHistory || 'No previous tasks yet'}

CORRECTIONS (user manually fixed these — learn from them and never repeat these mistakes):
${corrections.length > 0 ? corrections.map(c => `"${c.original_task}" was moved from ${c.original_project}/${c.original_category} → ${c.corrected_project}/${c.corrected_category}`).join('\n') : 'No corrections yet'}

Given this raw task, respond ONLY in this exact format with no extra text:
TASK: [cleaned, concise, actionable version of the task]
CATEGORY: [AI Complete OR AI Assist OR Manual]
PROJECT: [${projectNames}]
PRIORITY: [P1 OR P2 OR P3 OR P4]
DUE: [YYYY-MM-DD if a date is mentioned, otherwise none]
RECUR: [weekly OR monthly OR none — weekly if task repeats every week like laundry/groceries, monthly if repeats monthly like bills/rent, none otherwise]
LIFE: [${lifeAreaNames}]
REASON: [one short sentence why]

Project guide: Choose exactly one project from the list. Never invent a project name not on the list. STWRD or Knot app work (features, bugs, UI, architecture, product research) => App Development. ServeAnts CPA business (tax, client work, LLC filings, registered agent, business email) => ServeAnts.
Priority guide: P1=urgent/today, P2=important/this week, P3=normal, P4=low/someday
Category guide — pick based on whether AI can FINISH the task from the task description alone:

AI Complete = the task is self-contained. Everything AI needs is in the task itself, or is general knowledge. AI produces the finished deliverable; the user only reviews and sends/posts/shares. Sending it after is NOT disqualifying — the work IS the text.
Test: "Could AI finish this well right now, with nothing else from the user?" If yes → AI Complete.
Examples:
- "Write a thank you note to the Hendersons for the wedding referral" — self-contained; AI writes it.
- "Summarize the MC onboarding doc into 5 bullets" — the source is provided; AI produces the summary.
- "Reply to the Bark lead and politely decline the December date" — the reply's content is fully specified; AI writes the decline.
- "Text Eddie to confirm he's covering Saturday's DJ set" — specific, self-contained message.

AI Assist = the task is NOT self-contained. AI can prep, draft, or outline, but finishing it well requires context, judgment, or information the user holds and AI does not. AI offers a starting point; the user completes it.
Test: "Would AI have to guess at something only the user knows?" If yes → AI Assist.
Examples:
- "Draft a follow-up email to VIBO support" — AI doesn't know what's being followed up on; needs the user's context.
- "Find first-birthday gift ideas for Selah" — depends on her interests and what she already has.
- "Find a new dentist that takes our insurance" — needs the user's insurance and preferences.
- "Look up the GNE LLC reinstatement fee" — user acts on the result.
- "Compare baby monitor options under $200" — AI lays out tradeoffs; user decides.
- "Review the Knot ISSUES.md and prioritize the open bugs" — needs the user's product judgment.
- "Load last month's bank statements and build a budget" — user must supply figures AI can't see.

Manual = no meaningful AI text deliverable. The task is physical, in-person, body-required, or a phone call the user must place.
Intent words: pick up, drop off, go to, drive, attend, meet with (in person), call/phone, body verbs (run, walk, cook, clean).
Examples:
- "Pick up the cake for Sunday's shower"
- "Go for a 3-mile run"
- "Meet with Grant Willard about the SOX walkthrough"
- "Call the pediatrician to move Selah's appointment" — placing a call is a user action.

Fallback: when genuinely torn between AI Complete and AI Assist, choose AI Assist (the user can always ignore an offer). When torn between AI Assist and Manual, choose AI Assist.
Due date guide: Extract any date mentioned. Today is ${new Date().toLocaleDateString('en-CA', {timeZone: 'America/Chicago'})}.
- "today" or "tonight" or "this evening" = today's date
- "tomorrow" = tomorrow's date
- "this week" = this Friday
- Day names like "Friday" = the next upcoming Friday
- Specific dates like "April 15" = that date in the current year
LIFE guide: Pick the ONE life area this task most belongs to based on its content and context. Use your judgment — "Peter walked on water" is Faith not Health.

Raw task: ${raw}
Added by: ${currentUser}`;
}

// Same regex processTask's get() builds for PROJECT.
function parseProject(text) {
  const m = text.match(new RegExp('PROJECT: (.+)'));
  return m ? m[1].trim() : null;
}

// Replica of the client-side guard in processTask.
function validateProject(projRaw, userHats) {
  return userHats.some(p => p.name === projRaw) ? projRaw : 'Personal';
}

async function runOne(raw, ctx) {
  const prompt = buildPrompt(raw, ctx);
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, provider: 'claude' }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data?.content?.[0]?.text || '';
}

// ─── main ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv[0] === '--print-prompt') {
  const n = parseInt(argv[1], 10) || 1;
  const c = cases.find(x => x.n === n);
  if (!c) { console.error(`No case #${n}`); process.exit(1); }
  const ctx = argv.includes('--fixture') ? FIXTURE_CTX : await fetchContext();
  process.stdout.write(buildPrompt(c.task, ctx));
  process.exit(0);
}

const ctx = await fetchContext();
const liveNames = ctx.userHats.map(p => p.name);
console.log(`Live projects (${liveNames.length}): ${liveNames.join(', ')}\n`);

// Every expected project must exist in the live table, or results are nonsense.
const missing = [...new Set(cases.map(c => c.expect))].filter(e => !liveNames.includes(e));
if (missing.length) {
  console.error(`ABORT: expected project(s) not in live projects table: ${missing.join(', ')}`);
  process.exit(1);
}

const results = [];
for (const c of cases) {
  try {
    const text = c.offline ? c.offline : await runOne(c.task, ctx);
    const rawProject = parseProject(text);
    const final = validateProject(rawProject, ctx.userHats);
    const invented = rawProject !== null && !liveNames.includes(rawProject);

    let outcome;
    let note = '';
    if (final === c.expect) {
      outcome = invented && !c.warnOnly ? 'FAIL' : 'PASS';
      if (invented && c.warnOnly) note = `guard caught invented '${rawProject}'`;
      if (invented && !c.warnOnly) note = `landed on expected only via fallback — raw was invented '${rawProject}'`;
    } else if (c.warnOnly && !invented) {
      outcome = 'WARN';
      note = `raw output associated with real project '${rawProject}' — guard cannot catch this`;
    } else {
      outcome = 'FAIL';
    }

    results.push({ ...c, rawProject, final, outcome, note, text });
    console.log(`${outcome}${outcome === 'WARN' ? ' ' : outcome === 'PASS' ? ' ' : ' '} #${String(c.n).padStart(2)}  expected=${c.expect}  raw=${rawProject}  final=${final}${note ? `  (${note})` : ''}  | ${c.task}`);
  } catch (e) {
    results.push({ ...c, outcome: 'ERROR', error: e.message });
    console.log(`ERROR #${c.n}  ${e.message}  | ${c.task}`);
  }
}

console.log('\n--- Summary ---');
const passed = results.filter(r => r.outcome === 'PASS').length;
const warned = results.filter(r => r.outcome === 'WARN').length;
console.log(`${passed}/${results.length} passed${warned ? `, ${warned} warning(s)` : ''}`);
const bad = results.filter(r => r.outcome === 'FAIL' || r.outcome === 'ERROR');
if (bad.length) {
  console.log('\nFailures (full response shown):');
  for (const f of bad) {
    console.log(`\n#${f.n} ${f.task}`);
    console.log(`  expected: ${f.expect}`);
    console.log(`  raw:      ${f.rawProject ?? 'n/a'}  final: ${f.final ?? 'n/a'}`);
    if (f.text) console.log(`  response:\n${f.text.split('\n').map(l => '    ' + l).join('\n')}`);
    if (f.error) console.log(`  error: ${f.error}`);
  }
}
