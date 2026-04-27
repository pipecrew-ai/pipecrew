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
  'infrastructure-impact.example.json': (j) => {
    assert(Array.isArray(j.infra_changes), 'infra_changes must be array');
    for (const c of j.infra_changes) {
      assert(typeof c.repo === 'string', 'infra_change.repo must be string');
      assert(typeof c.type === 'string', 'infra_change.type must be string');
      assert(Array.isArray(c.resources_added), 'resources_added must be array');
      assert(Array.isArray(c.resources_modified), 'resources_modified must be array');
      assert(Array.isArray(c.resources_removed), 'resources_removed must be array');
      assert(Array.isArray(c.cross_stack_refs), 'cross_stack_refs must be array');
    }
  },
  'data-model.example.json': (j) => {
    assert(Array.isArray(j.entities), 'entities must be array');
    assert(Array.isArray(j.database_changes), 'database_changes must be array');
    for (const e of j.entities) {
      assert(typeof e.name === 'string', 'entity.name must be string');
      assert(['added', 'modified', 'removed'].includes(e.change_kind),
        `entity.change_kind must be added | modified | removed (got ${e.change_kind})`);
    }
    for (const c of j.database_changes) {
      assert(['table', 'column', 'index', 'migration'].includes(c.scope),
        `db change scope must be table | column | index | migration (got ${c.scope})`);
    }
  },
  'api-design.example.json': (j) => {
    assert(Array.isArray(j.services), 'services must be array');
    for (const s of j.services) {
      assert(typeof s.name === 'string', 'service.name must be string');
      assert(['api-first', 'code-first', 'no-api'].includes(s.spec_policy),
        `service.spec_policy must be api-first | code-first | no-api (got ${s.spec_policy})`);
      if (s.spec_policy === 'no-api') {
        assert(Array.isArray(s.handlers), 'no-api service must have handlers array');
      } else {
        assert(Array.isArray(s.endpoints), 'http service must have endpoints array');
      }
    }
    assert(Array.isArray(j.cross_service_calls), 'cross_service_calls must be array');
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
