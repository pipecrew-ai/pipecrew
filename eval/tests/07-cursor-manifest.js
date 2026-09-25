#!/usr/bin/env node
/**
 * Layer 1 — the Cursor plugin manifests are well-formed and stay in lockstep
 * with the Claude Code manifest.
 *
 * PipeCrew ships to BOTH Claude Code (.claude-plugin/) and Cursor
 * (.cursor-plugin/) from one repo. Cursor auto-discovers the shared root-level
 * skills/ and agents/ dirs, so the Cursor manifest is intentionally thin — but
 * two things must hold or users silently drift:
 *
 *   1. Both manifests must parse and carry the same kebab-case plugin name.
 *   2. The version MUST match .claude-plugin/plugin.json. The release ritual
 *      (CLAUDE.md) bumps the Claude plugin.json version; this test guarantees
 *      the Cursor manifest was bumped with it, so a release reaches both
 *      ecosystems instead of leaving Cursor users behind.
 *
 * Also asserts the auto-discovered component dirs (skills/, agents/) actually
 * exist at the repo root, since the thin manifest relies on that discovery.
 */

const LAYER = 1;
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CURSOR_PLUGIN = path.join(PLUGIN_ROOT, '.cursor-plugin', 'plugin.json');
const CURSOR_MARKET = path.join(PLUGIN_ROOT, '.cursor-plugin', 'marketplace.json');
const CLAUDE_PLUGIN = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function readJson(p) {
  assert(fs.existsSync(p), `missing file: ${path.relative(PLUGIN_ROOT, p)}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`JSON.parse failed for ${path.relative(PLUGIN_ROOT, p)}: ${e.message}`); }
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test('.cursor-plugin/plugin.json is well-formed', () => {
  const j = readJson(CURSOR_PLUGIN);
  assert(KEBAB.test(j.name), `name must be kebab-case (got ${JSON.stringify(j.name)})`);
  assert(typeof j.description === 'string' && j.description.length > 0, 'description must be non-empty string');
  assert(SEMVER.test(j.version || ''), `version must be semver X.Y.Z (got ${JSON.stringify(j.version)})`);
});

test('.cursor-plugin/marketplace.json is well-formed', () => {
  const j = readJson(CURSOR_MARKET);
  assert(KEBAB.test(j.name), `name must be kebab-case (got ${JSON.stringify(j.name)})`);
  assert(j.owner && typeof j.owner.name === 'string', 'owner.name must be a string');
  assert(Array.isArray(j.plugins) && j.plugins.length > 0, 'plugins must be a non-empty array');
  for (const p of j.plugins) {
    assert(KEBAB.test(p.name || ''), `plugins[].name must be kebab-case (got ${JSON.stringify(p.name)})`);
    assert(typeof p.description === 'string' && p.description.length > 0, 'plugins[].description must be non-empty string');
  }
});

test('Cursor and Claude plugin names agree', () => {
  const cursor = readJson(CURSOR_PLUGIN);
  const claude = readJson(CLAUDE_PLUGIN);
  assert(cursor.name === claude.name,
    `name mismatch: .cursor-plugin=${cursor.name} vs .claude-plugin=${claude.name}`);
});

test('Cursor version is in lockstep with Claude version', () => {
  const cursor = readJson(CURSOR_PLUGIN);
  const claude = readJson(CLAUDE_PLUGIN);
  assert(cursor.version === claude.version,
    `version drift: .cursor-plugin=${cursor.version} vs .claude-plugin=${claude.version}. ` +
    `Bump both together (see CLAUDE.md "Releasing").`);
});

test('auto-discovered component dirs exist at repo root', () => {
  for (const dir of ['skills', 'agents']) {
    assert(fs.existsSync(path.join(PLUGIN_ROOT, dir)),
      `Cursor auto-discovery expects ${dir}/ at repo root`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
