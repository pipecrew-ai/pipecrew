#!/usr/bin/env node
/**
 * Unit tests for discover-cache.js.
 * Zero deps: run with `node discover-cache.test.js`.
 *
 * Locks in every cache-invalidation rule + the plan/commit round-trip.
 * Uses real ephemeral git repos in os.tmpdir() so the script's `git rev-parse`
 * calls hit a real binary — no git stubbing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'discover-cache.js');
const EXAMPLE = path.join(__dirname, '..', 'templates', 'blocks', 'repo-profile.example.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-cache-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}\n${e.stack ? e.stack.split('\n').slice(1, 4).join('\n') : ''}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// --- fixtures --------------------------------------------------------------

let repoCounter = 0;
function makeRepo(initialBranch = 'main') {
  const repo = fs.mkdtempSync(path.join(TMP, `repo${repoCounter++}-`));
  execFileSync('git', ['init', '-q', '-b', initialBranch], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}
function repoHead(repoPath) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
}
function repoBranch(repoPath) {
  return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
}
function makeProfile(repoKey, schemaVersion = 1) {
  const profilePath = path.join(TMP, `${repoKey}-${repoCounter++}.json`);
  fs.writeFileSync(profilePath, JSON.stringify({
    schema_version: schemaVersion,
    repo_key: repoKey,
    type: 'spring-boot',
    role: 'api-service',
    description: 'fixture',
  }, null, 2));
  return profilePath;
}
function makeStateFile() {
  return path.join(TMP, `state-${repoCounter++}.json`);
}
function runPlan(stateFile, repos) {
  return spawnSync('node', [SCRIPT, 'plan', stateFile, EXAMPLE, JSON.stringify(repos)], { encoding: 'utf8' });
}
function runCommit(stateFile, records) {
  return spawnSync('node', [SCRIPT, 'commit', stateFile, EXAMPLE, JSON.stringify(records)], { encoding: 'utf8' });
}
function parseOk(r) {
  if (r.status !== 0) throw new Error(`exit ${r.status}, stderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// --- read schema version from canonical example to know "current" ----------
const EXAMPLE_VER = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')).schema_version;
assert(Number.isInteger(EXAMPLE_VER), 'repo-profile.example.json must have integer schema_version');

// --- plan: cold cache ------------------------------------------------------

test('plan: no state file → every repo rescans with reason "no cache entry"', () => {
  const repo = makeRepo();
  const r = parseOk(runPlan(makeStateFile(), [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions.length === 1, 'one decision');
  assert(r.decisions[0].action === 'rescan', `got ${r.decisions[0].action}`);
  assert(/no cache entry/.test(r.decisions[0].reason), r.decisions[0].reason);
  assert(r.stats.reused === 0 && r.stats.rescanned === 1, JSON.stringify(r.stats));
});

test('plan: empty state file (zero-length) → all rescan', () => {
  const repo = makeRepo();
  const state = makeStateFile();
  fs.writeFileSync(state, '');
  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `got ${r.decisions[0].action}`);
});

test('plan: corrupt state file → all rescan + warning on stderr', () => {
  const repo = makeRepo();
  const state = makeStateFile();
  fs.writeFileSync(state, '{ not json');
  const raw = runPlan(state, [{ repo_key: 'foo', repo_path: repo }]);
  assert(raw.status === 0, `expected 0, got ${raw.status}`);
  assert(/not valid JSON/.test(raw.stderr), `expected warning, got: ${raw.stderr}`);
  const r = JSON.parse(raw.stdout);
  assert(r.decisions[0].action === 'rescan', 'corrupt cache must rescan');
});

// --- plan: cache hit path --------------------------------------------------

test('plan: matching cache → reuse with profile_path + reason', () => {
  const repo = makeRepo();
  const profile = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));

  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'reuse', `expected reuse, got ${r.decisions[0].action}: ${r.decisions[0].reason}`);
  assert(r.decisions[0].profile_path === profile, `wrong profile_path: ${r.decisions[0].profile_path}`);
  assert(/HEAD .* unchanged/.test(r.decisions[0].reason), r.decisions[0].reason);
  assert(r.stats.reused === 1 && r.stats.rescanned === 0, JSON.stringify(r.stats));
});

// --- plan: invalidation rules ----------------------------------------------

test('plan: HEAD moved → rescan with old → new SHA in reason', () => {
  const repo = makeRepo();
  const profile = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));

  // Make a new commit so HEAD moves
  fs.writeFileSync(path.join(repo, 'NEW.md'), 'after\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: repo });

  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `expected rescan, got: ${r.decisions[0].action}`);
  assert(/HEAD moved/.test(r.decisions[0].reason), r.decisions[0].reason);
});

test('plan: branch changed → rescan', () => {
  const repo = makeRepo('main');
  const profile = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));

  // Switch to a new branch at the same SHA — HEAD SHA matches, branch differs
  execFileSync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: repo });

  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `expected rescan, got: ${r.decisions[0].action}`);
  assert(/branch changed/.test(r.decisions[0].reason), r.decisions[0].reason);
});

test('plan: cached profile_schema_version drift → rescan', () => {
  const repo = makeRepo();
  const profile = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));

  // Mutate state.json to claim an older schema_version
  const obj = JSON.parse(fs.readFileSync(state, 'utf8'));
  obj.repos.foo.profile_schema_version = EXAMPLE_VER - 1;
  fs.writeFileSync(state, JSON.stringify(obj));

  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `expected rescan, got: ${r.decisions[0].action}`);
  assert(/schema version drifted/.test(r.decisions[0].reason), r.decisions[0].reason);
});

test('plan: cached profile file deleted → rescan', () => {
  const repo = makeRepo();
  const profile = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));

  fs.unlinkSync(profile);

  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `expected rescan, got: ${r.decisions[0].action}`);
  assert(/missing or unparseable/.test(r.decisions[0].reason), r.decisions[0].reason);
});

test('plan: cached profile file unparseable → rescan', () => {
  const repo = makeRepo();
  const profile = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));

  fs.writeFileSync(profile, '{ broken');

  const r = parseOk(runPlan(state, [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `expected rescan, got: ${r.decisions[0].action}`);
  assert(/missing or unparseable/.test(r.decisions[0].reason), r.decisions[0].reason);
});

test('plan: non-git repo path → rescan defensively (no crash)', () => {
  const repo = fs.mkdtempSync(path.join(TMP, 'not-a-git-'));
  // No git init — should NOT crash
  const r = parseOk(runPlan(makeStateFile(), [{ repo_key: 'foo', repo_path: repo }]));
  assert(r.decisions[0].action === 'rescan', `expected rescan, got: ${r.decisions[0].action}`);
  assert(/could not determine HEAD/.test(r.decisions[0].reason), r.decisions[0].reason);
});

// --- plan: mixed scenarios -------------------------------------------------

test('plan: mixed N repos with one moved, one stable → correct per-repo decisions + stats', () => {
  const stable = makeRepo();
  const moved = makeRepo();
  const stableProf = makeProfile('stable');
  const movedProf = makeProfile('moved');
  const state = makeStateFile();
  parseOk(runCommit(state, [
    { repo_key: 'stable', repo_path: stable, profile_path: stableProf },
    { repo_key: 'moved',  repo_path: moved,  profile_path: movedProf },
  ]));

  // Move the second repo's HEAD
  fs.writeFileSync(path.join(moved, 'NEW.md'), 'after\n');
  execFileSync('git', ['add', '.'], { cwd: moved });
  execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: moved });

  const r = parseOk(runPlan(state, [
    { repo_key: 'stable', repo_path: stable },
    { repo_key: 'moved',  repo_path: moved  },
  ]));
  const byKey = Object.fromEntries(r.decisions.map(d => [d.repo_key, d]));
  assert(byKey.stable.action === 'reuse', `stable should reuse, got ${byKey.stable.action}`);
  assert(byKey.moved.action === 'rescan', `moved should rescan, got ${byKey.moved.action}`);
  assert(r.stats.reused === 1 && r.stats.rescanned === 1, JSON.stringify(r.stats));
});

// --- commit ----------------------------------------------------------------

test('commit: writes state.json with the correct shape (atomically)', () => {
  const repo = makeRepo();
  const profile = makeProfile('foo');
  const state = makeStateFile();

  const r = parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: profile }]));
  assert(r.records_updated === 1, JSON.stringify(r));
  assert(fs.existsSync(state), 'state.json should exist');

  const obj = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert(obj.version === 1, `version: ${obj.version}`);
  assert(typeof obj.updated_at === 'string', 'updated_at missing');
  assert(obj.repos.foo, 'foo entry missing');
  assert(obj.repos.foo.head_sha === repoHead(repo), `head_sha wrong: ${obj.repos.foo.head_sha}`);
  assert(obj.repos.foo.branch === repoBranch(repo), `branch wrong: ${obj.repos.foo.branch}`);
  assert(obj.repos.foo.profile_path === profile, 'profile_path wrong');
  assert(obj.repos.foo.profile_schema_version === EXAMPLE_VER, `schema version wrong: ${obj.repos.foo.profile_schema_version}`);
  // No leftover temp file from atomic write
  assert(!fs.existsSync(state + '.tmp'), 'temp file should have been renamed');
});

test('commit: overwrites prior entry for same repo_key', () => {
  const repo = makeRepo();
  const prof1 = makeProfile('foo');
  const prof2 = makeProfile('foo');
  const state = makeStateFile();
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: prof1 }]));

  // Move HEAD then commit a new record
  fs.writeFileSync(path.join(repo, 'b.md'), 'b\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: repo });
  parseOk(runCommit(state, [{ repo_key: 'foo', repo_path: repo, profile_path: prof2 }]));

  const obj = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert(obj.repos.foo.profile_path === prof2, 'should have new profile_path');
  assert(obj.repos.foo.head_sha === repoHead(repo), 'should have new HEAD');
});

test('commit: preserves entries for repos NOT in the records list', () => {
  const repoA = makeRepo();
  const repoB = makeRepo();
  const profA = makeProfile('A');
  const profB = makeProfile('B');
  const state = makeStateFile();
  parseOk(runCommit(state, [
    { repo_key: 'A', repo_path: repoA, profile_path: profA },
    { repo_key: 'B', repo_path: repoB, profile_path: profB },
  ]));
  // Re-commit only A — B should survive
  parseOk(runCommit(state, [{ repo_key: 'A', repo_path: repoA, profile_path: profA }]));
  const obj = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert(obj.repos.A, 'A missing');
  assert(obj.repos.B, 'B missing — partial commit should not evict other repos');
  assert(obj.repos.B.profile_path === profB, 'B.profile_path stale');
});

test('commit: skips non-git repos with WARN (no crash)', () => {
  const notGit = fs.mkdtempSync(path.join(TMP, 'not-a-git-'));
  const profile = makeProfile('foo');
  const state = makeStateFile();
  const r = runCommit(state, [{ repo_key: 'foo', repo_path: notGit, profile_path: profile }]);
  assert(r.status === 0, `expected 0, got ${r.status}: ${r.stderr}`);
  assert(/WARN/.test(r.stderr), 'should warn on stderr');
  const out = JSON.parse(r.stdout);
  assert(out.records_updated === 0 && out.records_skipped === 1, JSON.stringify(out));
});

// --- usage errors ----------------------------------------------------------

test('no args → exit 1 (usage)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
  assert(/Usage:/.test(r.stderr), r.stderr);
});

test('plan: malformed <repos-json> → exit 1', () => {
  const repo = makeRepo();
  const r = spawnSync('node', [SCRIPT, 'plan', makeStateFile(), EXAMPLE, '{not json'], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

// ---------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
