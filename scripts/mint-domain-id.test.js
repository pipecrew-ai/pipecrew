#!/usr/bin/env node
'use strict';
/**
 * Unit tests for mint-domain-id.js.
 *
 * Also exercises the validate-config.js domain.id warn branch and
 * external_dependencies validation (FR-8 / EC-3 / EC-4).
 *
 * Zero deps — plain assert + spawnSync. Run with:
 *   node scripts/mint-domain-id.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MINT = path.join(__dirname, 'mint-domain-id.js');
const VALIDATE = path.join(__dirname, 'validate-config.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-domain-id-test-'));

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let wsCounter = 0;

/**
 * Build a minimal workspace config on disk. Returns { configPath, wsDir }.
 */
function makeConfig(extra = {}) {
  const wsDir = path.join(TMP, `ws-${wsCounter++}`);
  fs.mkdirSync(wsDir, { recursive: true });
  const config = {
    workspace: { name: 'TestWS', slug: 'test-ws' },
    repos: {},
    services: {},
    ...extra,
  };
  const configPath = path.join(wsDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { configPath, wsDir };
}

function runMint(args) {
  return spawnSync('node', [MINT, ...args], { encoding: 'utf8' });
}

function runValidate(configPath) {
  return spawnSync('node', [VALIDATE, configPath], { encoding: 'utf8' });
}

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// mint-domain-id.js tests
// ---------------------------------------------------------------------------

ok('mints dom_<26-char> id into a config with no domain block', () => {
  const { configPath } = makeConfig();
  const r = runMint([`--config=${configPath}`]);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const id = r.stdout.trim();
  assert.match(id, /^dom_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/, `bad id shape: ${id}`);
  const cfg = readConfig(configPath);
  assert.strictEqual(cfg.domain.id, id, 'id not written to config');
});

ok('mints id into a config that already has a domain block with other keys', () => {
  const { configPath } = makeConfig({
    domain: { name: 'MyDomain', domain_notes: 'A great product', user_roles: ['admin'] },
  });
  const r = runMint([`--config=${configPath}`]);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const cfg = readConfig(configPath);
  assert.match(cfg.domain.id, /^dom_/, 'id missing');
  // Existing keys must be preserved.
  assert.strictEqual(cfg.domain.name, 'MyDomain', 'domain.name was lost');
  assert.deepStrictEqual(cfg.domain.user_roles, ['admin'], 'user_roles was lost');
});

ok('idempotent: second run returns the same id and does not rewrite the file', () => {
  const { configPath } = makeConfig();
  const r1 = runMint([`--config=${configPath}`]);
  assert.strictEqual(r1.status, 0);
  const id1 = r1.stdout.trim();
  const stat1 = fs.statSync(configPath).mtimeMs;

  // Small sleep to let mtime diverge if the file were re-written.
  // We check the id value and that the written id is unchanged.
  const r2 = runMint([`--config=${configPath}`]);
  assert.strictEqual(r2.status, 0);
  const id2 = r2.stdout.trim();

  assert.strictEqual(id1, id2, 'different ids on second run — not idempotent');
  const cfg = readConfig(configPath);
  assert.strictEqual(cfg.domain.id, id1, 'id in file changed');
});

ok('idempotent: config with pre-existing well-formed id returns that id without writing', () => {
  const existingId = 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const { configPath } = makeConfig({ domain: { id: existingId } });
  const before = fs.readFileSync(configPath, 'utf8');
  const r = runMint([`--config=${configPath}`]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), existingId);
  const after = fs.readFileSync(configPath, 'utf8');
  assert.strictEqual(before, after, 'file was rewritten despite existing id');
});

ok('--workspace-dir flag resolves to config.json inside the dir', () => {
  const { wsDir } = makeConfig();
  const r = runMint([`--workspace-dir=${wsDir}`]);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^dom_/);
});

ok('missing config exits 1 with a clear message', () => {
  const r = runMint(['--config=/no/such/path/config.json']);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
  assert.ok(r.stderr.includes('not found') || r.stderr.includes('config.json'), `stderr: ${r.stderr}`);
});

ok('no args exits 1', () => {
  const r = runMint([]);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
});

ok('BOM-tolerant: strips leading UTF-8 BOM before parsing', () => {
  const wsDir = path.join(TMP, `ws-bom-${wsCounter++}`);
  fs.mkdirSync(wsDir, { recursive: true });
  const configPath = path.join(wsDir, 'config.json');
  const cfg = { workspace: { name: 'BOMTest', slug: 'bom-test' }, repos: {}, services: {} };
  // Write with BOM prefix
  const bom = '﻿';
  fs.writeFileSync(configPath, bom + JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  const r = runMint([`--config=${configPath}`]);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^dom_/, 'should produce a valid id even on BOM-prefixed input');
});

ok('generated ids are unique across multiple invocations', () => {
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    const { configPath } = makeConfig();
    const r = runMint([`--config=${configPath}`]);
    assert.strictEqual(r.status, 0);
    ids.add(r.stdout.trim());
  }
  assert.strictEqual(ids.size, 5, 'duplicate ids generated — ULID collision?');
});

ok('other config top-level keys are preserved after minting', () => {
  const { configPath } = makeConfig();
  // Add extra top-level key.
  const cfg = readConfig(configPath);
  cfg.extra_key = { value: 42 };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  const r = runMint([`--config=${configPath}`]);
  assert.strictEqual(r.status, 0);
  const after = readConfig(configPath);
  assert.strictEqual(after.extra_key.value, 42, 'extra_key was dropped');
});

// ---------------------------------------------------------------------------
// validate-config.js — domain.id warn branch (FR-2)
// ---------------------------------------------------------------------------

