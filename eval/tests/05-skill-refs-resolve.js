#!/usr/bin/env node
const LAYER = 1;
/**
 * Layer 1 — every `skills/X/` reference in agents/, skills/, docs/, and
 * rules/ points to a directory that actually exists in skills/.
 *
 * Why this matters: skill directories are the unit of dispatch. Stale
 * references (from renames, deletes, or typos) silently lie to readers
 * — a doc says "see skills/foo" and the dir is gone or was renamed.
 * Catching it here turns it into a CI-time failure.
 *
 * Matched forms:
 *   {plugin_dir}/skills/X         — fully-qualified dispatch path
 *   {plugin_dir}/skills/X/Y/Z     — sub-path under a skill
 *   skills/X/SKILL.md             — file under a skill (anchored by extension)
 *   skills/X/Y.js                 — script under a skill
 *   skills/X/                     — bare dir reference with trailing slash
 *
 * Deliberately NOT matched (would cause false positives in prose):
 *   "the skills folder", "skills agents", "skills directory"
 *   — anything where `skills/` is followed by a word with no path-shape suffix
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const SEARCH_DIRS = ['agents', 'skills', 'docs', 'rules'].map(d => path.join(PLUGIN_ROOT, d));

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

// Two forms:
//   A. {plugin_dir}/skills/<name>[/<anything>]      — always a real reference
//   B. skills/<name>/<at-least-one-more-segment>    — path-shaped, not prose
const REF_RE_QUALIFIED = /\{plugin_dir\}\/skills\/([a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_./-]*)?/g;
const REF_RE_PATH      = /(?<![a-zA-Z0-9_./-])skills\/([a-zA-Z0-9_-]+)\/[a-zA-Z0-9_./-]+/g;

const refs = new Map(); // skill-name -> [{ file, line, raw }]
function record(name, file, line, raw) {
  if (!refs.has(name)) refs.set(name, []);
  refs.get(name).push({ file: path.relative(PLUGIN_ROOT, file), line, raw });
}

for (const f of allFiles) {
  const body = fs.readFileSync(f, 'utf8');
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of [REF_RE_QUALIFIED, REF_RE_PATH]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        record(m[1], f, i + 1, m[0]);
      }
    }
  }
}

// Real skill directories
const realSkills = new Set(
  fs.existsSync(SKILLS_DIR)
    ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    : []
);

test('found at least one skills/X reference (sanity check)', () => {
  assert(refs.size > 0, 'no references found — has the convention changed?');
});

test('skills/ directory has at least one subdirectory (sanity check)', () => {
  assert(realSkills.size > 0, 'skills/ has no subdirs — repo layout changed?');
});

for (const [skillName, locations] of refs) {
  test(`skills/${skillName}/ exists (referenced from ${locations.length} location${locations.length > 1 ? 's' : ''})`, () => {
    if (!realSkills.has(skillName)) {
      const sites = locations.slice(0, 5).map(l => `${l.file}:${l.line}`).join(', ');
      const more = locations.length > 5 ? ` (+${locations.length - 5} more)` : '';
      throw new Error(`skills/${skillName}/ does not exist; cited at ${sites}${more}`);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
