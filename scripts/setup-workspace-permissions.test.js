#!/usr/bin/env node
/**
 * Unit tests for setup-workspace-permissions.js.
 * Zero deps: run with `node setup-workspace-permissions.test.js`.
 *
 * Locks in the contract:
 *   - writes a .claude/settings.local.json at each repo PARENT dir (not the repo, not
 *     the workspace dir) so it loads when claude is launched from any repo/worktree.
 *   - grants additionalDirectories = repo parents + workspace dir.
 *   - the allow-list is safe-only (never lists git push / rm / deploys).
 *   - MERGES into an existing file (union, order-stable) and never clobbers.
 *   - --dry-run writes nothing.
 *   - an unparseable existing file is left untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'setup-workspace-permissions.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-perms-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;
// Build a workspace skeleton: {root}/repos/{repoA,repoB} + {root}/workspaces/{slug}/config.json
function makeWorkspace(repoNames = ['repoA', 'repoB']) {
  const root = path.join(TMP, `w-${counter++}`);
  const reposParent = path.join(root, 'repos');
  const wsDir = path.join(root, 'workspaces', 'demo');
  fs.mkdirSync(reposParent, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const repos = {};
  for (const n of repoNames) {
    const rp = path.join(reposParent, n);
    fs.mkdirSync(rp, { recursive: true });
    repos[n] = { path: rp.replace(/\\/g, '/'), type: 'spring-boot', role: 'api-service' };
  }
  const configPath = path.join(wsDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ workspace: { slug: 'demo' }, repos }, null, 2));
  return { root, reposParent: reposParent.replace(/\\/g, '/'), wsDir: wsDir.replace(/\\/g, '/'), configPath };
}

function run(configPath, extra = []) {
  return spawnSync('node', [SCRIPT, `--config=${configPath}`, ...extra], { encoding: 'utf8' });
}
function readSettings(parentDir) {
  return JSON.parse(fs.readFileSync(path.join(parentDir, '.claude', 'settings.local.json'), 'utf8'));
}

test('writes one settings file at the shared repo parent', () => {
  const ws = makeWorkspace();
  const r = run(ws.configPath);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const s = readSettings(ws.reposParent);
  assert(s.permissions, 'permissions missing');
  assert(Array.isArray(s.permissions.allow), 'allow missing');
});

test('additionalDirectories includes the repo parent and the workspace dir', () => {
  const ws = makeWorkspace();
  run(ws.configPath);
  const dirs = readSettings(ws.reposParent).permissions.additionalDirectories;
  assert(dirs.includes(ws.reposParent), `missing repo parent: ${dirs}`);
  assert(dirs.includes(ws.wsDir), `missing workspace dir: ${dirs}`);
});

test('allow-list is safe-only: includes Edit + git commit, excludes push/rm/deploy', () => {
  const ws = makeWorkspace();
  run(ws.configPath);
  const allow = readSettings(ws.reposParent).permissions.allow;
  assert(allow.includes('Edit'), 'Edit not allowed');
  assert(allow.some((a) => a.includes('git commit')), 'git commit not allowed');
  const joined = allow.join('\n');
  assert(!/git push/.test(joined), 'git push must NOT be allowed');
  assert(!/reset --hard/.test(joined), 'reset --hard must NOT be allowed');
  assert(!/\brm\b/.test(joined), 'rm must NOT be allowed');
  assert(!/cdk deploy|terraform apply|docker push/.test(joined), 'deploys must NOT be allowed');
});

test('merges into an existing file without clobbering, union is order-stable', () => {
  const ws = makeWorkspace();
  const claudeDir = path.join(ws.reposParent, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const custom = 'Bash(my-custom-tool:*)';
  fs.writeFileSync(path.join(claudeDir, 'settings.local.json'),
    JSON.stringify({ permissions: { allow: [custom] }, _mine: true }, null, 2));

  const r = run(ws.configPath);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const s = readSettings(ws.reposParent);
  assert(s._mine === true, 'pre-existing top-level key dropped');
  assert(s.permissions.allow[0] === custom, 'existing allow entry not preserved first');
  assert(s.permissions.allow.includes('Edit'), 'new entry not appended');
});

test('idempotent: a second run adds nothing', () => {
  const ws = makeWorkspace();
  run(ws.configPath);
  const first = fs.readFileSync(path.join(ws.reposParent, '.claude', 'settings.local.json'), 'utf8');
  run(ws.configPath);
  const second = fs.readFileSync(path.join(ws.reposParent, '.claude', 'settings.local.json'), 'utf8');
  assert(first === second, 'second run changed the file');
});

test('--dry-run writes nothing', () => {
  const ws = makeWorkspace();
  const r = run(ws.configPath, ['--dry-run']);
  assert(r.status === 0, `exit ${r.status}`);
  assert(!fs.existsSync(path.join(ws.reposParent, '.claude', 'settings.local.json')), 'dry-run wrote a file');
  assert(/dry-run/.test(r.stdout), 'dry-run not reflected in output');
});

test('unparseable existing file is left untouched', () => {
  const ws = makeWorkspace();
  const claudeDir = path.join(ws.reposParent, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.local.json');
  fs.writeFileSync(file, '{ not valid json ');
  const r = run(ws.configPath);
  assert(r.status === 0, `exit ${r.status}`);
  assert(fs.readFileSync(file, 'utf8') === '{ not valid json ', 'clobbered an unparseable file');
  assert(/not valid JSON/.test(r.stdout), 'did not report the skip');
});

test('repos under different parents each get a file', () => {
  const root = path.join(TMP, `multi-${counter++}`);
  const pA = path.join(root, 'group-a');
  const pB = path.join(root, 'group-b');
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(path.join(pA, 'svc1'), { recursive: true });
  fs.mkdirSync(path.join(pB, 'svc2'), { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  const repos = {
    svc1: { path: path.join(pA, 'svc1').replace(/\\/g, '/') },
    svc2: { path: path.join(pB, 'svc2').replace(/\\/g, '/') },
  };
  const configPath = path.join(wsDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ repos }, null, 2));
  const r = run(configPath);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(fs.existsSync(path.join(pA, '.claude', 'settings.local.json')), 'group-a file missing');
  assert(fs.existsSync(path.join(pB, '.claude', 'settings.local.json')), 'group-b file missing');
});

test('missing --config exits 1', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 1, `expected exit 1, got ${r.status}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
