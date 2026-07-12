// scripts/validate.mjs — STWRD validation gate.
//
// The single source of truth for "is this tree safe to commit?". The headless
// backlog agent runs this before it commits to a claude/auto-<date> branch, and
// GitHub Actions runs the exact same script on push/PR as an independent
// backstop, so the two can never drift.
//
// This repo is vanilla HTML/CSS/JS with no build step and no TypeScript, so the
// equivalent of "tsc --noEmit" here is a real syntax check of every piece of JS
// that ships — including the inline <script> blocks inside index.html, which is
// where an automated edit is most likely to introduce a break that no build
// step would otherwise catch.
//
// Usage:
//   node scripts/validate.mjs              # offline gate: syntax + secret scan
//   node scripts/validate.mjs --batteries  # also run the live category/project
//                                          # batteries (needs network + creds)
//
// Exit code is 0 only if every enabled check passes; non-zero otherwise.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_BATTERIES = process.argv.includes('--batteries');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- gather the JS the app actually ships -----------------------------------

function listFiles(dir, filter) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && filter(d.name))
    .map((d) => join(dir, d.name));
}

// Standalone JS: serverless functions (ESM .js) and helper scripts (.mjs).
const standaloneJs = [
  ...listFiles(join(ROOT, 'api'), (n) => n.endsWith('.js')),
  ...listFiles(join(ROOT, 'scripts'), (n) => n.endsWith('.mjs') && n !== 'validate.mjs'),
  ...listFiles(join(ROOT, 'lib'), (n) => n.endsWith('.mjs') || n.endsWith('.js')),
];

// Inline <script> blocks inside index.html.
function extractInlineScripts(htmlPath) {
  if (!existsSync(htmlPath)) return [];
  const html = readFileSync(htmlPath, 'utf8');
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let idx = 0;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    idx += 1;
    if (/\bsrc\s*=/.test(attrs)) continue; // external, nothing inline to check
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';
    const isJsType = type === '' || type === 'text/javascript' || type === 'module' || type === 'application/javascript';
    if (!isJsType) continue; // e.g. application/json, text/template
    if (!body.trim()) continue;
    // Compute the source line where this block starts, for useful errors.
    const line = html.slice(0, m.index).split('\n').length;
    blocks.push({ label: `index.html <script> #${idx} (line ${line})`, body, module: type === 'module' });
  }
  return blocks;
}

// --- check 1: JS syntax ------------------------------------------------------

function nodeCheck(filePath) {
  const r = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  return { ok: r.status === 0, err: (r.stderr || '').trim() };
}

function runSyntaxCheck() {
  const tmp = mkdtempSync(join(tmpdir(), 'stwrd-validate-'));
  const failures = [];
  let checked = 0;
  try {
    // Standalone files: copy into a .mjs temp so ESM `export`/`import` parse
    // correctly regardless of the repo having no package.json "type".
    for (const f of standaloneJs) {
      const tmpFile = join(tmp, basename(f) + '.mjs');
      writeFileSync(tmpFile, readFileSync(f, 'utf8'));
      const { ok, err } = nodeCheck(tmpFile);
      checked += 1;
      if (!ok) failures.push(`${f}\n${err.split(tmpFile).join(f)}`);
    }
    // Inline index.html scripts: module blocks as .mjs, classic as .cjs so
    // top-level-return and other sloppy-script forms don't false-fail.
    for (const b of extractInlineScripts(join(ROOT, 'index.html'))) {
      const ext = b.module ? '.mjs' : '.cjs';
      const tmpFile = join(tmp, `inline-${checked}${ext}`);
      writeFileSync(tmpFile, b.body);
      const { ok, err } = nodeCheck(tmpFile);
      checked += 1;
      if (!ok) failures.push(`${b.label}\n${err.replace(tmpFile, b.label)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) {
    record('js-syntax', false, `${failures.length} of ${checked} JS unit(s) failed`);
    for (const f of failures) console.log('\n  ' + f.split('\n').join('\n  ') + '\n');
  } else {
    record('js-syntax', true, `${checked} JS unit(s) parse clean`);
  }
}

// --- check 2: no committed secrets ------------------------------------------

function runSecretScan() {
  const patterns = [
    { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'OpenAI key', re: /sk-(?:proj-)?[A-Za-z0-9]{20,}/ },
    { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  ];
  const scanFiles = [
    ...standaloneJs,
    join(ROOT, 'index.html'),
    ...listFiles(join(ROOT, 'public'), () => true),
  ].filter(existsSync);
  const hits = [];
  for (const f of scanFiles) {
    const text = readFileSync(f, 'utf8');
    for (const p of patterns) {
      if (p.re.test(text)) hits.push(`${p.name} in ${f}`);
    }
  }
  if (hits.length) {
    record('secret-scan', false, `${hits.length} possible secret(s)`);
    for (const h of hits) console.log('  ' + h);
  } else {
    record('secret-scan', true, `${scanFiles.length} file(s) clean`);
  }
}

// --- check 3 (opt-in): live classification batteries ------------------------

function runBattery(scriptRel, label) {
  const scriptPath = join(ROOT, scriptRel);
  if (!existsSync(scriptPath)) {
    record(label, false, `${scriptRel} not found`);
    return;
  }
  const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\/(\d+)\s+passed/);
  if (!m) {
    record(label, false, `no "X/Y passed" line (exit ${r.status}). Check creds/network.`);
    console.log(out.split('\n').slice(-12).map((l) => '  ' + l).join('\n'));
    return;
  }
  const passed = Number(m[1]);
  const total = Number(m[2]);
  const ok = passed === total && r.status === 0;
  record(label, ok, `${passed}/${total} cases passed`);
  if (!ok) console.log(out.split('\n').filter((l) => l.startsWith('#') || l.includes('expected') || l.includes('got')).slice(0, 40).map((l) => '  ' + l).join('\n'));
}

// --- check: unit tests (node --test over test/) -----------------------------

function runUnitTests() {
  const testDir = join(ROOT, 'test');
  if (!existsSync(testDir)) {
    record('unit-tests', true, 'no test/ dir (skipped)');
    return;
  }
  const files = listFiles(testDir, (n) => n.endsWith('.test.mjs'));
  if (!files.length) {
    record('unit-tests', true, 'no *.test.mjs files (skipped)');
    return;
  }
  const r = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const passM = out.match(/#\s*pass\s+(\d+)/);
  const failM = out.match(/#\s*fail\s+(\d+)/);
  const pass = passM ? Number(passM[1]) : 0;
  const fail = failM ? Number(failM[1]) : (r.status === 0 ? 0 : 1);
  const ok = r.status === 0 && fail === 0;
  record('unit-tests', ok, `${pass} passed${fail ? `, ${fail} failed` : ''} across ${files.length} file(s)`);
  if (!ok) console.log(out.split('\n').filter((l) => /not ok|Error|AssertionError|✖|✗/.test(l)).slice(0, 40).map((l) => '  ' + l).join('\n'));
}

// --- run ---------------------------------------------------------------------

console.log(`STWRD validate — root: ${ROOT}${RUN_BATTERIES ? ' (with batteries)' : ''}\n`);
runSyntaxCheck();
runSecretScan();
runUnitTests();
if (RUN_BATTERIES) {
  runBattery('scripts/category_battery.mjs', 'category-battery');
  runBattery('scripts/project_battery.mjs', 'project-battery');
} else {
  console.log('[SKIP] batteries (run with --batteries to include live checks)');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log('OK — tree passes the gate.');
