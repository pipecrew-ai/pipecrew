#!/usr/bin/env node
/**
 * Unit tests for mock-artifact.js.
 * Zero deps: run with `node mock-artifact.test.js`.
 *
 * Covers --list and --validate exit-code contract (0/1/2) and FR-8 validity
 * rules. Uses --mocks-dir=<path> to bypass workspace-registry resolution.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'mock-artifact.js');
const TMP    = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-artifact-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(...extraArgs) {
  const r = spawnSync('node', [SCRIPT, ...extraArgs], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function makeArtifact(baseDir, slug, opts = {}) {
  const dir = path.join(baseDir, slug);
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });

  // MOCKS_INDEX.md
  if (opts.noIndex) {
    // don't create it
  } else if (opts.emptyIndex) {
    fs.writeFileSync(path.join(dir, 'MOCKS_INDEX.md'), '');
  } else {
    fs.writeFileSync(path.join(dir, 'MOCKS_INDEX.md'),
      `# Mocks Index\n- requirements.md\n- implementation-spec.md\n`);
  }

  // requirements.md
  if (opts.noRequirements) {
    // don't create it
  } else if (opts.noRequirementsIndex) {
    fs.writeFileSync(path.join(dir, 'requirements.md'),
      '# Requirements\n\nJust prose, no index block.\n');
  } else if (opts.emptyRequirementsArray) {
    fs.writeFileSync(path.join(dir, 'requirements.md'), [
      '# Requirements',
      '',
      '<!-- BEGIN REQUIREMENTS_INDEX -->',
      '```json',
      JSON.stringify({ requirements: [], edge_cases: [] }, null, 2),
      '```',
      '<!-- END REQUIREMENTS_INDEX -->',
    ].join('\n'));
  } else if (opts.malformedJson) {
    fs.writeFileSync(path.join(dir, 'requirements.md'), [
      '# Requirements',
      '',
      '<!-- BEGIN REQUIREMENTS_INDEX -->',
      '```json',
      '{ this is not valid json }',
      '```',
      '<!-- END REQUIREMENTS_INDEX -->',
    ].join('\n'));
  } else {
    // Valid requirements
    const reqIndex = {
      requirements: [{ id: 'FR-1', summary: 'User can do something' }],
      edge_cases:   [{ id: 'EC-1', summary: 'Empty state', applies_to: ['FR-1'] }],
    };
    fs.writeFileSync(path.join(dir, 'requirements.md'), [
      '# Requirements',
      '',
      '## Overview',
      'This feature does X.',
      '',
      '<!-- BEGIN REQUIREMENTS_INDEX -->',
      '```json',
      JSON.stringify(reqIndex, null, 2),
      '```',
      '<!-- END REQUIREMENTS_INDEX -->',
    ].join('\n'));
  }

  return dir;
}

// ---------------------------------------------------------------------------
// --list tests
// ---------------------------------------------------------------------------
const listDir = path.join(TMP, 'list-tests');
fs.mkdirSync(listDir, { recursive: true });

test('--list: absent mocks dir → exit 0, empty output', () => {
  const absentDir = path.join(TMP, 'does-not-exist-mocks');
  const r = run('--list', `--mocks-dir=${absentDir}`);
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}`);
  assert(r.stdout.trim() === '', `expected empty stdout, got: ${JSON.stringify(r.stdout)}`);
});

test('--list: empty mocks dir → exit 0, empty output', () => {
  const emptyDir = path.join(TMP, 'empty-mocks');
  fs.mkdirSync(emptyDir, { recursive: true });
  const r = run('--list', `--mocks-dir=${emptyDir}`);
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}`);
  assert(r.stdout.trim() === '', `expected empty stdout, got: ${JSON.stringify(r.stdout)}`);
});

test('--list: one slug → prints it', () => {
  const dir = path.join(TMP, 'one-slug-mocks');
  fs.mkdirSync(path.join(dir, 'my-feature'), { recursive: true });
  const r = run('--list', `--mocks-dir=${dir}`);
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}`);
  assert(r.stdout.trim() === 'my-feature', `expected 'my-feature', got: ${JSON.stringify(r.stdout.trim())}`);
});

test('--list: multiple slugs → each on its own line', () => {
  const dir = path.join(TMP, 'multi-slug-mocks');
  fs.mkdirSync(path.join(dir, 'feature-a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'feature-b'), { recursive: true });
  const r = run('--list', `--mocks-dir=${dir}`);
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}`);
  const lines = r.stdout.trim().split('\n').sort();
  assert(lines.includes('feature-a'), 'feature-a missing');
  assert(lines.includes('feature-b'), 'feature-b missing');
});

// ---------------------------------------------------------------------------
// --validate tests
// ---------------------------------------------------------------------------
const validateDir = path.join(TMP, 'validate-mocks');
fs.mkdirSync(validateDir, { recursive: true });

test('--validate: missing dir → exit 2 (EC-2 hard stop)', () => {
  const r = run('--validate=nonexistent-slug', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 2, `expected exit 2, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === false, 'expected valid: false');
  assert(result.exit_code === 2, 'expected exit_code: 2 in result');
});

test('--validate: well-formed artifact → exit 0', () => {
  makeArtifact(validateDir, 'well-formed');
  const r = run('--validate=well-formed', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}; stderr: ${r.stderr}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === true, `expected valid: true, got: ${JSON.stringify(result)}`);
  assert(result.defect === null, `expected no defect, got: ${result.defect}`);
});

test('--validate: MOCKS_INDEX.md absent → exit 1, invalid', () => {
  makeArtifact(validateDir, 'no-index', { noIndex: true });
  const r = run('--validate=no-index', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 1, `expected exit 1, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === false, 'expected valid: false');
  assert(result.defect && result.defect.includes('MOCKS_INDEX.md'), `defect should mention MOCKS_INDEX.md: ${result.defect}`);
});

test('--validate: MOCKS_INDEX.md empty → exit 1, invalid', () => {
  makeArtifact(validateDir, 'empty-index', { emptyIndex: true });
  const r = run('--validate=empty-index', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 1, `expected exit 1, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === false, 'expected valid: false');
});

test('--validate: REQUIREMENTS_INDEX block absent → exit 1, invalid', () => {
  makeArtifact(validateDir, 'no-req-index', { noRequirementsIndex: true });
  const r = run('--validate=no-req-index', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 1, `expected exit 1, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === false, 'expected valid: false');
  assert(result.defect && result.defect.includes('REQUIREMENTS_INDEX'), `defect should mention REQUIREMENTS_INDEX: ${result.defect}`);
});

test('--validate: REQUIREMENTS_INDEX with empty requirements[] → exit 1, invalid', () => {
  makeArtifact(validateDir, 'empty-req-array', { emptyRequirementsArray: true });
  const r = run('--validate=empty-req-array', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 1, `expected exit 1, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === false, 'expected valid: false');
  assert(result.defect && result.defect.includes('empty'), `defect should mention empty: ${result.defect}`);
});

test('--validate: malformed JSON in REQUIREMENTS_INDEX → exit 1, invalid', () => {
  makeArtifact(validateDir, 'bad-json', { malformedJson: true });
  const r = run('--validate=bad-json', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 1, `expected exit 1, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.valid === false, 'expected valid: false');
  assert(result.defect && result.defect.includes('malformed'), `defect should mention malformed: ${result.defect}`);
});

test('--validate: result JSON includes path field', () => {
  const r = run('--validate=well-formed', `--mocks-dir=${validateDir}`);
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}`);
  const result = JSON.parse(r.stdout.trim());
  assert(result.path, 'expected path field in result');
  assert(result.path.endsWith('well-formed'), `expected path to end with 'well-formed': ${result.path}`);
});

// ---------------------------------------------------------------------------
// No-args error
// ---------------------------------------------------------------------------
test('no args → exit 1 with usage message', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 1, `expected exit 1, got ${r.status}`);
  assert((r.stderr || '').includes('usage:'), 'expected usage message on stderr');
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
