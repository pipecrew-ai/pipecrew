#!/usr/bin/env node
/**
 * Unit tests for validate-config.js.
 * Zero deps: run with `node validate-config.test.js`.
 *
 * Locks in the role-agnostic semantics of spec_copies — the validator
 * must accept and check spec_copies on ANY role (api-service, frontend,
 * mock-server, infrastructure, shared-lib, other), not just frontend +
 * mock-server. This contract underpins the spec_copies generalization
 * plan; if any future change scopes spec_copies to a role subset, these
 * tests will fail loudly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'validate-config.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;

// Build a workspace skeleton on disk (real dirs + files), return paths.
function makeWorkspace(repos = {}, services = {}) {
  const wsDir = path.join(TMP, `ws-${counter++}`);
  fs.mkdirSync(wsDir, { recursive: true });

  const repoEntries = {};
  for (const [name, spec] of Object.entries(repos)) {
    const repoDir = path.join(wsDir, name);
    fs.mkdirSync(repoDir, { recursive: true });
    // Materialize any declared spec files / spec_copies targets so the validator's
    // existence checks pass (when we want them to).
    if (spec.spec_file && !spec._omitSpecFile) {
      const full = path.join(repoDir, spec.spec_file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'openapi: 3.0.0\n');
    }
    if (spec.spec_copies && !spec._omitCopies) {
      for (const relPath of Object.values(spec.spec_copies)) {
        const full = path.join(repoDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, 'openapi: 3.0.0\n');
      }
    }
    const { _omitSpecFile, _omitCopies, ...keep } = spec;
    repoEntries[name] = { path: repoDir, ...keep };
  }

  const config = {
    workspace: { name: 'Test', slug: 'test' },
    repos: repoEntries,
    services,
  };
  const configPath = path.join(wsDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function run(configPath) {
  const r = spawnSync('node', [SCRIPT, configPath], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// -------- Baseline: minimal valid config --------

test('minimal valid config — exit 0, no warnings', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml' } },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

// -------- Role-agnostic spec_copies — the new contract --------

test('spec_copies on api-service consumer is accepted (backend-to-backend codegen)', () => {
  const cfg = makeWorkspace(
    {
      'publisher-svc':  { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml' },
      'billing-svc':    { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml',
                          spec_copies: { 'publisher-svc': 'src/main/resources/clients/publisher.yaml' } },
    },
    {
      'publisher-svc': { repo: 'publisher-svc', spec_policy: 'api-first' },
      'billing-svc':   { repo: 'billing-svc',   spec_policy: 'api-first' },
    },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(!r.stderr.includes('spec_copies'), 'should not warn on valid api-service spec_copies');
});

test('spec_copies on infrastructure consumer is accepted (CDK / Terraform API Gateway integration)', () => {
  const cfg = makeWorkspace(
    {
      'order-svc': { type: 'fastapi',   role: 'api-service',    spec_file: 'app/openapi.yaml' },
      'infra':     { type: 'cdk',       role: 'infrastructure',
                     spec_copies: { 'order-svc': 'lib/specs/order.yaml' } },
    },
    { 'order-svc': { repo: 'order-svc', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

test('spec_copies on shared-lib consumer is accepted (SDK / contract-test repo)', () => {
  const cfg = makeWorkspace(
    {
      'svc-a':     { type: 'nestjs', role: 'api-service', spec_file: 'openapi.yaml' },
      'sdk':       { type: 'other',  role: 'shared-lib',
                     spec_copies: { 'svc-a': 'specs/svc-a.yaml' } },
    },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

test('spec_copies on frontend consumer (the historical case) still works', () => {
  const cfg = makeWorkspace(
    {
      'svc-a':    { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml' },
      'frontend': { type: 'react',       role: 'frontend',
                    spec_copies: { 'svc-a': 'src/api/svc-a-spec.yaml' } },
    },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

test('spec_copies on mock-server consumer (the historical case) still works', () => {
  const cfg = makeWorkspace(
    {
      'svc-a':       { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml' },
      'mock-server': { type: 'node-mock',   role: 'mock-server',
                       spec_copies: { 'svc-a': 'svc-a/specs.yaml' } },
    },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

// -------- spec_copies path-existence warning works regardless of role --------

test('missing spec_copies target on api-service consumer triggers warning', () => {
  const cfg = makeWorkspace(
    {
      'publisher-svc': { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml' },
      'billing-svc':   { type: 'spring-boot', role: 'api-service', spec_file: 'openapi/specs.yaml',
                         spec_copies: { 'publisher-svc': 'src/clients/publisher.yaml' },
                         _omitCopies: true },
    },
    {
      'publisher-svc': { repo: 'publisher-svc', spec_policy: 'api-first' },
      'billing-svc':   { repo: 'billing-svc',   spec_policy: 'api-first' },
    },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(r.stderr.includes('billing-svc.spec_copies.publisher-svc'), 'warning should name the missing copy');
});

test('missing spec_copies target on infrastructure consumer triggers warning', () => {
  const cfg = makeWorkspace(
    {
      'order-svc': { type: 'fastapi', role: 'api-service',    spec_file: 'app/openapi.yaml' },
      'infra':     { type: 'cdk',     role: 'infrastructure',
                     spec_copies: { 'order-svc': 'lib/specs/order.yaml' },
                     _omitCopies: true },
    },
    { 'order-svc': { repo: 'order-svc', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(r.stderr.includes('infra.spec_copies.order-svc'), 'warning should name the missing copy');
});

// -------- Existing validations: role + type + spec_policy --------

test('unknown role triggers warning', () => {
  const cfg = makeWorkspace(
    { 'weird': { type: 'other', role: 'not-a-real-role' } },
    {},
  );
  const r = run(cfg);
  assert(r.stderr.includes('not-a-real-role'), 'warning should name the bad role');
});

test('api-first service without spec_file triggers warning', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'spring-boot', role: 'api-service' } },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.stderr.includes('api-first') && r.stderr.includes('spec_file'),
    'warning should mention api-first + spec_file');
});

test('no-api service WITH spec_file triggers warning', () => {
  const cfg = makeWorkspace(
    { 'wkr': { type: 'python-worker', role: 'worker', spec_file: 'should-not-be-here.yaml' } },
    { 'wkr': { repo: 'wkr', spec_policy: 'no-api' } },
  );
  const r = run(cfg);
  assert(r.stderr.includes('no-api'), 'warning should mention no-api');
});

test('invalid spec_policy is an error (exit 1)', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'spring-boot', role: 'api-service', spec_file: 'openapi.yaml' } },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'magic-mode' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 1, `expected 1, got ${r.exitCode}`);
});

test('service references unknown repo is an error', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'spring-boot', role: 'api-service', spec_file: 'openapi.yaml' } },
    { 'ghost': { repo: 'does-not-exist', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 1, `expected 1, got ${r.exitCode}`);
});

// -------- repo_url (optional clone URL for /join) --------

test('repo_url with an SSH git URL is accepted', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'spring-boot', role: 'api-service', spec_file: 'openapi.yaml',
                 repo_url: 'git@github.com:acme/svc-a.git' } },
    { 'svc-a': { repo: 'svc-a', spec_policy: 'api-first' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

test('repo_url with a bare https URL is accepted', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'react', role: 'frontend', repo_url: 'https://github.com/acme/svc-a.git' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
});

test('repo_url embedding credentials (user:token@) is a hard error', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'react', role: 'frontend',
                 repo_url: 'https://x-access-token:ghp_deadbeef@github.com/acme/svc-a.git' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 1, `expected 1, got ${r.exitCode}`);
  assert(r.stderr.includes('credentials'), `expected a credentials error; stderr: ${r.stderr}`);
});

test('repo_url that is an empty string is an error', () => {
  const cfg = makeWorkspace(
    { 'svc-a': { type: 'react', role: 'frontend', repo_url: '' } },
  );
  const r = run(cfg);
  assert(r.exitCode === 1, `expected 1, got ${r.exitCode}`);
});

// -------- Cleanup --------
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
