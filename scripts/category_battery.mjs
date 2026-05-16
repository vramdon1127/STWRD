// Live category-classification battery. Calls /api/process for each task in
// the 18-case battery and prints the parsed CATEGORY alongside the expected
// value. Run before merging any change to the categorization prompt in
// index.html; all 18 must pass.
//
// Usage:
//   node scripts/category_battery.mjs                     # hits prod
//   STWRD_ENDPOINT=http://localhost:3000/api/process node scripts/category_battery.mjs
//
// The harness passes empty PROJECTS / RECENT TASK HISTORY / CORRECTIONS so the
// classification is isolated to the prompt's category rules — not influenced
// by a specific user's data.

const ENDPOINT = process.env.STWRD_ENDPOINT || 'https://getstwrd.com/api/process';
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

const cases = [
  ['Write thank you note to the Hendersons for the wedding referral', 'AI Complete'],
  ['Draft partner digest intro copy for STWRD', 'AI Complete'],
  ['Summarize the MC onboarding doc into 5 bullet points', 'AI Complete'],
  ["Call the pediatrician to move Selah's appointment", 'Manual'],
  ['Compare baby monitor options under $200', 'AI Assist'],
  ['Load last month’s bank statements and build a budget', 'AI Assist'],
  ["Pick up the cake for Sunday's shower", 'Manual'],
  ['Go for a 3-mile run', 'Manual'],
  ['Meet with Grant Willard about the SOX walkthrough', 'Manual'],
  ['Draft a follow-up email to the VIBO support team', 'AI Assist'],
  ["Respond to Mia's text about the weekend schedule", 'AI Assist'],
  ['Reply to the Bark lead and politely decline the December date', 'AI Complete'],
  ['Find three first-birthday gift ideas for Selah', 'AI Assist'],
  ['Find a new dentist that takes our insurance', 'AI Assist'],
  ['Look up what the GNE LLC reinstatement fee was', 'AI Assist'],
  ['Read the new HOA bylaws and tell me what changed', 'AI Assist'],
  ['Review the Knot ISSUES.md and prioritize the open bugs', 'AI Assist'],
  ["Text Eddie to confirm he's covering Saturday's DJ set", 'AI Complete'],
];

const PROJECT_NAMES = 'Personal OR Work OR Family';
const LIFE_AREAS = 'Work OR Family OR Health OR Faith OR Finance OR Growth OR Recharge';

function buildPrompt(raw) {
  return `You are STWRD, a personal AI life manager. You help Vijay manage their life and work.

PROJECTS:
PERSONAL: Personal tasks

WORK: Work tasks

FAMILY: Family tasks

LIFE AREAS (for life balance tracking):
Work, Family, Health, Faith, Finance, Growth, Recharge

RECENT TASK HISTORY (use these patterns to categorize accurately):
No previous tasks yet

CORRECTIONS (user manually fixed these — learn from them and never repeat these mistakes):
No corrections yet

Given this raw task, respond ONLY in this exact format with no extra text:
TASK: [cleaned, concise, actionable version of the task]
CATEGORY: [AI Complete OR AI Assist OR Manual]
PROJECT: [${PROJECT_NAMES}]
PRIORITY: [P1 OR P2 OR P3 OR P4]
DUE: [YYYY-MM-DD if a date is mentioned, otherwise none]
RECUR: [weekly OR monthly OR none — weekly if task repeats every week like laundry/groceries, monthly if repeats monthly like bills/rent, none otherwise]
LIFE: [${LIFE_AREAS}]
REASON: [one short sentence why]

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
Due date guide: Extract any date mentioned. Today is ${TODAY}.
- "today" or "tonight" or "this evening" = today's date
- "tomorrow" = tomorrow's date
- "this week" = this Friday
- Day names like "Friday" = the next upcoming Friday
- Specific dates like "April 15" = that date in the current year
LIFE guide: Pick the ONE life area this task most belongs to based on its content and context. Use your judgment — "Peter walked on water" is Faith not Health.

Raw task: ${raw}
Added by: Vijay`;
}

function parseCategory(text) {
  const m = text.match(/CATEGORY:\s*([^\n]+)/i);
  if (!m) return null;
  const v = m[1].trim();
  if (v.includes('AI Complete')) return 'AI Complete';
  if (v.includes('AI Assist')) return 'AI Assist';
  if (v.includes('Manual')) return 'Manual';
  return v;
}

async function runOne(raw) {
  const prompt = buildPrompt(raw);
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, provider: 'claude' }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  const text = data?.content?.[0]?.text || '';
  return { text, category: parseCategory(text) };
}

const results = [];
for (let i = 0; i < cases.length; i++) {
  const [task, expected] = cases[i];
  try {
    const { category, text } = await runOne(task);
    const pass = category === expected;
    results.push({ n: i + 1, task, expected, got: category, pass, text });
    console.log(`${pass ? 'PASS' : 'FAIL'}  #${i + 1}  expected=${expected}  got=${category}  | ${task}`);
  } catch (e) {
    results.push({ n: i + 1, task, expected, got: 'ERROR', pass: false, error: e.message });
    console.log(`ERROR #${i + 1}  ${e.message}  | ${task}`);
  }
}

console.log('\n--- Summary ---');
const passed = results.filter(r => r.pass).length;
console.log(`${passed}/${results.length} passed`);
const fails = results.filter(r => !r.pass);
if (fails.length) {
  console.log('\nFailures (full response shown):');
  for (const f of fails) {
    console.log(`\n#${f.n} ${f.task}`);
    console.log(`  expected: ${f.expected}`);
    console.log(`  got:      ${f.got}`);
    if (f.text) console.log(`  raw:\n${f.text.split('\n').map(l => '    ' + l).join('\n')}`);
    if (f.error) console.log(`  error: ${f.error}`);
  }
}
