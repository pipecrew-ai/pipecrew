#!/usr/bin/env node
/**
 * Unit test for workspace-root.js — harness-aware path resolution.
 *
 * Runs the CLI as a subprocess with PIPECREW_HARNESS overrides (the module
 * freezes the detected harness at load, so a subprocess per harness is the
 * honest way to exercise both). Verifies that Cursor routes runtime state to
 * ~/.cursor and Claude to ~/.claude, and that an unknown install location
 * falls back to claude (preserving legacy behavior).
 */

const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'workspace-root.js');
const HOME = os.homedir();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Run the CLI with a controlled environment. Always strip Cursor env hints so
// they can't leak in from the machine running the test.
function run(arg, harness) {
  const env = { ...process.env };
  delete env.PIPECREW_HARNESS;
  delete env.CURSOR_PROJECT_DIR;
  delete env.CURSOR_VERSION;
  delete env.PIPECREW_WORKSPACE_ROOT;
  if (harness) env.PIPECREW_HARNESS = harness;
  const r = spawnSync('node', [SCRIPT, arg], { encoding: 'utf8', env });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Normalize backslashes so assertions are platform-agnostic.
const norm = (p) => p.replace(/\\/g, '/');
const homeN = norm(HOME);

test('--harness reports cursor / claude from the override', () => {
  assert(run('--harness', 'cursor').out === 'cursor', 'PIPECREW_HARNESS=cursor should report cursor');
  assert(run('--harness', 'claude').out === 'claude', 'PIPECREW_HARNESS=claude should report claude');
});

test('unknown install location falls back to claude', () => {
  // No override, no Cursor env, and __dirname (the repo checkout) is under
  // neither .cursor nor .claude → must default to claude.
  assert(run('--harness', null).out === 'claude', 'should fall back to claude');
});

test('--agents-dir is harness-specific', () => {
  assert(norm(run('--agents-dir', 'cursor').out) === `${homeN}/.cursor/agents`,
    `cursor agents dir wrong: ${run('--agents-dir', 'cursor').out}`);
  assert(norm(run('--agents-dir', 'claude').out) === `${homeN}/.claude/agents`,
    `claude agents dir wrong: ${run('--agents-dir', 'claude').out}`);
});

test('--default workspace root is harness-specific', () => {
  assert(norm(run('--default', 'cursor').out) === `${homeN}/.cursor/pipecrew/workspaces`,
    `cursor default wrong: ${run('--default', 'cursor').out}`);
  assert(norm(run('--default', 'claude').out) === `${homeN}/.claude/pipecrew/workspaces`,
    `claude default wrong: ${run('--default', 'claude').out}`);
});

test('--config-path is harness-specific', () => {
  assert(norm(run('--config-path', 'cursor').out) === `${homeN}/.cursor/pipecrew/config.json`,
    `cursor config path wrong: ${run('--config-path', 'cursor').out}`);
  assert(norm(run('--config-path', 'claude').out) === `${homeN}/.claude/pipecrew/config.json`,
    `claude config path wrong: ${run('--config-path', 'claude').out}`);
});

test('--context-filename is AGENTS.md on every harness (canonical)', () => {
  assert(run('--context-filename', 'cursor').out === 'AGENTS.md', 'cursor should be AGENTS.md');
  assert(run('--context-filename', 'claude').out === 'AGENTS.md', 'claude should be AGENTS.md');
});

test('--context-shim is CLAUDE.md under Claude, empty otherwise', () => {
  assert(run('--context-shim', 'claude').out === 'CLAUDE.md', 'claude shim should be CLAUDE.md');
  assert(run('--context-shim', 'cursor').out === '', `cursor should emit no shim, got '${run('--context-shim', 'cursor').out}'`);
});

test('claude paths are unchanged from the legacy layout (no regression)', () => {
  // The exact strings existing Claude Code users depend on.
  assert(norm(run('--default', 'claude').out) === `${homeN}/.claude/pipecrew/workspaces`);
  assert(norm(run('--config-path', 'claude').out) === `${homeN}/.claude/pipecrew/config.json`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
