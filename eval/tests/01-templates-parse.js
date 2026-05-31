#!/usr/bin/env node
/**
 * Layer 1 — every templates/blocks/*.example.json parses as valid JSON.
 *
 * Why this matters: agent prompts and templates/blocks/block-schemas.md cite these
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
// These mirror what consumer agents and templates/blocks/block-schemas.md document.
const SHAPE_CHECKS = {
  'affected-contracts.example.json': (j) => {
    assert(Array.isArray(j.contracts), 'contracts must be array');
    assert(Array.isArray(j.edit_order), 'edit_order must be array');
    assert(typeof j.breaking_changes_authorized === 'boolean',
      'breaking_changes_authorized must be boolean');
    const repoKeys = new Set();
    for (const c of j.contracts) {
      assert(typeof c.repo_key === 'string', 'contract.repo_key must be string');
      repoKeys.add(c.repo_key);
      assert(['avro', 'json-schema', 'protobuf', 'mixed'].includes(c.format),
        `contract.format must be avro | json-schema | protobuf | mixed (got ${c.format})`);
      assert(Array.isArray(c.files), 'contract.files must be array');
      for (const f of c.files) {
        assert(typeof f.path === 'string', 'file.path must be string');
        assert(['added', 'modified', 'removed'].includes(f.change_kind),
          `file.change_kind must be added | modified | removed (got ${f.change_kind})`);
        assert(['additive', 'breaking'].includes(f.classification),
          `file.classification must be additive | breaking (got ${f.classification})`);
      }
    }
    // edit_order must reference every contracts[].repo_key
    for (const c of j.contracts) {
      assert(j.edit_order.includes(c.repo_key),
        `edit_order missing repo_key "${c.repo_key}"`);
    }
    // If any file is breaking, breaking_changes_authorized must be true
    const anyBreaking = j.contracts.some(c => c.files.some(f => f.classification === 'breaking'));
    if (anyBreaking) {
      assert(j.breaking_changes_authorized === true,
        'breaking_changes_authorized must be true when any file.classification is breaking');
    }
  },
  'affected-services.example.json': (j) => {
    assert(Array.isArray(j.services), 'services must be array');
    assert('frontend_required' in j, 'frontend_required must be present');
    assert('mock_required' in j, 'mock_required must be present');
    assert(Array.isArray(j.spec_edit_order), 'spec_edit_order must be array');
  },
  'mapper-report.example.json': (j) => {
    assert(Array.isArray(j.scanned_repos), 'scanned_repos must be array');
    assert(Array.isArray(j.edges), 'edges must be array');
    assert(Array.isArray(j.unresolved), 'unresolved must be array');
    assert(Array.isArray(j.skipped), 'skipped must be array');
    assert(typeof j.stats === 'object' && j.stats !== null, 'stats must be object');
    for (const e of j.edges) {
      assert(['http', 'event-publish', 'event-consume', 'db', 'cross-stack'].includes(e.kind),
        `edge.kind must be http | event-publish | event-consume | db | cross-stack (got ${e.kind})`);
      assert(['high', 'medium', 'low'].includes(e.confidence),
        `edge.confidence must be high | medium | low (got ${e.confidence})`);
    }
    assert(j.stats.edges_high_confidence + j.stats.edges_medium_confidence + j.stats.edges_low_confidence === j.stats.total_edges,
      'stats edge counts must sum to total_edges');
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
  'risks.example.json': (j) => {
    assert(Array.isArray(j.risks), 'risks must be array');
    assert(Array.isArray(j.deferred_items), 'deferred_items must be array');
    const seenIds = new Set();
    for (const r of j.risks) {
      assert(typeof r.id === 'string' && /^R-\d+$/.test(r.id),
        `risk.id must match R-\\d+ (got ${r.id})`);
      assert(!seenIds.has(r.id), `duplicate risk id: ${r.id}`);
      seenIds.add(r.id);
      assert(typeof r.summary === 'string' && r.summary.length > 0, 'risk.summary must be non-empty string');
      assert(typeof r.mitigation === 'string', 'risk.mitigation must be string');
      if ('severity' in r) {
        assert(['low', 'medium', 'high', 'critical'].includes(r.severity),
          `risk.severity must be low | medium | high | critical (got ${r.severity})`);
      }
    }
    const defIds = new Set();
    for (const d of j.deferred_items) {
      assert(typeof d.id === 'string' && /^DEF-\d+$/.test(d.id),
        `deferred_item.id must match DEF-\\d+ (got ${d.id})`);
      assert(!defIds.has(d.id), `duplicate deferred_item id: ${d.id}`);
      defIds.add(d.id);
      assert(['deferred', 'out-of-scope', 'follow-up', 'v2', 'enhancement'].includes(d.tag),
        `deferred_item.tag must be deferred | out-of-scope | follow-up | v2 | enhancement (got ${d.tag})`);
      assert(typeof d.summary === 'string' && d.summary.length > 0, 'deferred_item.summary must be non-empty string');
      assert(typeof d.rationale === 'string' && d.rationale.length > 0, 'deferred_item.rationale must be non-empty string');
      assert(d.owning_repo === null || typeof d.owning_repo === 'string',
        'deferred_item.owning_repo must be string or null');
    }
  },
  'frontend-architecture.example.json': (j) => {
    assert(Array.isArray(j.components), 'components must be array');
    assert(Array.isArray(j.routes), 'routes must be array');
    assert(Array.isArray(j.api_integration), 'api_integration must be array');
    const componentNames = new Set();
    for (const c of j.components) {
      assert(typeof c.name === 'string' && c.name.length > 0, 'component.name must be non-empty string');
      assert(!componentNames.has(c.name), `duplicate component name: ${c.name}`);
      componentNames.add(c.name);
      assert(typeof c.path === 'string' && c.path.length > 0, 'component.path must be non-empty string');
      assert(['page', 'component', 'hook', 'provider', 'layout'].includes(c.kind),
        `component.kind must be page | component | hook | provider | layout (got ${c.kind})`);
      assert(['added', 'modified', 'removed'].includes(c.change_kind),
        `component.change_kind must be added | modified | removed (got ${c.change_kind})`);
      assert(typeof c.purpose === 'string', 'component.purpose must be string');
      assert(Array.isArray(c.children), 'component.children must be array');
    }
    for (const r of j.routes) {
      assert(typeof r.path === 'string', 'route.path must be string');
      assert(['added', 'modified', 'removed'].includes(r.change_kind),
        `route.change_kind must be added | modified | removed (got ${r.change_kind})`);
      // page_component must reference an entry in components[]
      assert(componentNames.has(r.page_component),
        `route.page_component "${r.page_component}" not declared in components[]`);
      assert(r.guard === null || typeof r.guard === 'string',
        'route.guard must be string or null');
    }
    for (const a of j.api_integration) {
      assert(typeof a.service_function === 'string', 'api_integration.service_function must be string');
      assert(typeof a.file === 'string', 'api_integration.file must be string');
      assert(typeof a.endpoint === 'string' && /^(GET|POST|PUT|PATCH|DELETE) /.test(a.endpoint),
        `api_integration.endpoint must start with HTTP method (got ${a.endpoint})`);
      assert(typeof a.request_type === 'string', 'api_integration.request_type must be string');
      assert(typeof a.response_type === 'string', 'api_integration.response_type must be string');
    }
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
