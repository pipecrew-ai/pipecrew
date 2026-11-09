#!/usr/bin/env node
/**
 * Unit tests for assemble-task-file.js.
 * Zero deps: run with `node assemble-task-file.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'assemble-task-file.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-task-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;

// Build a minimal run_dir fixture; returns { runDir, descriptorPath, write }.
function makeRun(blocks, reqMd, archMd) {
  const runDir = path.join(TMP, `run-${counter++}`);
  const blocksDir = path.join(runDir, 'outputs', 'blocks');
  fs.mkdirSync(blocksDir, { recursive: true });
  for (const [name, obj] of Object.entries(blocks)) {
    fs.writeFileSync(path.join(blocksDir, `${name}.json`), JSON.stringify(obj, null, 2));
  }
  if (reqMd !== undefined) fs.writeFileSync(path.join(runDir, 'outputs', 'phase-1-requirements.md'), reqMd);
  if (archMd !== undefined) fs.writeFileSync(path.join(runDir, 'outputs', 'phase-2-architecture.md'), archMd);
  return runDir;
}

function writeDescriptor(runDir, descriptor) {
  const p = path.join(runDir, `descriptor-${counter++}.json`);
  fs.writeFileSync(p, JSON.stringify(descriptor, null, 2));
  return p;
}

function run(runDir, descriptorPath, extra = []) {
  const r = spawnSync('node', [SCRIPT, '--run-dir', runDir, '--descriptor', descriptorPath, ...extra], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const REQ_MD = [
  '# Feature: Contracts',
  '<!-- BEGIN FUNCTIONAL_REQUIREMENTS -->',
  '## Functional Requirements',
  '- FR-1: Publisher can choose a contract type when requesting.',
  '- FR-2: The contract type is persisted on the Book entity.',
  '- FR-7: Bulk update of contract types across a catalog.',
  '<!-- END FUNCTIONAL_REQUIREMENTS -->',
  '<!-- BEGIN EDGE_CASES -->',
  '## Edge Cases',
  '- EC-1: Reject unknown contract type with HTTP 400.',
  '<!-- END EDGE_CASES -->',
  '<!-- BEGIN OUT_OF_SCOPE -->',
  '## Out of Scope',
  '- Bulk delete of contracts.',
  '<!-- END OUT_OF_SCOPE -->',
].join('\n');

const REQ_INDEX = {
  requirements: [
    { id: 'FR-1', summary: 'choose contract type' },
    { id: 'FR-2', summary: 'persist on Book' },
    { id: 'FR-7', summary: 'bulk update' },
  ],
  edge_cases: [{ id: 'EC-1', summary: 'reject unknown', applies_to: ['FR-1'] }],
};

const RISKS = {
  risks: [],
  deferred_items: [
    { id: 'DEF-1', tag: 'v2', summary: 'Bulk endpoint', rationale: 'low v1 usage', owning_repo: 'publisher-service' },
    { id: 'DEF-2', tag: 'out-of-scope', summary: 'Cross-repo audit log', rationale: 'later', owning_repo: null },
  ],
};

// -------- backend api-first --------

test('backend api-first task: FR bodies pasted, contract reference built, written to tasks/', () => {
  const runDir = makeRun(
    {
      'requirements-index': REQ_INDEX,
      risks: RISKS,
      'api-design': { services: [{ name: 'publisher-service', endpoints: [{ method: 'POST', path: '/contracts', summary: 'create', change_kind: 'added' }] }] },
      'data-model': { entities: [{ name: 'Contract', service: 'publisher-service', change_kind: 'added' }], database_changes: [] },
    },
    REQ_MD,
  );
  const d = writeDescriptor(runDir, {
    task_id: 'contracts-aaa111',
    feature_slug: 'contracts',
    repo_key: 'publisher-service',
    repo_role: 'api-service',
    repo_type: 'spring-boot',
    tier: 'M',
    title: 'DTOs / Models',
    fr_refs: ['FR-1', 'FR-2'],
    spec_policy: 'api-first',
    spec_file: 'openapi/spec.yaml',
    worktree_path: '/wt/publisher-service-contracts',
    checklist_md: '1. ContractType enum\n2. DTOs',
    anti_pattern_bullets: [],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const file = fs.readFileSync(path.join(runDir, 'tasks', 'contracts-aaa111.md'), 'utf8');
  assert(file.includes('Publisher can choose a contract type'), 'FR-1 body not pasted');
  assert(file.includes('The contract type is persisted'), 'FR-2 body not pasted');
  assert(file.includes('**Spec policy**: `api-first`'), 'api-first header missing');
  assert(file.includes('openapi/spec.yaml'), 'spec path missing');
  assert(file.includes('POST /contracts'), 'endpoint missing');
  assert(!file.includes('## Report format'), 'report format should NOT be pasted — it lives in implementer-common.md § Final report delivery');
  // Out of scope: DEF-1 (owned) + DEF-2 (null/cross-repo) both present.
  assert(file.includes('Bulk endpoint'), 'owned deferred item missing');
  assert(file.includes('Cross-repo audit log'), 'cross-repo deferred item missing');
});

// -------- frontend with fe_refs --------

test('frontend task filters components/routes/api by fe_refs ids', () => {
  const FA = {
    components: [
      { id: 'c-page', name: 'ContractsPage', path: 'src/pages/ContractsPage.tsx', kind: 'page', change_kind: 'added', purpose: 'host', children: ['ContractList'] },
      { id: 'c-list', name: 'ContractList', path: 'src/features/contracts/ContractList.tsx', kind: 'component', change_kind: 'added', purpose: 'list', children: [] },
      { id: 'c-dialog', name: 'ContractDialog', path: 'src/features/contracts/ContractDialog.tsx', kind: 'component', change_kind: 'added', purpose: 'detail', children: [] },
    ],
    routes: [{ id: 'r-contracts', path: '/contracts', change_kind: 'added', page_component: 'ContractsPage', guard: 'publisher' }],
    api_integration: [{ id: 'a-list', service_function: 'listContracts', file: 'src/api/contracts.ts', endpoint: 'GET /contracts', request_type: 'void', response_type: 'Contract[]' }],
  };
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS, 'frontend-architecture': FA }, REQ_MD);
  const d = writeDescriptor(runDir, {
    task_id: 'contracts-fe001',
    feature_slug: 'contracts',
    repo_key: 'frontend',
    repo_role: 'frontend',
    repo_type: 'react',
    tier: 'M',
    title: 'Page + components',
    fr_refs: ['FR-1'],
    spec_policy: 'n/a',
    worktree_path: null,
    fe_refs: { component_ids: ['c-page', 'c-list'], route_ids: ['r-contracts'], api_ids: ['a-list'] },
    checklist_md: '1. page\n2. list',
    anti_pattern_bullets: [],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const file = fs.readFileSync(path.join(runDir, 'tasks', 'contracts-fe001.md'), 'utf8');
  assert(file.includes('ContractsPage'), 'selected component missing');
  assert(file.includes('ContractList'), 'selected component missing');
  assert(!file.includes('ContractDialog'), 'unselected component leaked in');
  assert(file.includes('/contracts'), 'route missing');
  assert(file.includes('listContracts'), 'api integration missing');
  assert(!file.includes('## Contract Reference'), 'frontend should omit Contract Reference');
  assert(file.includes('TBD — Phase 5 will create a worktree'), 'worktree TBD line missing');
});

// -------- fail-loud paths --------

test('exit 3 when an fr_ref is absent from requirements-index.json', () => {
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS }, REQ_MD);
  const d = writeDescriptor(runDir, {
    task_id: 'x-bad', feature_slug: 'x', repo_key: 'publisher-service', repo_role: 'api-service',
    repo_type: 'spring-boot', tier: 'M', title: 'T', fr_refs: ['FR-99'], spec_policy: 'api-first',
    worktree_path: '/wt/x', checklist_md: '1', anti_pattern_bullets: [],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 3, `expected 3, got ${r.exitCode}; stderr: ${r.stderr}`);
});

test('exit 4 when an fe_ref names an unknown id', () => {
  const FA = { components: [{ id: 'c-a', name: 'A', path: 'a.tsx', change_kind: 'added' }], routes: [], api_integration: [] };
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS, 'frontend-architecture': FA }, REQ_MD);
  const d = writeDescriptor(runDir, {
    task_id: 'x-fe', feature_slug: 'x', repo_key: 'frontend', repo_role: 'frontend', repo_type: 'react',
    tier: 'M', title: 'T', fr_refs: ['FR-1'], spec_policy: 'n/a', worktree_path: null,
    fe_refs: { component_ids: ['c-nope'], route_ids: [], api_ids: [] }, checklist_md: '1', anti_pattern_bullets: [],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 4, `expected 4, got ${r.exitCode}; stderr: ${r.stderr}`);
});

test('exit 5 when FR body cannot be found in phase-1-requirements.md', () => {
  const reqMdNoBody = REQ_MD.replace('- FR-1: Publisher can choose a contract type when requesting.', '');
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS }, reqMdNoBody);
  const d = writeDescriptor(runDir, {
    task_id: 'x-nobody', feature_slug: 'x', repo_key: 'publisher-service', repo_role: 'api-service',
    repo_type: 'spring-boot', tier: 'M', title: 'T', fr_refs: ['FR-1'], spec_policy: 'api-first',
    worktree_path: '/wt/x', checklist_md: '1', anti_pattern_bullets: [],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 5, `expected 5, got ${r.exitCode}; stderr: ${r.stderr}`);
});

// -------- anti-patterns omission (EC-5) --------

test('anti-patterns section omitted when fewer than 3 bullets survive', () => {
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS, 'api-design': { services: [] } }, REQ_MD);
  const d = writeDescriptor(runDir, {
    task_id: 'x-ap', feature_slug: 'x', repo_key: 'publisher-service', repo_role: 'api-service',
    repo_type: 'spring-boot', tier: 'M', title: 'T', fr_refs: ['FR-1'], spec_policy: 'api-first',
    worktree_path: '/wt/x', checklist_md: '1', anti_pattern_bullets: ['only one'],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const file = fs.readFileSync(path.join(runDir, 'tasks', 'x-ap.md'), 'utf8');
  assert(!file.includes('## Known Anti-Patterns'), 'anti-patterns should be omitted (<3 bullets)');
});

// -------- old-schema frontend fallback (EC-7) --------

test('old-schema frontend-architecture (no ids) assembles with pre-filtered arrays', () => {
  const FA = { components: [{ name: 'A', path: 'a.tsx', change_kind: 'added' }], routes: [], api_integration: [] };
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS, 'frontend-architecture': FA }, REQ_MD);
  const d = writeDescriptor(runDir, {
    task_id: 'x-old', feature_slug: 'x', repo_key: 'frontend', repo_role: 'frontend', repo_type: 'react',
    tier: 'M', title: 'T', fr_refs: ['FR-1'], spec_policy: 'n/a', worktree_path: null,
    fe_components: [{ name: 'A', path: 'a.tsx', change_kind: 'added' }], checklist_md: '1', anti_pattern_bullets: [],
  });
  const r = run(runDir, d);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const file = fs.readFileSync(path.join(runDir, 'tasks', 'x-old.md'), 'utf8');
  assert(file.includes('A (a.tsx'), 'fallback component missing');
});

// -------- array descriptor + usage error --------

test('array descriptor writes multiple files; stdout lists all', () => {
  const runDir = makeRun({ 'requirements-index': REQ_INDEX, risks: RISKS, 'api-design': { services: [] } }, REQ_MD);
  const d = writeDescriptor(runDir, [
    { task_id: 't1', feature_slug: 'x', repo_key: 'publisher-service', repo_role: 'api-service', repo_type: 'spring-boot', tier: 'M', title: 'A', fr_refs: ['FR-1'], spec_policy: 'api-first', worktree_path: '/wt/x', checklist_md: '1', anti_pattern_bullets: [] },
    { task_id: 't2', feature_slug: 'x', repo_key: 'publisher-service', repo_role: 'api-service', repo_type: 'spring-boot', tier: 'M', title: 'B', fr_refs: ['FR-2'], spec_policy: 'api-first', worktree_path: '/wt/x', checklist_md: '1', anti_pattern_bullets: [] },
  ]);
  const r = run(runDir, d);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(fs.existsSync(path.join(runDir, 'tasks', 't1.md')), 't1 missing');
  assert(fs.existsSync(path.join(runDir, 'tasks', 't2.md')), 't2 missing');
  const out = JSON.parse(r.stdout);
  assert(out.tasks.length === 2, 'stdout task count mismatch');
});

test('exit 2 on missing args', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 2, `expected 2, got ${r.status}`);
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
