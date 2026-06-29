#!/usr/bin/env node
/**
 * Sync a workspace's durable memory to its private GitHub repo.
 *
 * One repo per workspace: `{workspace_root}/{slug}/` is a git repo whose remote
 * is a PRIVATE GitHub repo, shared across the team so every machine reads the
 * same cross-repo knowledge. This script is the end-to-end sync called at the
 * learning checkpoints (/discover, /learn, /context-refresh, /deliver-if-changed):
 *
 *   1. redact   — run redact-secrets.js over the committed-tracked text so no
 *                 credential value ever reaches git history (MANDATORY).
 *   2. portable — regenerate config.portable.json from the local config.json
 *                 (absolute repo paths -> repos_root + dir) so the committed
 *                 config is machine-independent. The local config.json stays
 *                 absolute and is gitignored.
 *   3. rebase   — fetch + `pull --rebase origin <branch>` BEFORE publishing, so
 *                 a sibling machine's pushes don't get warn-dropped on a race.
 *   4. publish  — per sync_mode (commit | pr | hybrid):
 *                   commit → git add + commit + push to <branch> (main).
 *                   pr     → push a memory/<checkpoint> branch + `gh pr create`.
 *                   hybrid → pr when context/platform.md or context/adrs/** is
 *                            staged (structural canon), else commit.
 *                 A rebase conflict in any mode falls back to PR (a human
 *                 resolves it in GitHub) — we never auto-resolve canon.
 *
 * Also exposes read-only subcommands:
 *   node sync-memory.js pull <workspace-dir>            # pre-flight: fetch + rebase to the team's latest
 *   node sync-memory.js status <workspace-dir> [--json] # freshness / ahead-behind / unpushed (no mutation)
 *
 * SAFETY: never `git push --force`. Pull/push/auth failures WARN and leave the
 * commit local — they never throw (the caller skill must not fail because memory
 * sync couldn't reach GitHub). Enforcing a private remote is the caller's job at
 * bootstrap; this script assumes bootstrap already set it up.
 *
 * Usage:
 *   node sync-memory.js <workspace-dir> --message "learn: 3 updates" \
 *        [--sync-mode=commit|pr|hybrid] [--checkpoint=learn] [--no-push] [--dry-run]
 *   node sync-memory.js pull <workspace-dir>
 *
 * --sync-mode overrides config.workspace.memory.sync_mode (default: commit).
 * --checkpoint labels the PR branch (memory/<checkpoint>-<n>); default "sync".
 *
 * Exit codes:
 *   0 — synced / pulled (commit may be local if push/PR failed-but-warned)
 *   2 — usage / not-a-git-repo / redaction failed
 *
 * Zero deps — pure Node stdlib + git/gh on PATH (uses the user's existing auth).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);

// --- subcommand: pull (pre-flight read) ---
if (argv[0] === 'pull') {
  const dir = argv.find((a, i) => i > 0 && !a.startsWith('--'));
  process.exit(pullCmd(dir));
}

// --- subcommand: status (freshness / ahead-behind / unpushed) ---
if (argv[0] === 'status') {
  const dir = argv.find((a, i) => i > 0 && !a.startsWith('--'));
  process.exit(statusCmd(dir, argv.includes('--json')));
}

const wsDir = argv.find((a) => !a.startsWith('--'));
const message = flagVal('--message');
const checkpoint = flagVal('--checkpoint') || 'sync';
const syncModeFlag = flagVal('--sync-mode');
const NO_PUSH = argv.includes('--no-push');
const DRY = argv.includes('--dry-run');

function flagVal(name) {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

if (!wsDir || !message) {
  console.error('Usage: sync-memory.js <workspace-dir> --message "<commit msg>" [--sync-mode=commit|pr|hybrid] [--checkpoint=<label>] [--no-push] [--dry-run]');
  console.error('       sync-memory.js pull <workspace-dir>');
  process.exit(2);
}
if (!fs.existsSync(wsDir)) { console.error(`Workspace dir not found: ${wsDir}`); process.exit(2); }

function git(args, opts = {}) {
  return spawnSync('git', ['-C', wsDir, ...args], { encoding: 'utf8', ...opts });
}
function warn(m) { console.error(`sync-memory: WARN ${m}`); }

// --- 0. must be a git repo (bootstrap is the caller's responsibility) ---
if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
  console.error(`sync-memory: ${wsDir} is not a git repo — run the bootstrap step first (see docs/design/github-memory.md).`);
  process.exit(2);
}

// Resolve sync mode: --sync-mode flag > config.workspace.memory.sync_mode > "commit".
const syncMode = resolveSyncMode();

// --- 1. redact (MANDATORY) — never commit a credential value ---
const redactScript = path.join(__dirname, 'redact-secrets.js');
for (const sub of ['context', 'agents', 'history']) {
  const p = path.join(wsDir, sub);
  if (!fs.existsSync(p)) continue;
  const r = spawnSync('node', [redactScript, p, '--quiet'], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`sync-memory: redaction failed on ${sub}: ${r.stderr}`); process.exit(2); }
  if (r.stdout) process.stdout.write(r.stdout);
}

// --- 2. regenerate config.portable.json (machine-independent) ---
regeneratePortableConfig();

// `--show-current` returns the branch name even on an unborn branch (fresh
// `git init` before the first commit), where `rev-parse --abbrev-ref HEAD`
// would wrongly yield the literal "HEAD".
const branch = (git(['branch', '--show-current']).stdout || '').trim()
  || (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'main').trim();
const hasRemote = git(['remote']).stdout.trim().length > 0;

// --- 3. stage + commit (BEFORE any rebase — rebase refuses a dirty tree) ---
if (DRY) {
  const st = git(['status', '--short']);
  console.log(`sync-memory: --dry-run (mode=${syncMode}), would commit:\n` + (st.stdout || '(no changes)'));
  process.exit(0);
}
// Stage an explicit ALLOW-LIST of durable-doc paths only — never `git add -A`.
// A deny-list (.gitignore) can't anticipate arbitrary junk a user may drop in the
// workspace dir (e.g. a "copy of claude code session/" transcript dump), and such
// content would otherwise be committed UN-redacted (redaction only runs over
// context/agents/history). Allow-listing guarantees only known docs are published.
const ALLOW = ['context', 'agents', 'history', 'config.portable.json', '.gitignore'];
const toStage = ALLOW.filter((rel) => fs.existsSync(path.join(wsDir, rel)));
// `-A` scoped to each pathspec so deletions within the durable dirs are captured too.
if (toStage.length) git(['add', '-A', '--', ...toStage]);
const staged = git(['diff', '--cached', '--name-only']).stdout.trim();
if (!staged) { console.log('sync-memory: nothing changed — no commit'); process.exit(0); }

const c = git(['commit', '-m', message]);
if (c.status !== 0) { warn(`commit failed: ${c.stderr.trim()}`); process.exit(0); }
console.log(`sync-memory: committed — ${message}`);

if (NO_PUSH) { console.log('sync-memory: --no-push, leaving commit local'); process.exit(0); }
if (!hasRemote) { warn('no remote configured — commit left local (set a private remote at bootstrap)'); process.exit(0); }

// --- 4. rebase the fresh commit onto the team's latest (tree is clean now) ---
let rebaseConflict = false;
let remoteBranchExists = false;
git(['fetch', 'origin', branch]);
if (git(['rev-parse', '--verify', `origin/${branch}`]).status === 0) {
  remoteBranchExists = true;
  const rb = git(['rebase', `origin/${branch}`]);
  if (rb.status !== 0) {
    rebaseConflict = true;
    git(['rebase', '--abort']);
    warn(`rebase onto origin/${branch} hit a conflict — routing through a PR so a human resolves it in GitHub.`);
  }
}

// --- 5. decide publish path: explicit pr | hybrid-structural | rebase-conflict → PR; else commit ---
// First push (no origin/<branch> yet, e.g. bootstrap) MUST be a direct commit:
// it establishes the base branch, and you can't open a PR with no base.
const structural = stagedTouchesCanon(staged);
const usePR = remoteBranchExists && (syncMode === 'pr' || rebaseConflict || (syncMode === 'hybrid' && structural));

// --- 5a. PR path: park the commit on a memory/<checkpoint> branch, leave main == origin/main ---
if (usePR) {
  const why = rebaseConflict ? 'rebase-conflict' : (syncMode === 'pr' ? 'sync_mode=pr' : 'hybrid: structural canon changed');
  const safeCp = checkpoint.replace(/[^a-zA-Z0-9._-]/g, '-');
  const sha = (git(['rev-parse', '--short', 'HEAD']).stdout || 'wip').trim(); // suffix from the commit (no Date.now)
  const prBranch = `memory/${safeCp}-${sha}`;
  const co = git(['checkout', '-b', prBranch]);
  if (co.status !== 0) { warn(`could not create branch ${prBranch} (${co.stderr.trim()}) — commit is on ${branch} locally`); process.exit(0); }
  const pushB = git(['push', '-u', 'origin', prBranch]);
  if (pushB.status !== 0) {
    warn(`push of ${prBranch} failed (${pushB.stderr.trim()}) — branch is local; resolve auth and re-run`);
    git(['checkout', branch]);
    process.exit(0);
  }
  const gh = spawnSync('gh', ['pr', 'create', '--base', branch, '--head', prBranch,
    '--title', message, '--body', `Automated workspace-memory sync (${why}).\n\nReview the durable-doc changes, then merge. Other machines pick them up at their next run pre-flight (\`sync-memory.js pull\`).`],
    { cwd: wsDir, encoding: 'utf8' });
  if (gh.status !== 0) {
    warn(`branch ${prBranch} pushed, but \`gh pr create\` failed (${(gh.stderr || '').trim() || 'gh not available'}). Open the PR manually.`);
  } else {
    console.log(`sync-memory: opened PR from ${prBranch} → ${branch}${gh.stdout ? `\n${gh.stdout.trim()}` : ''}`);
  }
  // Keep local main identical to the remote so the next run starts from a clean,
  // shared base — the commit lives only on the pushed memory branch + the PR now.
  const restoreCo = git(['checkout', branch]);
  if (restoreCo.status !== 0) {
    warn(`could not restore to ${branch} after PR push — HEAD is still on ${prBranch}; run 'git checkout ${branch}' manually`);
    process.exit(0);
  }
  git(['reset', '--hard', `origin/${branch}`]);
  process.exit(0);
}

// --- 5b. direct-commit path ---
const p = git(['push', 'origin', branch]);
if (p.status !== 0) { warn(`push failed (${p.stderr.trim()}) — commit is local; resolve auth/divergence and re-run`); process.exit(0); }
console.log(`sync-memory: pushed ${branch} -> origin`);
process.exit(0);

// ===================== helpers =====================

function resolveSyncMode() {
  if (syncModeFlag && ['commit', 'pr', 'hybrid'].includes(syncModeFlag)) return syncModeFlag;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(wsDir, 'config.json'), 'utf8'));
    const m = cfg.workspace && cfg.workspace.memory && cfg.workspace.memory.sync_mode;
    if (['commit', 'pr', 'hybrid'].includes(m)) return m;
  } catch (_) { /* no/invalid config → default */ }
  return 'commit';
}

