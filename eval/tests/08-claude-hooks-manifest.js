#!/usr/bin/env node
/**
 * Layer 1 — the Claude Code hooks are actually wired up.
 *
 * The hooks file lives at .claude-plugin/hooks/hooks.json — deliberately NOT
 * at the repo root, where Cursor auto-discovers hooks.json in its own
 * incompatible format. Claude Code ALSO only auto-discovers the top-level
 * path, so the file loads solely via plugin.json's "hooks" field. That field
 * is load-bearing: without it every hook silently never fires — which is
 * exactly what happened from v1.1.0 through v1.16.0.
 *
 * Pins: (1) plugin.json "hooks" points at an existing file; (2) it parses and
 * wraps events in a top-level "hooks" key; (3) every hook command's script
 * exists; (4) no hooks/hooks.json at the repo root (Cursor collision guard).
 */

const LAYER = 1;
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
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

function resolveHooksFile() {
  const claude = readJson(CLAUDE_PLUGIN);
  assert(typeof claude.hooks === 'string' && claude.hooks.length > 0,
    'plugin.json must declare a "hooks" path — Claude Code does not auto-discover ' +
    '.claude-plugin/hooks/hooks.json, so without this field no hook ever fires');
  return path.resolve(PLUGIN_ROOT, claude.hooks);
}

test('plugin.json "hooks" field points at an existing hooks file', () => {
  const hooksPath = resolveHooksFile();
  assert(fs.existsSync(hooksPath),
    `plugin.json "hooks" points at a missing file: ${path.relative(PLUGIN_ROOT, hooksPath)}`);
});

test('hooks file parses and wraps events in a top-level "hooks" key', () => {
  const j = readJson(resolveHooksFile());
  assert(j.hooks && typeof j.hooks === 'object' && !Array.isArray(j.hooks),
    'standalone hooks file must nest the event map under a top-level "hooks" key');
  assert(Object.keys(j.hooks).length > 0, 'hooks event map must not be empty');
});

test('every hook command script exists under scripts/', () => {
  const j = readJson(resolveHooksFile());
  const missing = [];
  for (const matchers of Object.values(j.hooks)) {
    for (const m of matchers) {
      for (const h of m.hooks || []) {
        const ref = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.js)/.exec(h.command || '');
        if (ref && !fs.existsSync(path.join(PLUGIN_ROOT, ref[1]))) missing.push(ref[1]);
      }
    }
  }
  assert(missing.length === 0, `hook commands reference missing scripts: ${missing.join(', ')}`);
});

test('no hooks/hooks.json at repo root (reserved for a future Cursor port)', () => {
  assert(!fs.existsSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')),
    'a top-level hooks/hooks.json would be auto-discovered by Cursor in an ' +
    'incompatible format — keep Claude hooks in .claude-plugin/ behind the plugin.json "hooks" field');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
