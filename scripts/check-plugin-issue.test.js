#!/usr/bin/env node
/**
 * Unit tests for check-plugin-issue.js.
 * Zero deps: run with `node check-plugin-issue.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'check-plugin-issue.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plugin-issue-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let n = 0;
function write(name, content) {
  const p = path.join(TMP, `${n++}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const config = write('config.json', JSON.stringify({
  workspace: { name: 'Acme Billing Platform', slug: 'acme-billing' },
  repos: {
    'acme-invoice-api': { path: '/nonexistent/dir/invoice-core', repo_url: 'https://github.com/globex-corp/ledger-service.git', type: 'nestjs' },
    'docs': { path: '/nonexistent/docs', type: 'other' },
    'orphan': { path: '/nonexistent/orphan' },
  },
  services: { 'payment-gateway': { name: 'Payment Gateway' } },
}));

const CLEAN = [
  '<!-- BEGIN ISSUE_DRAFT finding-1 -->',
  'title: Require role-guard check in agents/react-implementer.md',
  '## Problem', 'A NestJS service with role-gated endpoints ships without the matching route guard in a React frontend.',
  'See https://github.com/pipecrew-ai/pipecrew for context.',
].join('\n');

function expectHit(label, body, kind, withConfig = true) {
  test(label, () => {
    const d = write('draft.md', body);
    const r = run([`--draft=${d}`, ...(withConfig ? [`--config=${config}`] : []), '--json']);
    assert(r.code === 1, `exit ${r.code}: ${r.out}${r.err}`);
    const j = JSON.parse(r.out);
    assert(j.ok === false && j.hits.some(h => h.kind === kind), `no ${kind} hit: ${r.out}`);
  });
}

console.log('\ncheck-plugin-issue tests\n');

test('clean draft -> exit 0', () => {
  const r = run([`--draft=${write('clean.md', CLEAN)}`, `--config=${config}`]);
  assert(r.code === 0, `exit ${r.code}: ${r.out}`);
});
expectHit('workspace slug', 'Problem in acme-billing flows', 'workspace');
expectHit('workspace name (case-insensitive)', 'the acme billing platform did x', 'workspace');
expectHit('repo key', 'the acme-invoice-api repo', 'repo');
expectHit('repo_url owner', 'owned by Globex-Corp teams', 'repo-url-owner');
expectHit('repo_url repo name', 'the ledger-service app', 'repo-url');
expectHit('service name', 'calls Payment Gateway first', 'service');
expectHit('absolute Windows path', 'edit C:\\Users\\bob\\proj\\x.ts', 'abs-path', false);
expectHit('absolute POSIX path', 'edit /home/bob/proj/x.ts', 'abs-path', false);
expectHit('email', 'ask bob@example.com', 'email', false);
expectHit('foreign github url', 'see https://github.com/other-org/thing/pull/3', 'foreign-url', false);
expectHit('fake AWS key', 'key AKIAABCDEFGHIJKLMNOP leaked', 'secret', false);

test('allowlisted generic word (docs, frontend) -> exit 0', () => {
  const r = run([`--draft=${write('g.md', 'the docs frontend and api service')}`, `--config=${config}`]);
  assert(r.code === 0, `exit ${r.code}: ${r.out}`);
});
test('repo lacking repo_url and not a git repo contributes key + basename only (no crash)', () => {
  const r = run([`--draft=${write('o.md', 'orphan thing')}`, `--config=${config}`]);
  assert(r.code === 1 && /repo/.test(r.out), `exit ${r.code}: ${r.out}`);
});
test('no --config -> only always-on patterns', () => {
  const r = run([`--draft=${write('nc.md', 'acme-billing and acme-invoice-api')}`]);
  assert(r.code === 0, `exit ${r.code}: ${r.out}`);
});
test('plain output line is "kind  term  line:col"', () => {
  const r = run([`--draft=${write('p.md', 'a\nuse acme-billing')}`, `--config=${config}`]);
  assert(r.code === 1 && /^workspace {2}acme-billing {2}2:5$/m.test(r.out), r.out);
});
test('missing draft file -> exit 2', () => {
  assert(run([`--draft=${path.join(TMP, 'nope.md')}`]).code === 2);
});
test('no args -> exit 2', () => {
  assert(run([]).code === 2);
});
test('unreadable config -> exit 2', () => {
  assert(run([`--draft=${write('c.md', 'x')}`, `--config=${path.join(TMP, 'nope.json')}`]).code === 2);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