// Structural canon = the shared mental model + durable decisions. Editing these
// earns a PR review in hybrid mode; everything else (audit-findings, observability,
// learn-log, config.portable) is bookkeeping and commits directly.
function stagedTouchesCanon(stagedList) {
  return stagedList.split('\n').some((f) => {
    const n = f.replace(/\\/g, '/');
    return n === 'context/platform.md' || n.startsWith('context/adrs/');
  });
}

function regeneratePortableConfig() {
  const cfgPath = path.join(wsDir, 'config.json');
  const localPath = path.join(wsDir, 'config.local.json');
  if (!fs.existsSync(cfgPath)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
    const repos = cfg.repos || {};
    const paths = Object.values(repos).map((r) => r.path).filter(Boolean);
    const reposRoot = local.repos_root || longestCommonDir(paths);
    const portable = JSON.parse(JSON.stringify(cfg));
    portable._portable = true;
    portable._repos_root_note = 'Absolute paths stripped. On a fresh clone, run /discover --rehydrate to rebuild config.json by supplying repos_root locally (config.local.json).';
    portable.repos_root = reposRoot ? '${REPOS_ROOT}' : undefined;
    for (const [, r] of Object.entries(portable.repos || {})) {
      if (r.path) {
        r.dir = reposRoot && r.path.startsWith(reposRoot)
          ? r.path.slice(reposRoot.length).replace(/^[/\\]/, '')
          : path.basename(r.path);
        delete r.path;
      }
    }
    fs.writeFileSync(path.join(wsDir, 'config.portable.json'), JSON.stringify(portable, null, 2) + '\n');
  } catch (e) {
    warn(`could not regenerate config.portable.json (${e.message}) — committing without it`);
  }
}

