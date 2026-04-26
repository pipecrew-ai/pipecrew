#!/usr/bin/env node
/**
 * Eval harness aggregator. Runs every test file in eval/tests/ as a child
 * process, captures exit code + a tail of stdout/stderr, prints a summary.
 *
 * Each test file is a standalone Node script that:
 *   - declares `const LAYER = N;` near the top (parsed via regex)
 *   - exits 0 on all-pass, non-zero otherwise
 *
 * Usage:
 *   node eval/run.js              all layers (default — Layers 1–3, no LLM)
 *   node eval/run.js --layer=1    static checks only
 *   node eval/run.js --layer=2    script behavior only
 *   node eval/run.js --layer=3    pipeline integration only
 *
 * Layer 4 (LLM-judge) is not wired here; see eval/llm-judge/README.md.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = path.join(__dirname, 'tests');

// --- Parse args ---
const args = process.argv.slice(2);
let layerFilter = null;
for (const a of args) {
  const m = a.match(/^--layer=(\d+)$/);
  if (m) layerFilter = parseInt(m[1], 10);
}

// --- Discover test files ---
function discover() {
  if (!fs.existsSync(TESTS_DIR)) {
    console.error(`No tests directory at ${TESTS_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(TESTS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(TESTS_DIR, f));

  return files.map(filePath => {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 1024);
    const m = head.match(/^const\s+LAYER\s*=\s*(\d+)\s*;/m);
    if (!m) {
      console.error(`WARN: ${path.basename(filePath)} has no LAYER declaration; defaulting to 99`);
    }
    return { filePath, layer: m ? parseInt(m[1], 10) : 99 };
  });
}

// --- Run a single file ---
function runOne({ filePath, layer }) {
  const name = path.basename(filePath);
  const start = Date.now();
  const r = spawnSync('node', [filePath], { encoding: 'utf8' });
  const ms = Date.now() - start;
  return {
    name,
    layer,
    exitCode: r.status,
    pass: r.status === 0,
    ms,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// --- Main ---
const all = discover();
const selected = layerFilter == null ? all : all.filter(t => t.layer === layerFilter);

if (selected.length === 0) {
  console.error(`No tests matched ${layerFilter == null ? '(any layer)' : `--layer=${layerFilter}`}`);
  process.exit(1);
}

console.log(`PipeCrew eval harness — running ${selected.length} test file(s)${layerFilter != null ? ` (layer ${layerFilter})` : ''}\n`);

const results = [];
for (const t of selected) {
  console.log(`── [L${t.layer}] ${path.basename(t.filePath)}`);
  const r = runOne(t);
  // Indent the child's stdout 2 spaces for readability
  const out = r.stdout.trimEnd();
  if (out) console.log(out.split('\n').map(l => '  ' + l).join('\n'));
  if (!r.pass && r.stderr) {
    console.error('  --- stderr ---');
    console.error(r.stderr.split('\n').map(l => '  ' + l).join('\n').trimEnd());
  }
  console.log(`  → ${r.pass ? 'PASS' : 'FAIL'} (exit ${r.exitCode}, ${r.ms}ms)\n`);
  results.push(r);
}

// --- Summary ---
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
const totalMs = results.reduce((a, r) => a + r.ms, 0);

console.log('─'.repeat(60));
console.log(`Summary: ${passed}/${results.length} test files passed in ${totalMs}ms`);
if (failed > 0) {
  console.log('Failed:');
  for (const r of results.filter(x => !x.pass)) {
    console.log(`  - ${r.name} (exit ${r.exitCode})`);
  }
}
process.exit(failed === 0 ? 0 : 1);
