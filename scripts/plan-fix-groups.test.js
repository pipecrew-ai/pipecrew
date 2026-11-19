#!/usr/bin/env node
/**
 * Unit tests for plan-fix-groups.js.
 * Zero deps: run with `node plan-fix-groups.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'plan-fix-groups.js');
const EXAMPLE = path.join(__dirname, '..', 'templates', 'blocks', 'regression-failures.example.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fix-groups-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let n = 0;
function write(content) {
  const p = path.join(TMP, `${n++}.json`);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* non-JSON output */ }
  return { code: r.status, json, err: r.stderr };
}

function f(id, over = {}) {
  return Object.assign({
    case_id: id, feature: 'book-upload', surface: 'api', covers: ['FR-1'],
    repos_touched: ['publisher-service'], when: 'POST /books with x', then: 'ok', observed: 'not ok',
    evidence: { file_line: null, http: null, screenshot: null, command: null },
    mode: 'live', localized: false,
  }, over);
}
const fl = (p) => ({ file_line: p, http: null, screenshot: null, command: null });

test('two failures at the same file → one group', () => {
  const r = run([`--input=${write({ failures: [
    f('TC-a-01', { evidence: fl('svc/A.java:10'), localized: true }),
    f('TC-a-02', { evidence: fl('svc/A.java:42'), localized: true }),
  ] })}`]);
  assert(r.code === 0, r.err);
  assert(r.json.groups.length === 1, JSON.stringify(r.json));
  assert(r.json.groups[0].locus === 'svc/A.java');
  assert(r.json.groups[0].path === 'direct');
  assert(r.json.groups[0].case_ids.join() === 'TC-a-01,TC-a-02');
});

test('same repo, different files → two groups, sorted', () => {
  const r = run([`--input=${write({ failures: [
    f('TC-a-01', { evidence: fl('svc/B.java:1'), localized: true }),
    f('TC-a-02', { evidence: fl('svc/A.java:1'), localized: true }),
  ] })}`]);
  assert(r.json.groups.length === 2);
  assert(r.json.groups[0].locus === 'svc/A.java' && r.json.groups[0].id === 'G1');
});

test('http-only failure → http locus with route, diagnose', () => {
  const r = run([`--input=${write({ failures: [
    f('TC-a-01', { evidence: { file_line: null, http: '500 {"error":"x"}', screenshot: null, command: null } }),
  ] })}`]);
  const g = r.json.groups[0];
  assert(g.locus === 'http:500 POST /books', g.locus);
  assert(g.path === 'diagnose');
});

test('code-grounded non-localized → direct', () => {
  const r = run([`--input=${write({ failures: [f('TC-a-01', { mode: 'code-grounded' })] })}`]);
  assert(r.json.groups[0].path === 'direct');
  assert(r.json.groups[0].locus === 'surface:api');
});

test('mixed localized + non-localized in one group → diagnose', () => {
  const r = run([`--input=${write({ failures: [
    f('TC-a-01', { evidence: fl('svc/A.java:1'), localized: true }),
    f('TC-a-02', { evidence: fl('svc/A.java:9'), localized: false }),
  ] })}`]);
  assert(r.json.groups.length === 1 && r.json.groups[0].path === 'diagnose');
});

test('group touching 3 repos → bounce flag', () => {
  const r = run([`--input=${write({ failures: [
    f('TC-a-01', { repos_touched: ['a', 'b', 'c'] }),
  ] })}`]);
  assert(r.json.groups[0].bounce === 'touches >2 repos');
  assert(r.json.groups[0].repo === 'a');
});

test('two repos → no bounce', () => {
  const r = run([`--input=${write({ failures: [f('TC-a-01', { repos_touched: ['a', 'b'] })] })}`]);
  assert(r.json.groups[0].bounce === null);
});

test('empty failures → {groups: []}', () => {
  const r = run([`--input=${write({ failures: [] })}`]);
  assert(r.code === 0 && Array.isArray(r.json.groups) && r.json.groups.length === 0);
});

test('bare array input accepted', () => {
  const r = run([`--input=${write([f('TC-a-01')])}`]);
  assert(r.code === 0 && r.json.groups.length === 1);
});

test('canonical example → one direct (file) group, one diagnose (http) group', () => {
  const r = run([`--input=${EXAMPLE}`]);
  assert(r.code === 0, r.err);
  assert(r.json.groups.length === 2, JSON.stringify(r.json.groups.map(g => g.locus)));
  const direct = r.json.groups.find(g => g.path === 'direct');
  const diag = r.json.groups.find(g => g.path === 'diagnose');
  assert(direct && /BookService\.java$/.test(direct.locus), JSON.stringify(direct));
  assert(diag && diag.locus.startsWith('http:500') && diag.bounce === null, JSON.stringify(diag));
});

test('bad JSON → exit 4', () => {
  assert(run([`--input=${write('{nope')}`]).code === 4);
});

test('wrong shape → exit 4', () => {
  assert(run([`--input=${write({ foo: 1 })}`]).code === 4);
});

test('missing --input → exit 2', () => {
  assert(run([]).code === 2);
});

test('unreadable input → exit 1', () => {
  assert(run([`--input=${path.join(TMP, 'does-not-exist.json')}`]).code === 1);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
