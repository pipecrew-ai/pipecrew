#!/usr/bin/env node
/**
 * Unit tests for extract-block.js.
 * Zero deps: run with `node extract-block.test.js`.
 *
 * Covers the 4 documented exit codes plus happy-path extraction for each
 * of the canonical block types. Fixtures are synthesized inline and
 * written to a temp dir; cleanup happens at the end.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'extract-block.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-block-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;
function writeFixture(content) {
  const filePath = path.join(TMP, `case-${counter++}.md`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function run(filePath, blockName) {
  const r = spawnSync('node', [SCRIPT, filePath, blockName], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function blockMd(blockName, jsonValue, prose = 'Prose follows.') {
  return [
    '# Test fixture',
    '',
    `<!-- BEGIN ${blockName} -->`,
    '```json',
    JSON.stringify(jsonValue, null, 2),
    '```',
    '',
    prose,
    `<!-- END ${blockName} -->`,
    '',
    'Trailing prose outside the block.',
    '',
  ].join('\n');
}

// -------- Happy paths: each canonical block type --------

test('AFFECTED_SERVICES extracted and parsed', () => {
  const data = {
    services: [{ name: 'publisher-service', spec_policy: 'api-first' }],
    spec_edit_order: ['publisher-service'],
    frontend_required: true,
    mock_required: false,
  };
  const r = run(writeFixture(blockMd('AFFECTED_SERVICES', data)), 'AFFECTED_SERVICES');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.frontend_required === true, 'frontend_required missing');
  assert(out.services[0].name === 'publisher-service', 'service name mismatch');
});

test('REQUIREMENTS_INDEX extracted', () => {
  const data = {
    requirements: [{ id: 'FR-1', summary: 'Upload a book' }],
    edge_cases: [{ id: 'EC-1', summary: 'File > 100MB', applies_to: ['FR-1'] }],
  };
  const r = run(writeFixture(blockMd('REQUIREMENTS_INDEX', data)), 'REQUIREMENTS_INDEX');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.requirements[0].id === 'FR-1');
  assert(out.edge_cases[0].applies_to[0] === 'FR-1');
});

test('COVERAGE extracted', () => {
  const data = {
    coverage: [
      { id: 'FR-1', file: 'src/upload.ts', line: 42, test: 'src/upload.test.ts:18' },
      { id: 'EC-1', file: 'src/upload.ts', line: 67 },
    ],
  };
  const r = run(writeFixture(blockMd('COVERAGE', data)), 'COVERAGE');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.coverage.length === 2);
  assert(out.coverage[0].test === 'src/upload.test.ts:18');
});

test('FINDINGS_SUMMARY extracted', () => {
  const data = {
    critical_total: 2,
    critical_mechanical: 1,
    critical_architectural: 1,
    non_critical_total: 3,
    scope_total: 0,
  };
  const r = run(writeFixture(blockMd('FINDINGS_SUMMARY', data)), 'FINDINGS_SUMMARY');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.critical_total === 2);
  assert(out.critical_mechanical + out.critical_architectural === out.critical_total,
    'mechanical+architectural must equal critical_total');
});

test('multiple blocks in one file — extracts requested one only', () => {
  const a = blockMd('AFFECTED_SERVICES', { services: [], frontend_required: false });
  const b = blockMd('COVERAGE', { coverage: [{ id: 'FR-9', file: 'x', line: 1 }] });
  const r = run(writeFixture(a + '\n\n' + b), 'COVERAGE');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(JSON.parse(r.stdout).coverage[0].id === 'FR-9', 'wrong block extracted');
});

test('block with prose between fence and END marker still extracts', () => {
  const data = { services: [], frontend_required: false };
  const md = blockMd('AFFECTED_SERVICES', data, 'Lots of explanatory prose here that the LLM might write.');
  const r = run(writeFixture(md), 'AFFECTED_SERVICES');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(JSON.parse(r.stdout).frontend_required === false);
});

// -------- Error paths: each documented exit code --------

test('exit 1 on missing file', () => {
  const r = run(path.join(TMP, 'does-not-exist.md'), 'AFFECTED_SERVICES');
  assert(r.exitCode === 1, `expected 1, got ${r.exitCode}`);
});

test('exit 2 on usage error (missing args)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 2, `expected 2, got ${r.status}`);
});

test('exit 2 on block markers absent', () => {
  const r = run(writeFixture('# Just a heading, no block here.\n'), 'AFFECTED_SERVICES');
  assert(r.exitCode === 2, `expected 2, got ${r.exitCode}`);
});

test('exit 2 when only BEGIN marker present, no END', () => {
  const r = run(writeFixture('<!-- BEGIN X -->\n```json\n{}\n```\n'), 'X');
  assert(r.exitCode === 2, `expected 2 (no END marker), got ${r.exitCode}`);
});

test('exit 3 when block exists but no ```json fence', () => {
  const md = '<!-- BEGIN X -->\nJust prose, no code fence at all.\n<!-- END X -->\n';
  const r = run(writeFixture(md), 'X');
  assert(r.exitCode === 3, `expected 3, got ${r.exitCode}`);
});

test('exit 3 when fence is ```yaml not ```json', () => {
  const md = '<!-- BEGIN X -->\n```yaml\nfoo: bar\n```\n<!-- END X -->\n';
  const r = run(writeFixture(md), 'X');
  assert(r.exitCode === 3, `expected 3 (wrong fence language), got ${r.exitCode}`);
});

test('exit 4 on malformed JSON inside fence', () => {
  const md = '<!-- BEGIN X -->\n```json\n{ this is not, valid json }\n```\n<!-- END X -->\n';
  const r = run(writeFixture(md), 'X');
  assert(r.exitCode === 4, `expected 4, got ${r.exitCode}`);
});

// -------- Output shape contract --------

test('stdout is compact single-line JSON (no pretty-print)', () => {
  const data = { a: 1, b: { c: 2 } };
  const r = run(writeFixture(blockMd('X', data)), 'X');
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(!r.stdout.includes('\n'), 'stdout should be single-line for downstream piping');
  assert(JSON.parse(r.stdout).b.c === 2, 'roundtrip failed');
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
