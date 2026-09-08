#!/usr/bin/env node
/**
 * Unit tests for workspace-registry.js.
 * Zero deps: run with `node workspace-registry.test.js`.
 *
 * Spawns the CLI as a subprocess with PIPECREW_CONFIG_FILE pointed at a temp
 * file, so the user's real ~/.claude/pipecrew/config.json is never touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'workspace-registry.js');
const ROOTSHIM = path.join(__dirname, 'workspace-root.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-registry-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

let counter = 0;
function fresh() { // isolated config file + returns its path
  const cfgPath = path.join(TMP, `cfg-${counter++}.json`);
  return cfgPath;
}
// Materialize a workspace dir: <root>/<slug>/config.json with a workspace block.
function makeWorkspace(root, slug) {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ workspace: { name: slug, slug }, repos: {}, services: {} }, null, 2));
  return dir.replace(/\\/g, '/');
}
function run(cfgPath, args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PIPECREW_CONFIG_FILE: cfgPath, PIPECREW_WORKSPACE_ROOT: '', ...extraEnv },
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function runRoot(cfgPath, args, extraEnv = {}) {
  const r = spawnSync('node', [ROOTSHIM, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PIPECREW_CONFIG_FILE: cfgPath, PIPECREW_WORKSPACE_ROOT: '', ...extraEnv },
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

console.log('\nworkspace-registry tests\n');

test('register + resolve by slug returns the exact path (workspace lives anywhere)', () => {
  const cfg = fresh();
  const a = makeWorkspace(path.join(TMP, 'placeA'), 'alpha');
  const b = makeWorkspace(path.join(TMP, 'placeB'), 'beta'); // different parent!
  run(cfg, [`--register=${a}`]);
  run(cfg, [`--register=${b}`, '--current']);
  eq(run(cfg, ['--resolve', '--workspace=alpha']).out, a, 'alpha path');
  eq(run(cfg, ['--resolve', '--workspace=beta']).out, b, 'beta path');
});

test('resolve with no flag uses current', () => {
  const cfg = fresh();
  const a = makeWorkspace(path.join(TMP, 'cur1'), 'one');
  const b = makeWorkspace(path.join(TMP, 'cur2'), 'two');
  run(cfg, [`--register=${a}`]);
  run(cfg, [`--register=${b}`, '--current']);
  eq(run(cfg, ['--resolve']).out, b, 'current is two');
  run(cfg, ['--set-current=one']);
  eq(run(cfg, ['--resolve']).out, a, 'current switched to one');
});

test('resolve is ambiguous (exit 3) when multiple and no current/slug', () => {
  const cfg = fresh();
  run(cfg, [`--register=${makeWorkspace(path.join(TMP, 'ambA'), 'a1')}`]);
  run(cfg, [`--register=${makeWorkspace(path.join(TMP, 'ambB'), 'a2')}`]);
  const r = run(cfg, ['--resolve']);
  eq(r.code, 3, 'exit 3 on ambiguity');
  assert(r.err.includes('a1') && r.err.includes('a2'), 'lists candidates');
});

test('sole registered workspace resolves without current', () => {
  const cfg = fresh();
  const a = makeWorkspace(path.join(TMP, 'solo'), 'only');
  run(cfg, [`--register=${a}`]);
  eq(run(cfg, ['--resolve']).out, a, 'sole resolves');
});

test('legacy migration: workspace_root string is scanned + registered on first read', () => {
  const cfg = fresh();
  const root = path.join(TMP, 'legacyRoot');
  makeWorkspace(root, 'legacy-a');
  makeWorkspace(root, 'legacy-b');
  fs.writeFileSync(cfg, JSON.stringify({ workspace_root: root.replace(/\\/g, '/') }));
  const r = run(cfg, ['--list', '--json']);
  const parsed = JSON.parse(r.out);
  const slugs = parsed.workspaces.map((w) => w.slug).sort();
  assert(slugs.includes('legacy-a') && slugs.includes('legacy-b'), `migrated slugs: ${slugs}`);
  eq(parsed.default_root, root.replace(/\\/g, '/'), 'legacy root kept as default_root');
  // Idempotent: config now has workspaces[] and a second read does not duplicate.
  const r2 = JSON.parse(run(cfg, ['--list', '--json']).out);
  eq(r2.workspaces.length, 2, 'no duplication on second read');
});

test('adopt scans a dir and registers workspaces found there', () => {
  const cfg = fresh();
  run(cfg, [`--register=${makeWorkspace(path.join(TMP, 'homeRoot'), 'home-ws')}`, '--current']);
  const other = path.join(TMP, 'otherRoot');
  makeWorkspace(other, 'adopted-1');
  makeWorkspace(other, 'adopted-2');
  run(cfg, [`--adopt=${other.replace(/\\/g, '/')}`]);
  const slugs = JSON.parse(run(cfg, ['--list', '--json']).out).workspaces.map((w) => w.slug).sort();
  assert(['adopted-1', 'adopted-2', 'home-ws'].every((s) => slugs.includes(s)), `after adopt: ${slugs}`);
});

test('forget removes from registry but leaves files (no orphaning of data)', () => {
  const cfg = fresh();
  const a = makeWorkspace(path.join(TMP, 'keepDir'), 'keep');
  run(cfg, [`--register=${a}`]);
  run(cfg, ['--forget=keep']);
  eq(JSON.parse(run(cfg, ['--list', '--json']).out).workspaces.length, 0, 'unregistered');
  assert(fs.existsSync(path.join(a, 'config.json')), 'files still on disk');
});

test('env override PIPECREW_WORKSPACE_ROOT resolves ephemerally without persisting', () => {
  const cfg = fresh();
  const envRoot = path.join(TMP, 'envRoot');
  const a = makeWorkspace(envRoot, 'env-ws');
  const r = run(cfg, ['--resolve'], { PIPECREW_WORKSPACE_ROOT: envRoot.replace(/\\/g, '/') });
  eq(r.out, a, 'env root scanned + resolved');
  assert(!fs.existsSync(cfg), 'env resolve did not persist a config file');
});

test('re-register updates path without duplicating the slug', () => {
  const cfg = fresh();
  const a1 = makeWorkspace(path.join(TMP, 'moveFrom'), 'mover');
  run(cfg, [`--register=${a1}`]);
  const a2 = makeWorkspace(path.join(TMP, 'moveTo'), 'mover'); // same slug, new path
  run(cfg, [`--register=${a2}`]);
  const ws = JSON.parse(run(cfg, ['--list', '--json']).out).workspaces;
  eq(ws.length, 1, 'no duplicate slug');
  eq(ws[0].path, a2, 'path updated to new location');
});

// ---- backward-compat shim ----

test('workspace-root.js --get returns the PARENT of the current workspace', () => {
  const cfg = fresh();
  const a = makeWorkspace(path.join(TMP, 'shimRoot'), 'shim-ws');
  run(cfg, [`--register=${a}`, '--current']);
  eq(runRoot(cfg, ['--get']).out, path.join(TMP, 'shimRoot').replace(/\\/g, '/'), '--get is parent of current');
});

test('workspace-root.js --check exits 0 when a workspace is registered, 2 when empty', () => {
  const cfg = fresh();
  eq(runRoot(cfg, ['--check']).code, 2, 'empty -> exit 2');
  run(cfg, [`--register=${makeWorkspace(path.join(TMP, 'chk'), 'chk-ws')}`, '--current']);
  eq(runRoot(cfg, ['--check']).code, 0, 'registered -> exit 0');
});

test('workspace-root.js --set adopts existing workspaces under the root', () => {
  const cfg = fresh();
  const root = path.join(TMP, 'setRoot');
  makeWorkspace(root, 'set-a');
  makeWorkspace(root, 'set-b');
  runRoot(cfg, [`--set=${root.replace(/\\/g, '/')}`]);
  const slugs = JSON.parse(run(cfg, ['--list', '--json']).out).workspaces.map((w) => w.slug).sort();
  assert(slugs.includes('set-a') && slugs.includes('set-b'), `adopted via --set: ${slugs}`);
});

// ---- cleanup ----
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 0 + failed : 0);
