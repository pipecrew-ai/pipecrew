#!/usr/bin/env node
/**
 * Unit tests for validate-repo-profile.js.
 * Zero deps: run with `node validate-repo-profile.test.js`.
 *
 * Locks in the REPO_PROFILE gate contract (templates/blocks/block-schemas.md#repo_profile):
 * every example key must be present; role-non-applicable fields are null/[]
 * but never omitted; `integrations` always carries its five sub-arrays;
 * audit_findings severities are enum-checked; a markdown-fenced write is
 * rejected as non-JSON (the truncation/prose catch the split relies on).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'validate-repo-profile.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-repo-profile-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;
function writeProfile(obj, { raw = null, name } = {}) {
  const file = path.join(TMP, name || `profile-${counter++}.json`);
  fs.writeFileSync(file, raw !== null ? raw : JSON.stringify(obj, null, 2));
  return file;
}
function run(arg) {
  return spawnSync('node', [SCRIPT, arg], { encoding: 'utf8' });
}

// A minimal but fully-valid profile (every required key present).
function validProfile() {
  return {
    repo_key: 'publisher-service',
    type: 'spring-boot',
    role: 'api-service',
    description: 'Owns book submission and publication workflow.',
    framework: { name: 'spring-boot', version: '3.5.7' },
    entities: [],
    endpoints: [],
    integrations: {
      outbound_http: [], outbound_events: [], outbound_storage: [],
      inbound_http: [], inbound_events: [],
    },
    auth: null,
    persistence: null,
    tests: null,
    key_conventions: [],
    constraints_observed: [],
    audit_findings: [],
    specs: [],
    frontend_signals: null,
    infra_signals: null,
    metrics: { src_files: 10, scan_truncated: false },
    notes_for_architect: 'Nothing unusual.',
  };
}

// --- happy paths -----------------------------------------------------------

test('valid profile → exit 0', () => {
  const r = run(writeProfile(validProfile()));
  assert(r.status === 0, `expected 0, got ${r.status}: ${r.stderr}`);
});

test('worker profile with event_handlers (no endpoints) → exit 0', () => {
  const p = validProfile();
  delete p.endpoints;
  p.event_handlers = [{ method: 'SQS', path: 'book.uploaded', auth: 'n/a', purpose: 'index' }];
  p.role = 'worker';
  const r = run(writeProfile(p));
  assert(r.status === 0, `expected 0, got ${r.status}: ${r.stderr}`);
});

test('canonical example fixture passes (when present)', () => {
  const ex = path.join(__dirname, '..', 'templates', 'blocks', 'repo-profile.example.json');
  if (!fs.existsSync(ex)) return; // tolerate running outside the repo
  // The example carries an illustrative _comment field — strip it the way
  // a real producer must, then validate the cleaned object.
  const obj = JSON.parse(fs.readFileSync(ex, 'utf8'));
  delete obj._comment;
  const r = run(writeProfile(obj, { name: 'from-example.json' }));
  assert(r.status === 0, `example fixture should validate, got ${r.status}: ${r.stderr}`);
});

// --- structural rejections -------------------------------------------------

test('missing repo_key → exit 1', () => {
  const p = validProfile(); delete p.repo_key;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/repo_key/.test(r.stderr), `stderr should name repo_key: ${r.stderr}`);
});

test('integrations null → exit 1', () => {
  const p = validProfile(); p.integrations = null;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/integrations.*non-null/.test(r.stderr), r.stderr);
});

test('integrations missing a sub-array → exit 1', () => {
  const p = validProfile(); delete p.integrations.inbound_events;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/integrations\.inbound_events/.test(r.stderr), r.stderr);
});

test('bad audit_findings severity → exit 1', () => {
  const p = validProfile();
  p.audit_findings = [{ severity: 'SEVERE', file: 'A.java', line: 1, description: 'x' }];
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/severity/.test(r.stderr), r.stderr);
});

test('spec missing path → exit 1', () => {
  const p = validProfile();
  p.specs = [{ spec_policy_inferred: 'api-first', endpoints_in_spec: 5 }];
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/specs\[0\]\.path/.test(r.stderr), r.stderr);
});

test('omitted entities key → exit 1 (must be null, not absent)', () => {
  const p = validProfile(); delete p.entities;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/entities/.test(r.stderr), r.stderr);
});

test('missing description → exit 1', () => {
  const p = validProfile(); delete p.description;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/description/.test(r.stderr), r.stderr);
});

test('empty-string description → exit 0 (escape hatch when discoverer would guess)', () => {
  const p = validProfile(); p.description = '';
  const r = run(writeProfile(p));
  assert(r.status === 0, `expected 0, got ${r.status}: ${r.stderr}`);
});

test('non-string description → exit 1', () => {
  const p = validProfile(); p.description = 42;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/description.*string/.test(r.stderr), r.stderr);
});

test('entity missing purpose → exit 1', () => {
  const p = validProfile();
  p.entities = [{ name: 'Book', key_states: ['DRAFT'], owning_module: 'publisher' }];
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/entities\[0\]\.purpose/.test(r.stderr), r.stderr);
});

test('entity with empty-string purpose → exit 0', () => {
  const p = validProfile();
  p.entities = [{ name: 'Book', purpose: '', key_states: ['DRAFT'], owning_module: 'publisher' }];
  const r = run(writeProfile(p));
  assert(r.status === 0, `expected 0, got ${r.status}: ${r.stderr}`);
});

test('entity with non-string purpose → exit 1', () => {
  const p = validProfile();
  p.entities = [{ name: 'Book', purpose: 123, key_states: [], owning_module: 'publisher' }];
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/entities\[0\]\.purpose.*string/.test(r.stderr), r.stderr);
});

test('neither endpoints nor event_handlers → exit 1', () => {
  const p = validProfile(); delete p.endpoints;
  const r = run(writeProfile(p));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/endpoints.*event_handlers/.test(r.stderr), r.stderr);
});

test('markdown-fenced JSON → exit 1, flagged as non-JSON', () => {
  const fenced = '```json\n' + JSON.stringify(validProfile()) + '\n```\n';
  const r = run(writeProfile(null, { raw: fenced }));
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/not valid JSON/.test(r.stderr), r.stderr);
});

test('no arg → exit 2 (usage)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 2, `expected 2, got ${r.status}`);
});

// --- directory mode --------------------------------------------------------

test('directory mode: all valid → exit 0', () => {
  const dir = path.join(TMP, `dir-ok-${counter++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(validProfile()));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(validProfile()));
  const r = run(dir);
  assert(r.status === 0, `expected 0, got ${r.status}: ${r.stderr}`);
});

test('directory mode: one invalid → exit 1, names the bad file', () => {
  const dir = path.join(TMP, `dir-bad-${counter++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(validProfile()));
  const bad = validProfile(); delete bad.repo_key;
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(bad));
  const r = run(dir);
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/INVALID  bad\.json/.test(r.stderr), r.stderr);
});

test('directory mode: *example* fixtures are skipped', () => {
  const dir = path.join(TMP, `dir-skip-${counter++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify(validProfile()));
  // An intentionally-broken example fixture must NOT fail the gate.
  fs.writeFileSync(path.join(dir, 'repo-profile.example.json'), '{ not json');
  const r = run(dir);
  assert(r.status === 0, `expected 0 (example skipped), got ${r.status}: ${r.stderr}`);
});

// ---------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
