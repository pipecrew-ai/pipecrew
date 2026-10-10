#!/usr/bin/env node
'use strict';
/**
 * explain-cache.js — answer cache for /explain.
 *
 * A cached answer stays valid while the files it was built from are unchanged —
 * time alone doesn't make an explanation wrong, changed code or docs do. Every
 * entry records a sha256 of each file the explainer read (context docs AND code)
 * plus the HEAD of each git repo those files live in. Lookup decides:
 *
 *   skip    — no recorded file changed → return the cached answer as-is
 *             (`new_commits` notes repos whose HEAD moved, since files the
 *             answer never read can't be fingerprinted)
 *   fast    — some recorded files changed → re-dispatch the explainer with the
 *             previous answer + only the changed files
 *   full    — no entry, --fresh, older than --max-age-days, depth too shallow,
 *             most sources changed, or anything unreadable ("when in doubt, full")
 *   confirm — no exact match but similar past questions exist → the caller
 *             (the skill's model / the user) picks one and re-runs with --key
 *
 * Usage:
 *   explain-cache.js lookup --cache-dir=<dir> --question="…" --perspective=<p>
 *                           [--depth=quick|deep] [--repo=<name>] [--key=<key>]
 *                           [--fresh] [--max-age-days=7]
 *   explain-cache.js store  --cache-dir=<dir> --question="…" --perspective=<p>
 *                           --answer-file=<path> [--depth=quick|deep] [--repo=<name>]
 *                           [--key=<key>]   (update a confirmed similar entry in place)
 *   --answer-file=- reads the answer from stdin, so the caller needs no temp file.
 *
 * Both print one JSON object on stdout. The answer file must contain the
 * explainer's sources block:
 *   <!-- BEGIN EXPLAIN_SOURCES -->
 *   ["/abs/path/a.md", "/abs/path/B.java"]
 *   <!-- END EXPLAIN_SOURCES -->
 *
 * Zero dependencies — pure Node stdlib (git via child_process, optional).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCHEMA = 1;
const HISTORY_KEEP = 3;
const SIMILAR_THRESHOLD = 0.75;
const SIMILAR_MAX = 3;
const FULL_IF_CHANGED_RATIO = 0.5;
const DEFAULT_MAX_AGE_DAYS = 7;
const DEPTH_RANK = { quick: 0, deep: 1 };

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'of', 'to', 'in',
  'on', 'for', 'and', 'or', 'it', 'its', 'this', 'that', 'with', 'how', 'what', 'why', 'where',
  'who', 'when', 'which', 'me', 'please', 'explain', 'tell', 'about', 'can', 'you', 'we', 'our',
]);

// ── pure core ───────────────────────────────────────────────────────────────

function tokens(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t && !STOPWORDS.has(t))
    .map(stem);
}

function stem(t) {
  if (t.includes('.') || t.length <= 3) return t;
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es') && /(ch|sh|x|ss)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function normalize(question) {
  return tokens(question).join(' ');
}

function cacheKey(question, perspective, repo) {
  const basis = `${normalize(question)}|${perspective || 'technical'}|${repo || 'any'}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

// Overlap relative to the SHORTER question, so "how X works" still matches a cached
// "how X works end-to-end across all components". This is only a shortlist — the
// skill's model (or the user) confirms the candidate really asks the same thing.
function overlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

function similar(question, perspective, repo, entries) {
  return entries
    .filter(e => e.perspective === perspective && (e.repo || 'any') === (repo || 'any'))
    .map(e => ({ key: e.key, question: e.question, updated_at: e.updated_at, score: overlap(question, e.question) }))
    .filter(c => c.score >= SIMILAR_THRESHOLD)
    .sort((x, y) => y.score - x.score)
    .slice(0, SIMILAR_MAX)
    .map(c => ({ ...c, score: Math.round(c.score * 100) / 100 }));
}

function extractSources(answerText) {
  const m = String(answerText).match(/<!--\s*BEGIN EXPLAIN_SOURCES\s*-->([\s\S]*?)<!--\s*END EXPLAIN_SOURCES\s*-->/);
  if (!m) return null;
  const body = m[1].replace(/```(?:json)?/g, '').trim();
  try {
    const list = JSON.parse(body);
    return Array.isArray(list) ? [...new Set(list.filter(p => typeof p === 'string' && p))] : null;
  } catch {
    return null;
  }
}

/**
 * decide(entry, current, opts) — the whole freshness policy in one pure function.
 *   entry:   cached entry (or null)
 *   current: { hashes: {path: sha|null}, heads: {repoRoot: sha|null} }
 *   opts:    { fresh, depth, maxAgeDays, now }
 */
function decide(entry, current, opts = {}) {
  if (!entry) return { decision: 'full', reason: 'no cached answer' };
  if (opts.fresh) return { decision: 'full', reason: '--fresh requested' };

  const now = opts.now ? new Date(opts.now) : new Date();
  const maxAgeDays = opts.maxAgeDays == null ? DEFAULT_MAX_AGE_DAYS : opts.maxAgeDays;
  const ageMs = now - new Date(entry.updated_at);
  if (!(ageMs >= 0) || ageMs > maxAgeDays * 86400000) {
    return { decision: 'full', reason: `cached answer older than ${maxAgeDays} days` };
  }

  const want = DEPTH_RANK[opts.depth || 'quick'] ?? 0;
  const have = DEPTH_RANK[entry.depth || 'quick'] ?? 0;
  if (have < want) return { decision: 'full', reason: `cached answer is ${entry.depth} depth, ${opts.depth} requested` };

  const sources = entry.sources || [];
  if (sources.length === 0) return { decision: 'full', reason: 'cached answer recorded no sources' };

  const changed = sources
    .filter(s => (current.hashes || {})[s.path] !== s.sha256)
    .map(s => s.path);

  const newCommits = (entry.repos || [])
    .filter(r => r.head && (current.heads || {})[r.root] && current.heads[r.root] !== r.head)
    .map(r => ({ root: r.root, from: r.head, to: current.heads[r.root] }));

  if (changed.length === 0) {
    return { decision: 'skip', reason: 'no source changed', new_commits: newCommits };
  }
  if (changed.length / sources.length > FULL_IF_CHANGED_RATIO) {
    return { decision: 'full', reason: `${changed.length}/${sources.length} sources changed`, changed_files: changed };
  }
  return { decision: 'fast', reason: `${changed.length}/${sources.length} sources changed`, changed_files: changed };
}

