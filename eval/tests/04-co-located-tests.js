#!/usr/bin/env node
/**
 * Layer 2 — runs every co-located unit test under scripts/*.test.js.
 *
 * The plugin's existing convention is to put unit tests next to the
 * script they exercise (validate-claude-md.test.js, extract-block.test.js,
 * etc.). This aggregator runs all of them so the eval harness has a
 * single entry point.
 *
 * Each scripts/*.test.js is a standalone Node script that exits 0 on
 * pass, non-zero on fail.
 */

const LAYER = 2;
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');

let passed = 0, failed = 0;
function record(name, ok, detail) {
  if (ok) { console.log(`  ok  ${name}`); passed++; }
  else { console.error(`  FAIL ${name}\n       ${detail || ''}`); failed++; }
}

const testFiles = fs.existsSync(SCRIPTS_DIR)
  ? fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.test.js')).sort()
  : [];

if (testFiles.length === 0) {
  console.error('  FAIL no scripts/*.test.js files discovered');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

for (const f of testFiles) {
  const filePath = path.join(SCRIPTS_DIR, f);
  const r = spawnSync('node', [filePath], { encoding: 'utf8' });
  if (r.status === 0) {
    // Pull the summary line for visibility.
    const summary = (r.stdout || '').trim().split('\n').slice(-1)[0];
    record(`${f} — ${summary}`, true);
  } else {
    const tail = (r.stdout || '').trim().split('\n').slice(-5).join(' | ');
    record(`${f} (exit ${r.status})`, false, `last lines: ${tail}\n       stderr: ${(r.stderr || '').trim().slice(0, 200)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
