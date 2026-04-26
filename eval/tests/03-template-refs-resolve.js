#!/usr/bin/env node
/**
 * Layer 1 — every `templates/blocks/X.example.json` reference (or its
 * `{plugin_dir}/templates/blocks/X.example.json` form) in agents/, skills/,
 * and docs/ points to a file that actually exists in templates/blocks/.
 *
 * Why this matters: agent prompts cite these as the canonical schema for
 * the structured blocks they emit. A missing example file means the
 * agent has nothing to copy from — output drift goes uncaught.
 */

const LAYER = 1;
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const BLOCKS_DIR = path.join(PLUGIN_ROOT, 'templates', 'blocks');
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

// Match either form. `templates/blocks/foo.example.json` or `{plugin_dir}/templates/blocks/foo.example.json`.
const REF_RE = /(?:\{plugin_dir\}\/)?templates\/blocks\/([a-zA-Z0-9_.-]+\.example\.json)/g;

const refs = new Map();
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

test('found at least one templates/blocks/* reference (sanity check)', () => {
  assert(refs.size > 0, 'no references found — has the convention changed?');
});

for (const [exampleName, locations] of refs) {
  test(`templates/blocks/${exampleName} exists (referenced from ${locations.length} location${locations.length > 1 ? 's' : ''})`, () => {
    const fullPath = path.join(BLOCKS_DIR, exampleName);
    if (!fs.existsSync(fullPath)) {
      const sites = locations.slice(0, 3).map(l => `${l.file}:${l.line}`).join(', ');
      throw new Error(`templates/blocks/${exampleName} does not exist; cited at ${sites}${locations.length > 3 ? ` (+${locations.length - 3} more)` : ''}`);
    }
  });
}

// Reverse check: every example file should be referenced somewhere — orphans are dead schema.
test('no orphan example files (every templates/blocks/*.example.json is referenced)', () => {
  const present = fs.readdirSync(BLOCKS_DIR).filter(f => f.endsWith('.example.json'));
  const orphans = present.filter(f => !refs.has(f));
  if (orphans.length > 0) {
    throw new Error(`orphan(s): ${orphans.join(', ')} — defined but cited nowhere in agents/skills/docs`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