// ── fs / git edges ─────────────────────────────────────────────────────────

function hashFile(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

function gitRoot(p) {
  let dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function countCommits(root, from, to) {
  try {
    return Number(execFileSync('git', ['-C', root, 'rev-list', '--count', `${from}..${to}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

function readEntry(cacheDir, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function listEntries(cacheDir) {
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir)
    .filter(f => f.endsWith('.json'))
    .map(f => readEntry(cacheDir, f.replace(/\.json$/, '')))
    .filter(e => e && e.schema === SCHEMA);
}

function currentState(entry) {
  const hashes = {};
  for (const s of entry.sources || []) hashes[s.path] = hashFile(s.path);
  const heads = {};
  for (const r of entry.repos || []) heads[r.root] = gitHead(r.root);
  return { hashes, heads };
}

function lookup(args) {
  const perspective = args.perspective || 'technical';
  const repo = args.repo || 'any';
  const key = args.key || cacheKey(args.question, perspective, repo);
  const entry = readEntry(args['cache-dir'], key);

  if (!entry && !args.key && !args.fresh) {
    const candidates = similar(args.question, perspective, repo, listEntries(args['cache-dir']));
    if (candidates.length) return { decision: 'confirm', reason: 'similar questions answered before', key, candidates };
  }

  const result = decide(entry, entry ? currentState(entry) : {}, {
    fresh: !!args.fresh,
    depth: args.depth || 'quick',
    maxAgeDays: args['max-age-days'] == null ? undefined : Number(args['max-age-days']),
  });
  if (result.new_commits) {
    result.new_commits = result.new_commits.map(c => ({ ...c, count: countCommits(c.root, c.from, c.to) }));
  }
  const out = { ...result, key };
  if (entry) {
    out.answer_file = path.join(args['cache-dir'], `${key}.md`);
    out.question = entry.question;
    out.depth = entry.depth;
    out.updated_at = entry.updated_at;
  }
  return out;
}

function store(args) {
  const cacheDir = args['cache-dir'];
  const perspective = args.perspective || 'technical';
  const repo = args.repo || 'any';
  const key = args.key || cacheKey(args.question, perspective, repo);
  const answer = args['answer-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args['answer-file'], 'utf8');
  const paths = extractSources(answer);
  if (!paths || paths.length === 0) {
    return { stored: false, key, reason: 'answer has no EXPLAIN_SOURCES block — not cached' };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const prev = readEntry(cacheDir, key);
  const mdPath = path.join(cacheDir, `${key}.md`);
  if (prev && fs.existsSync(mdPath)) {
    const histDir = path.join(cacheDir, 'history', key);
    fs.mkdirSync(histDir, { recursive: true });
    fs.copyFileSync(mdPath, path.join(histDir, `${prev.updated_at.replace(/[:.]/g, '-')}.md`));
    const old = fs.readdirSync(histDir).sort();
    for (const f of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) fs.unlinkSync(path.join(histDir, f));
  }

  const sources = paths.map(p => ({ path: p, sha256: hashFile(p) })).filter(s => s.sha256);
  const roots = [...new Set(sources.map(s => gitRoot(s.path)).filter(Boolean))];
  const now = new Date().toISOString();
  const entry = {
    schema: SCHEMA,
    key,
    question: (args.key && prev && prev.question) || args.question,
    perspective,
    depth: args.depth || 'quick',
    repo,
    created_at: prev ? prev.created_at : now,
    updated_at: now,
    sources,
    repos: roots.map(root => ({ root, head: gitHead(root) })),
  };
  fs.writeFileSync(mdPath, answer);
  fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(entry, null, 2) + '\n');
  return { stored: true, key, answer_file: mdPath, sources: sources.length, skipped_sources: paths.length - sources.length };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!['lookup', 'store'].includes(cmd) || !args['cache-dir'] || (!args.question && !args.key)) {
    process.stderr.write('Usage: explain-cache.js lookup|store --cache-dir=<dir> --question="…" --perspective=<p> [--depth=quick|deep] [--repo=<name>] [--key=<k>] [--fresh] [--max-age-days=7] [--answer-file=<path>]\n');
    process.exit(2);
  }
  if (args.key !== undefined && !/^[0-9a-f]{16}$/.test(String(args.key))) {
    process.stderr.write('--key must be a 16-char hex key from a previous lookup\n');
    process.exit(2);
  }
  if (cmd === 'store' && !args['answer-file']) {
    process.stderr.write('store requires --answer-file=<path>\n');
    process.exit(2);
  }
  const out = cmd === 'lookup' ? lookup(args) : store(args);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { tokens, normalize, cacheKey, overlap, similar, extractSources, decide, lookup, store };