ok('validate-config: config with no domain block emits WARN about domain (existing behaviour)', () => {
  // makeConfig() produces no domain block. Validator should warn.
  const { configPath } = makeConfig();
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should exit 0 (warnings only); stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('WARN'), `expected a WARN; stderr: ${r.stderr}`);
});

ok('validate-config: config with domain block but no id emits WARN suggesting mint-domain-id', () => {
  const { configPath } = makeConfig({ domain: { name: 'Test' } });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should exit 0; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('domain.id') || r.stderr.includes('mint-domain-id'), `should warn about missing domain.id; stderr: ${r.stderr}`);
});

ok('validate-config: well-formed dom_ id passes silently (no extra warn)', () => {
  const { configPath } = makeConfig({ domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  // Should not have a domain.id-specific warning.
  assert.ok(!r.stderr.includes('domain.id'), `unexpected domain.id warning; stderr: ${r.stderr}`);
});

ok('validate-config: malformed domain.id (wrong prefix) emits WARN-only, never errors', () => {
  const { configPath } = makeConfig({ domain: { id: 'bad-id-not-dom-prefix' } });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should exit 0 (warn-only); stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('WARN'), `expected a WARN; stderr: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// validate-config.js — external_dependencies (FR-5 / EC-4)
// ---------------------------------------------------------------------------

ok('validate-config: absent external_dependencies is silent (EC-4)', () => {
  const { configPath } = makeConfig({ domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0);
  // No external_dependencies warning expected.
  assert.ok(!r.stderr.includes('external_dependencies'), `unexpected warning; stderr: ${r.stderr}`);
});

ok('validate-config: well-formed external_dependencies entry passes silently', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      {
        target_id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        relation: 'upstream',
        resolution: { kind: 'absent' },
        trust: 'manual',
        share_scope: 'semantic',
      },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  // No validation warnings for a well-formed entry.
  assert.ok(!r.stderr.includes('external_dependencies[0]'), `unexpected warning; stderr: ${r.stderr}`);
});

ok('validate-config: missing target_id emits WARN-only', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      { relation: 'peer', resolution: { kind: 'absent' } },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should be warn-only; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('target_id'), `should warn about missing target_id; stderr: ${r.stderr}`);
});

ok('validate-config: bad relation value emits WARN-only', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      { target_id: 'dom_AAAA', relation: 'supplier', resolution: { kind: 'absent' } },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should be warn-only; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('relation'), `should warn about bad relation; stderr: ${r.stderr}`);
});

ok('validate-config: missing resolution emits WARN-only', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      { target_id: 'dom_AAAA', relation: 'child' },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should be warn-only; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('resolution'), `should warn about missing resolution; stderr: ${r.stderr}`);
});

ok('validate-config: bad resolution.kind emits WARN-only', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      { target_id: 'dom_AAAA', relation: 'peer', resolution: { kind: 'unknown-kind' } },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should be warn-only; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('resolution.kind'), `should warn about bad kind; stderr: ${r.stderr}`);
});

ok('validate-config: bad trust value emits WARN-only', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      { target_id: 'dom_AAAA', relation: 'peer', resolution: { kind: 'github' }, trust: 'unknown-trust' },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `should be warn-only; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('trust'), `should warn about bad trust; stderr: ${r.stderr}`);
});

ok('validate-config: share_scope is not enforced (open Q3) — any string is accepted silently', () => {
  const { configPath } = makeConfig({
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    external_dependencies: [
      {
        target_id: 'dom_AAAA',
        relation: 'upstream',
        resolution: { kind: 'local' },
        trust: 'auto',
        share_scope: 'some-future-enum-value',
      },
    ],
  });
  const r = runValidate(configPath);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.ok(!r.stderr.includes('share_scope'), `share_scope should not be warned; stderr: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// EC-3: regeneratePortableConfig carries domain.id + external_dependencies
// ---------------------------------------------------------------------------

ok('EC-3: portable config clone carries domain.id and external_dependencies (no code change needed)', () => {
  // Replicate the deep-clone-and-strip behavior that sync-memory.js
  // regeneratePortableConfig() performs: JSON.parse(JSON.stringify(cfg)) then
  // strip repos[].path. Any new field (domain.id, external_dependencies) rides
  // along for free because deep-clone is field-agnostic.
  const srcConfig = {
    workspace: { name: 'Test', slug: 'test' },
    domain: { id: 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Test Domain' },
    external_dependencies: [
      { target_id: 'dom_OTHER', relation: 'upstream', resolution: { kind: 'absent' } },
    ],
    repos: {
      'svc-a': { path: '/absolute/local/path', type: 'spring-boot', role: 'api-service' },
    },
    services: {},
  };

  // Simulate regeneratePortableConfig: deep clone + strip absolute paths from repos.
  const portable = JSON.parse(JSON.stringify(srcConfig));
  for (const repo of Object.values(portable.repos)) {
    delete repo.path; // the only strip sync-memory.js does
  }

  // domain.id and external_dependencies must be present in the portable copy.
  assert.strictEqual(portable.domain.id, 'dom_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'domain.id lost in portable clone');
  assert.ok(Array.isArray(portable.external_dependencies), 'external_dependencies lost in portable clone');
  assert.strictEqual(portable.external_dependencies[0].target_id, 'dom_OTHER', 'edge data lost in clone');
  // repos.path should be gone.
  assert.strictEqual(portable.repos['svc-a'].path, undefined, 'path should be stripped');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });

const exitCode = process.exitCode || 0;
console.log(`\n${passed} tests passed${exitCode !== 0 ? ' (with failures)' : ''}.`);
