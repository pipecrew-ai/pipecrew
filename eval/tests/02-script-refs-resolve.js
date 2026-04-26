#!/usr/bin/env node
/**
 * Layer 1 — every `{plugin_dir}/scripts/X.js` reference in agents/, skills/,
 * and docs/ points to a file that actually exists in scripts/.
 *
 * Why this matters: these references are dispatch-time contracts. The
 * orchestrator substitutes `{plugin_dir}` and runs `node {path}`. A typo
 * in an agent prompt becomes a runtime failure deep in a `/deliver` run.
 * Catching it here turns it into a CI-time failure.
 */

const LAYER = 1;
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
const SEARCH_DIRS = ['agents', 'skills', 'docs'].map(d => path.join(PLUGIN_ROOT, d));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(md|template)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const allFiles = SEARCH_DIRS.flatMap(d => walk(d));

// Patterns:
//   {plugin_dir}/scripts/foo.js          — most common
//   `{plugin_dir}/scripts/foo.js`        — backticked in markdown
//   plugin_dir}/scripts/foo.js           — backtick swallowed by another regex (paranoid)
const REF_RE = /\{plugin_dir\}\/scripts\/([a-zA-Z0-9_.-]+\.js)/g;

const refs = new Map(); // script-name -> [{ file, line }]
for (const f of allFiles) {
  const body = fs.readFileSync(f, 'utf8');
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let m;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(lines[i])) !== null) {
      const name = m[1];
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push({ file: path.relative(PLUGIN_ROOT, f), line: i + 1 });
    }
  }
}

test('found at least one {plugin_dir}/scripts/* reference (sanity check)', () => {
  assert(refs.size > 0, 'no references found — has the convention changed?');
});

for (const [scriptName, locations] of refs) {
  test(`scripts/${scriptName} exists (referenced from ${locations.length} location${locations.length > 1 ? 's' : ''})`, () => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    if (!fs.existsSync(scriptPath)) {
      const sites = locations.slice(0, 3).map(l => `${l.file}:${l.line}`).join(', ');
      throw new Error(`scripts/${scriptName} does not exist; cited at ${sites}${locations.length > 3 ? ` (+${locations.length - 3} more)` : ''}`);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