function longestCommonDir(paths) {
  if (!paths.length) return null;
  const norm = paths.map((p) => p.replace(/\\/g, '/').split('/'));
  const first = norm[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!norm.every((segs) => segs[i] === first[i])) break;
  }
  // If all segments matched (single path or all identical), `i` landed on the
  // leaf segment itself — step up one so we return the *parent* directory.
  const depth = i >= first.length ? i - 1 : i;
  const common = first.slice(0, depth).join('/');
  return common && common.length > 1 ? common : null;
}

// `pull` subcommand: read the team's latest memory at run pre-flight. Warn-only —
// never blocks the run. Refuses if there are local uncommitted changes that a
// rebase could clobber (leaves them for the next sync to publish).
function pullCmd(dir) {
  if (!dir || !fs.existsSync(dir)) { console.error('Usage: sync-memory.js pull <workspace-dir>'); return 2; }
  const g = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (g(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    // Not a memory-backed workspace (feature off) — silent no-op.
    return 0;
  }
  if (g(['remote']).stdout.trim().length === 0) { return 0; }
  const br = (g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'main').trim();
  if (g(['fetch', 'origin', br]).status !== 0) {
    console.error('sync-memory: WARN pull-preflight fetch failed — using local memory copy');
    return 0;
  }
  if (g(['rev-parse', '--verify', `origin/${br}`]).status !== 0) return 0; // nothing remote yet
  const dirty = g(['status', '--porcelain']).stdout.trim().length > 0;
  if (dirty) {
    console.error('sync-memory: WARN local memory has uncommitted changes — skipping pre-flight pull (next sync will reconcile)');
    return 0;
  }
  const behindBefore = countRev(g, `HEAD..origin/${br}`);
  const r = g(['pull', '--rebase', 'origin', br]);
  if (r.status !== 0) {
    g(['rebase', '--abort']);
    console.error('sync-memory: WARN pre-flight pull --rebase failed — using local memory copy');
    return 0;
  }
  const fresh = lastChange(g, br);
  const behindNote = behindBefore > 0 ? `, you were ${behindBefore} commit${behindBefore === 1 ? '' : 's'} behind` : ', already up to date';
  console.log(`sync-memory: pulled latest workspace memory (${br})${fresh ? ` — last change ${fresh.rel} (${fresh.subject})` : ''}${behindNote}`);
  return 0;
}

// `status` subcommand: report freshness without mutating anything. Human line by
// default; --json for tooling (reporter / site-view). Warn-free, exit 0 always
// (exit 2 only on a usage error / non-git dir asked about explicitly).
function statusCmd(dir, asJson) {
  if (!dir || !fs.existsSync(dir)) { console.error('Usage: sync-memory.js status <workspace-dir> [--json]'); return 2; }
  const g = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (g(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    const off = { enabled: false, reason: 'not-a-git-repo' };
    console.log(asJson ? JSON.stringify(off) : 'memory: not bootstrapped (run /pipecrew:memory-sync enable, or memory is off for this workspace)');
    return 0;
  }
  const br = (g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'main').trim();
  const hasRemote = g(['remote']).stdout.trim().length > 0;
  const dirty = g(['status', '--porcelain']).stdout.trim().length > 0;
  let ahead = 0, behind = 0, remoteKnown = false;
  if (hasRemote) {
    g(['fetch', 'origin', br]); // best-effort; offline just yields stale counts
    if (g(['rev-parse', '--verify', `origin/${br}`]).status === 0) {
      remoteKnown = true;
      ahead = countRev(g, `origin/${br}..HEAD`);
      behind = countRev(g, `HEAD..origin/${br}`);
    }
  }
  const fresh = lastChange(g, 'HEAD');
  const out = {
    enabled: true, branch: br, hasRemote, dirty,
    unpushedCommits: ahead, behindRemote: behind, remoteKnown,
    lastChange: fresh ? { iso: fresh.iso, relative: fresh.rel, subject: fresh.subject, author: fresh.author } : null,
  };
  if (asJson) { console.log(JSON.stringify(out)); return 0; }
  const bits = [];
  bits.push(fresh ? `last change ${fresh.rel} (${fresh.subject})` : 'no commits yet');
  if (!hasRemote) bits.push('no remote configured');
  else if (!remoteKnown) bits.push('remote not reachable (showing local state)');
  else {
    if (behind > 0) bits.push(`${behind} behind origin — run /pipecrew:memory-sync pull`);
    if (ahead > 0) bits.push(`${ahead} unpushed local commit${ahead === 1 ? '' : 's'} — run /pipecrew:memory-sync sync`);
    if (behind === 0 && ahead === 0) bits.push('in sync with the team');
  }
  if (dirty) bits.push('uncommitted local changes pending next sync');
  console.log(`memory (${br}): ${bits.join(' · ')}`);
  return 0;
}

// commits in a revision range (e.g. "HEAD..origin/main"); 0 on any error.
function countRev(g, range) {
  const r = g(['rev-list', '--count', range]);
  return r.status === 0 ? (parseInt(r.stdout.trim(), 10) || 0) : 0;
}

// last commit metadata on a ref: iso date, relative date, subject, author. null if none.
function lastChange(g, ref) {
  const r = g(['log', '-1', '--format=%cI%x1f%cr%x1f%s%x1f%an', ref]);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const [iso, rel, subject, author] = r.stdout.trim().split('\x1f');
  return { iso, rel, subject, author };
}
