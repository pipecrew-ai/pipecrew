#!/usr/bin/env node
/**
 * Per-repo profile cache for `/discover` Phase B2.0 (Win #6 of the discover
 * enhancement plan).
 *
 * Win #6: on `/discover --resume`, skip the `repo-discoverer` Sonnet dispatch
 * for any repo whose `HEAD` SHA + branch + REPO_PROFILE schema_version haven't
 * moved since the last run — copy the cached profile into the current run's
 * outputs/repo-profiles/ instead. First-run benefit is zero; second-run benefit
 * scales with the number of stable repos.
 *
 * Cache lives at:
 *   {workspace_root}/{slug}/runs/discover/state.json
 *
 * Two commands:
 *   plan    — decide reuse-vs-rescan for each repo (read-only)
 *   commit  — record the current run's profiles into state.json (write)
 *
 * Decisions:
 *   "reuse"   — cached profile is still valid; orchestrator copies it into
 *               {run_dir}/outputs/repo-profiles/{repo_key}.json
 *   "rescan"  — cache miss; orchestrator dispatches repo-discoverer as usual
 *
 * Invalidation rules (any one triggers rescan):
 *   - No cache entry for repo_key
 *   - HEAD SHA mismatch
 *   - Branch mismatch
 *   - Cached profile_schema_version < canonical schema_version (from example)
 *   - Cached profile_path doesn't exist or fails to parse as JSON
 *   - git rev-parse fails (detached HEAD, non-git dir, etc.) — defensive
 *
 * Schema version: read from templates/blocks/repo-profile.example.json at
 *   invocation time so there's no hardcoded constant to drift. Bumping the
 *   schema_version in the example automatically invalidates every existing
 *   cache entry on the next run.
 *
 * Usage:
 *   node discover-cache.js plan <state-json> <example-json> <repos-json>
 *   node discover-cache.js commit <state-json> <example-json> <records-json>
 *
 *   <repos-json>   = '[{"repo_key":"...","repo_path":"/abs/path"}, ...]'
 *   <records-json> = '[{"repo_key":"...","repo_path":"/abs/path","profile_path":"/abs/.../foo.json"}, ...]'
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error / unreadable state file / unparseable args
 *   2 — write error in commit mode
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_FILE_VERSION = 1;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  die(
    'Usage:\n' +
    '  node discover-cache.js plan   <state-json> <example-json> <repos-json>\n' +
    '  node discover-cache.js commit <state-json> <example-json> <records-json>'
  );
}

function readSchemaVersion(examplePath) {
  let raw;
  try {
    raw = fs.readFileSync(examplePath, 'utf8');
  } catch (e) {
    die(`Cannot read example file ${examplePath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    die(`Example file ${examplePath} is not valid JSON: ${e.message}`);
  }
  if (typeof obj.schema_version !== 'number' || !Number.isInteger(obj.schema_version)) {
    die(`Example file ${examplePath} missing integer schema_version`);
  }
  return obj.schema_version;
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return { version: STATE_FILE_VERSION, updated_at: null, repos: {} };
  }
  let raw;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (e) {
    die(`Cannot read state file ${stateFile}: ${e.message}`);
  }
  if (raw.trim() === '') {
    return { version: STATE_FILE_VERSION, updated_at: null, repos: {} };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    // Corrupt state file: treat as empty cache (every repo rescans).
    // Don't die — corrupt cache should never block a run.
    console.error(`WARN: state file ${stateFile} is not valid JSON — treating as empty cache (${e.message})`);
    return { version: STATE_FILE_VERSION, updated_at: null, repos: {} };
  }
  if (!obj || typeof obj !== 'object' || !obj.repos || typeof obj.repos !== 'object') {
    console.error(`WARN: state file ${stateFile} has unexpected shape — treating as empty cache`);
    return { version: STATE_FILE_VERSION, updated_at: null, repos: {} };
  }
  return obj;
}

function gitHead(repoPath) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    return sha;
  } catch (_) {
    return null;
  }
}

function gitBranch(repoPath) {
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'],
      { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return branch || '(detached)';
  } catch (_) {
    return '(detached)';
  }
}

function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : (sha || 'unknown');
}

function profileFileValid(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) return false;
  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    JSON.parse(raw);
    return true;
  } catch (_) {
    return false;
  }
}

// --- plan -------------------------------------------------------------------

function planOne(state, repoKey, repoPath, expectedSchemaVersion) {
  const currentSha = gitHead(repoPath);
  const currentBranch = gitBranch(repoPath);

  // Repos with unreadable HEAD always rescan (orchestrator catches the real
  // error during dispatch; this script stays defensive).
  if (!currentSha) {
    return {
      repo_key: repoKey,
      action: 'rescan',
      current_head: null,
      current_branch: currentBranch,
      reason: 'could not determine HEAD (detached, non-git, or unreadable repo)',
    };
  }

  const cached = state.repos[repoKey];
  if (!cached) {
    return {
      repo_key: repoKey,
      action: 'rescan',
      current_head: shortSha(currentSha),
      current_branch: currentBranch,
      reason: 'no cache entry',
    };
  }

  if (cached.head_sha !== currentSha) {
    return {
      repo_key: repoKey,
      action: 'rescan',
      current_head: shortSha(currentSha),
      current_branch: currentBranch,
      cached_head: shortSha(cached.head_sha),
      reason: `HEAD moved (${shortSha(cached.head_sha)} → ${shortSha(currentSha)})`,
    };
  }

  if (cached.branch !== currentBranch) {
    return {
      repo_key: repoKey,
      action: 'rescan',
      current_head: shortSha(currentSha),
      current_branch: currentBranch,
      cached_head: shortSha(cached.head_sha),
      reason: `branch changed (${cached.branch} → ${currentBranch})`,
    };
  }

  if (cached.profile_schema_version !== expectedSchemaVersion) {
    return {
      repo_key: repoKey,
      action: 'rescan',
      current_head: shortSha(currentSha),
      current_branch: currentBranch,
      reason: `schema version drifted (cached ${cached.profile_schema_version} < expected ${expectedSchemaVersion})`,
    };
  }

  if (!profileFileValid(cached.profile_path)) {
    return {
      repo_key: repoKey,
      action: 'rescan',
      current_head: shortSha(currentSha),
      current_branch: currentBranch,
      reason: `cached profile file missing or unparseable at ${cached.profile_path}`,
    };
  }

  return {
    repo_key: repoKey,
    action: 'reuse',
    profile_path: cached.profile_path,
    current_head: shortSha(currentSha),
    current_branch: currentBranch,
    reason: `HEAD ${shortSha(currentSha)} unchanged since ${cached.scanned_at}`,
  };
}

function cmdPlan(stateFile, exampleFile, reposArg) {
  let repos;
  try {
    repos = JSON.parse(reposArg);
  } catch (e) {
    die(`<repos-json> is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(repos)) die('<repos-json> must be an array');

  const expectedSchemaVersion = readSchemaVersion(exampleFile);
  const state = readState(stateFile);

  const decisions = repos.map((r) => {
    if (!r || typeof r.repo_key !== 'string' || typeof r.repo_path !== 'string') {
      die(`<repos-json> entry must have string repo_key + repo_path (got ${JSON.stringify(r)})`);
    }
    return planOne(state, r.repo_key, r.repo_path, expectedSchemaVersion);
  });

  const stats = decisions.reduce(
    (acc, d) => {
      acc[d.action === 'reuse' ? 'reused' : 'rescanned']++;
      return acc;
    },
    { reused: 0, rescanned: 0 }
  );

  process.stdout.write(JSON.stringify({ schema_version_expected: expectedSchemaVersion, decisions, stats }, null, 2) + '\n');
  process.exit(0);
}

// --- commit -----------------------------------------------------------------

function cmdCommit(stateFile, exampleFile, recordsArg) {
  let records;
  try {
    records = JSON.parse(recordsArg);
  } catch (e) {
    die(`<records-json> is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(records)) die('<records-json> must be an array');

  const expectedSchemaVersion = readSchemaVersion(exampleFile);
  const state = readState(stateFile);

  const nowIso = new Date().toISOString();
  let updated = 0;

  for (const rec of records) {
    if (!rec || typeof rec.repo_key !== 'string' ||
        typeof rec.repo_path !== 'string' ||
        typeof rec.profile_path !== 'string') {
      die(`<records-json> entry must have string repo_key + repo_path + profile_path (got ${JSON.stringify(rec)})`);
    }
    const sha = gitHead(rec.repo_path);
    if (!sha) {
      // Skip repos we can't address by SHA — next run will treat them as cold.
      console.error(`WARN: skipping cache record for ${rec.repo_key} (could not read HEAD)`);
      continue;
    }
    state.repos[rec.repo_key] = {
      head_sha: sha,
      branch: gitBranch(rec.repo_path),
      scanned_at: nowIso,
      profile_path: rec.profile_path,
      profile_schema_version: expectedSchemaVersion,
    };
    updated++;
  }

  state.version = STATE_FILE_VERSION;
  state.updated_at = nowIso;

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    // Atomic write via tempfile + rename.
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    die(`Cannot write state file ${stateFile}: ${e.message}`, 2);
  }

  process.stdout.write(JSON.stringify({
    state_file: stateFile,
    updated_at: nowIso,
    records_updated: updated,
    records_skipped: records.length - updated,
    total_repos_in_cache: Object.keys(state.repos).length,
  }, null, 2) + '\n');
  process.exit(0);
}

// --- entry ------------------------------------------------------------------

const [, , cmd, stateFile, exampleFile, jsonArg] = process.argv;

if (!cmd || !stateFile || !exampleFile || !jsonArg) usage();

if (cmd === 'plan') {
  cmdPlan(stateFile, exampleFile, jsonArg);
} else if (cmd === 'commit') {
  cmdCommit(stateFile, exampleFile, jsonArg);
} else {
  usage();
}
