#!/usr/bin/env node
'use strict';
/**
 * refresh-state.js — the shared, committed freshness baseline for context docs.
 *
 * THE IDEA (one sentence): drop a "bookmark" saying *the docs were verified as of
 * commit X* inside the repo's agent-context/ folder and COMMIT it, so the next
 * /context-refresh reads only what changed since X (a git diff) instead of the whole
 * codebase — and so a teammate who pulls the docs gets the bookmark too.
 *
 * WHY committed: the bookmark used to live in machine-local runs/context-refresh/
 * state.json, so it was NEVER shared (every teammate re-audited independently) and a
 * fresh /discover left none (first refresh = full re-read). Putting it in the code
 * repo, next to the docs it describes, makes it travel with the docs for free.
 *
 * THE FILE — one per repo, one baseline:
 *   { "schema": 1, "repo": "<key>",
 *     "baseline": { "head_sha", "branch", "ran_at", "mode": "full"|"fast", "by" } }
 *   ("mode"/"by" are informational — who moved the bookmark and how; no logic reads them.)
 *
 * THE DECISION (decide()): full = read everything; fast = read only the diff since the
 * bookmark; skip = nothing changed. We choose `full` whenever the bookmark can't be
 * trusted — no bookmark, a different branch, or an unreadable file — because a full
 * scan is always safe (it never skips unverified code).
 *
 * MERGE CONFLICTS ARE LEFT TO ENGINEERS (deliberate trade-off, see docs/design/
 * refresh-state.md): the file is committed, so two teammates advancing it on different
 * branches will conflict on merge — just like any other file. We do NOT auto-resolve.
 * A human resolves it in git; and if an unresolved (conflict-marker) file ever reaches
 * a run, it simply fails to parse → we fall back to a `full` scan. Safe, just not free.
 *
 * Subcommands (all take --repo=<path>):
 *   seed     — write a baseline at current HEAD (mode full). Used by /discover.
 *   decide   — print {path: full|fast|skip, comparisonSha, reason} for this repo.
 *   advance  — after a refresh, move the bookmark to current HEAD (--mode=fast|full).
 *   path     — print the state file path.
 * Offline test hook:  decide --input=<json {state, ctx}>  (no git, no FS).
 *
 * Zero dependencies. Never throws fatally on git/FS hiccups — a bad baseline degrades
 * to a full scan, which is always safe.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEMA = 1;
const STATE_REL = path.join('agent-context', '.refresh-state.json');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}
function flag(name) { return process.argv.includes(`--${name}`); }

// ── pure core (unit-tested; no git, no FS) ──────────────────────────────────

function statePathFor(repoPath) { return path.join(repoPath, STATE_REL); }

function newEntry({ headSha, branch, ranAt, mode = 'full', by = 'unknown', repo = null, prev = null }) {
  return {
    schema: SCHEMA,
    repo: repo != null ? repo : (prev && prev.repo) || null,
    baseline: {
      head_sha: headSha || null,
      branch: branch || null,
      ran_at: ranAt,
      mode,
      by,
    },
  };
}

// A file left with git conflict markers can't be parsed. We don't resolve it (that's
// an engineer's job in git) — we only detect it so `decide` can say WHY it's re-scanning.
function hasConflictMarkers(text) {
  return /^<{7}/m.test(text) && /^={7}/m.test(text) && /^>{7}/m.test(text);
}

// Parse committed text → { state } (null on empty / garbage / conflict markers).
function parseStateText(text) {
  if (text == null || String(text).trim() === '') return { state: null };
  try { return { state: JSON.parse(text) }; } catch (_) { return { state: null }; }
}

// full / fast / skip. When in doubt → full (never skips unverified code).
function decide(state, ctx) {
  const b = state && state.baseline;
  const dirty = ctx.dirtyCount || 0;
  if (ctx.full) return { path: 'full', reason: '--full override' };
  if (!b || !b.head_sha) return { path: 'full', reason: 'no baseline (first run / seed missing / unresolved merge conflict)' };
  if (b.branch !== ctx.branch) return { path: 'full', reason: `branch changed (${b.branch} → ${ctx.branch})` };
  if (b.head_sha === ctx.headSha) {
    return dirty === 0
      ? { path: 'skip', reason: 'no changes since last refresh' }
      : { path: 'full', reason: `uncommitted changes with no new commit (${dirty} files) — full re-scan` };
  }
  return { path: 'fast', comparisonSha: b.head_sha, reason: 'delta from baseline' };
}

// ── git + FS thin layer (CLI side) ──────────────────────────────────────────

function git(repo, args) {
  try { return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); }
  catch (_) { return null; }
}
function headSha(repo) { return git(repo, ['rev-parse', 'HEAD']); }
function branchName(repo) { return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']); }
function dirtyCount(repo) {
  const out = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (out == null) return 0;
  return out.split(/\r?\n/).filter((l) => l.trim()).length;
}
function nowIso() { return new Date().toISOString(); }

function readStateFile(repoPath) {
  const p = statePathFor(repoPath);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return { state: null, path: p, existed: false }; }
  if (hasConflictMarkers(text)) return { state: null, path: p, existed: true, conflicted: true };
  return { state: parseStateText(text).state, path: p, existed: true };
}

function writeStateFile(repoPath, state) {
  const p = statePathFor(repoPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return p;
}

module.exports = {
  STATE_REL, statePathFor, newEntry, hasConflictMarkers, parseStateText, decide,
};

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const sub = process.argv[2];
  const repo = arg('repo');
  const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

  if (sub === 'decide' && arg('input') != null) {
    const { state, ctx } = JSON.parse(fs.readFileSync(arg('input'), 'utf8'));
    out(decide(state, ctx || {}));
    process.exit(0);
  }
  if (!repo && sub !== 'help' && sub != null) { console.error('refresh-state: --repo=<path> required'); process.exit(2); }

  switch (sub) {
    case 'path':
      out({ path: statePathFor(repo) });
      break;
    case 'seed': {
      // Only seed repos that actually have agent-context docs to describe.
      if (!fs.existsSync(path.join(repo, 'agent-context'))) { out({ seeded: false, reason: 'no agent-context/ — nothing to baseline' }); break; }
      const state = newEntry({ headSha: headSha(repo), branch: branchName(repo), ranAt: nowIso(), mode: 'full', by: arg('by') || 'discover', repo: arg('repo-key') });
      writeStateFile(repo, state);
      out({ seeded: true, path: statePathFor(repo), baseline: state.baseline });
      break;
    }
    case 'decide': {
      const r = readStateFile(repo);
      const d = decide(r.state, { headSha: headSha(repo), branch: branchName(repo), dirtyCount: dirtyCount(repo), full: flag('full') });
      if (r.conflicted) d.reason = 'unresolved merge conflict in .refresh-state.json — resolve it in git; running full audit meanwhile';
      out(d);
      break;
    }
    case 'advance': {
      const mode = arg('mode') === 'fast' ? 'fast' : 'full';
      const { state: prev } = readStateFile(repo);
      const state = newEntry({ headSha: headSha(repo), branch: branchName(repo), ranAt: nowIso(), mode, by: arg('by') || 'context-refresh', prev, repo: (prev && prev.repo) || arg('repo-key') });
      writeStateFile(repo, state);
      out({ advanced: true, path: statePathFor(repo), baseline: state.baseline });
      break;
    }
    default:
      console.error('usage: refresh-state.js <seed|decide|advance|path> --repo=<path> [--mode=fast|full] [--full]');
      process.exit(sub ? 2 : 0);
  }
}
