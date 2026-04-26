#!/usr/bin/env node
/**
 * Layer 1 — every templates/blocks/*.example.json parses as valid JSON.
 *
 * Why this matters: agent prompts and docs/file-formats.md cite these
 * files as the canonical schema. If one stops parsing, every consumer
 * agent will silently emit broken output.
 */

const LAYER = 1;
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const BLOCKS_DIR = path.join(PLUGIN_ROOT, 'templates', 'blocks');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Discover example files
const files = fs.existsSync(BLOCKS_DIR)
  ? fs.readdirSync(BLOCKS_DIR).filter(f => f.endsWith('.example.json'))
  : [];

test('templates/blocks/ exists and is non-empty', () => {
  assert(files.length > 0, `no *.example.json files found in ${BLOCKS_DIR}`);
});

for (const f of files) {
  test(`parses: templates/blocks/${f}`, () => {
    const raw = fs.readFileSync(path.join(BLOCKS_DIR, f), 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error(`JSON.parse failed: ${e.message}`); }
    assert(parsed && typeof parsed === 'object', 'parsed value is not an object');
  });
}

// Per-block shape sanity — minimal field presence, not full schema validation.
// These mirror what consumer agents and docs/file-formats.md document.
const SHAPE_CHECKS = {
  'affected-services.example.json': (j) => {
    assert(Array.isArray(j.services), 'services must be array');
    assert('frontend_required' in j, 'frontend_required must be present');
    assert('mock_required' in j, 'mock_required must be present');
    assert(Array.isArray(j.spec_edit_order), 'spec_edit_order must be array');
  },
  'requirements-index.example.json': (j) => {
    assert(Array.isArray(j.requirements), 'requirements must be array');
    assert(Array.isArray(j.edge_cases), 'edge_cases must be array');
  },
  'coverage.example.json': (j) => {
    assert(Array.isArray(j.coverage), 'coverage must be array');
  },
  'findings-summary.example.json': (j) => {
    for (const k of ['critical_total', 'critical_mechanical', 'critical_architectural', 'non_critical_total', 'scope_total']) {
      assert(typeof j[k] === 'number', `${k} must be number`);
    }
    assert(j.critical_mechanical + j.critical_architectural === j.critical_total,
      'critical_mechanical + critical_architectural must equal critical_total');
  },
};

for (const [f, check] of Object.entries(SHAPE_CHECKS)) {
  test(`shape: ${f}`, () => {
    const fullPath = path.join(BLOCKS_DIR, f);
    if (!fs.existsSync(fullPath)) throw new Error(`missing file: ${f}`);
    const j = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    check(j);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
