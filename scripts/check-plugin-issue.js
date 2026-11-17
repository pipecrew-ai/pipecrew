#!/usr/bin/env node
/**
 * Leak gate for plugin-issue drafts produced by /pipecrew:learn.
 *
 * A draft filed against the PipeCrew repo must not carry anything about the
 * workspace's own platform. This script scans a draft and reports every term
 * that would leak it.
 *
 * Usage:
 *   node check-plugin-issue.js --draft=<file> [--config=<config.json>] [--json]
 *
 * Exit codes:
 *   0 — clean
 *   1 — leaks found (one `kind  term  line:col` line per hit; --json → {ok, hits})
 *   2 — usage / IO error
 *
 * Checks:
 *   - config-derived blocklist (when --config given): workspace slug/name, repo
 *     keys, repo path basenames, repo_url owner + repo, service keys/names,
 *     origin-remote owner of each repo (skipped silently when not a git repo).
 *   - always-on: absolute paths, emails, github.com/<owner>/ URLs whose owner is
 *     not the plugin repo owner, secrets (scripts/redact-secrets.js --check).
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GENERIC = new Set([
  'api', 'frontend', 'backend', 'service', 'services', 'web', 'app', 'mock', 'infra', 'worker',
  'docs', 'other', 'main', 'test', 'tests', 'src', 'lib', 'common', 'core', 'shared',
  'react', 'nestjs', 'nest', 'spring', 'springboot', 'node', 'nodejs', 'express', 'vue', 'angular',
  'java', 'python', 'fastapi', 'django', 'flask', 'dotnet', 'go', 'rust', 'typescript', 'javascript',
  'plugin', 'workspace', 'repo', 'git', 'github',
]);

function parseArgs(argv) {
  const o = { json: false };
  for (const a of argv) {
    if (a === '--json') o.json = true;
    else if (a.startsWith('--draft=')) o.draft = a.slice(8);
    else if (a.startsWith('--config=')) o.config = a.slice(9);
    else if (a.startsWith('--plugin-json=')) o.pluginJson = a.slice(14);
  }
  return o;
}

function die(msg) { console.error(msg); process.exit(2); }

function parseGithub(url) {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

function pluginRepo(pluginJsonPath) {
  try {
    const j = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    return parseGithub(j.repository) || parseGithub(j.homepage);
  } catch { return null; }
}

function buildBlocklist(config, plugin) {
  const terms = new Map(); // lower -> {term, kind}
  const skip = new Set();
  if (plugin) { skip.add(plugin.owner.toLowerCase()); skip.add(plugin.repo.toLowerCase()); }
  const add = (term, kind) => {
    if (typeof term !== 'string') return;
    const t = term.trim();
    const l = t.toLowerCase();
    if (t.length < 3 || GENERIC.has(l) || skip.has(l)) return;
    if (!terms.has(l)) terms.set(l, { term: t, kind });
  };
  const ws = config.workspace || {};
  add(ws.slug, 'workspace');
  add(ws.name, 'workspace');
  for (const [key, repo] of Object.entries(config.repos || {})) {
    add(key, 'repo');
    if (!repo || typeof repo !== 'object') continue;
    if (repo.path) {
      add(path.basename(String(repo.path).replace(/[\\/]+$/, '')), 'repo-path');
      try {
        const r = spawnSync('git', ['-C', repo.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
        if (r.status === 0) { const g = parseGithub(r.stdout); if (g) add(g.owner, 'remote-owner'); }
      } catch { /* not a git repo */ }
    }
    const g = parseGithub(repo.repo_url);
    if (g) { add(g.owner, 'repo-url-owner'); add(g.repo, 'repo-url'); }
  }
  const svc = config.services || {};
  for (const [key, s] of Object.entries(svc)) {
    add(key, 'service');
    if (s && typeof s === 'object' && s.name) add(s.name, 'service');
  }
  return [...terms.values()];
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function locate(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

function scan(text, blocklist, plugin) {
  const hits = [];
  const push = (kind, term, index) => hits.push({ kind, term, ...locate(text, index) });

  for (const { term, kind } of blocklist) {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(term)}(?![A-Za-z0-9_-])`, 'gi');
    let m;
    while ((m = re.exec(text))) push(kind, m[0], m.index);
  }
  let m;
  const absRe = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`)\]]*|(?<![A-Za-z0-9_.-])\/(?:home|Users)\/[^\s"'`)\]]*/g;
  while ((m = absRe.exec(text))) push('abs-path', m[0], m.index);
  const mailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = mailRe.exec(text))) push('email', m[0], m.index);
  const ghRe = /github\.com[/:]([A-Za-z0-9_.-]+)\//gi;
  while ((m = ghRe.exec(text))) {
    if (!plugin || m[1].toLowerCase() !== plugin.owner.toLowerCase()) push('foreign-url', m[0] + '...', m.index);
  }
  return hits;
}

function secretHits(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plugin-issue-'));
  const tmp = path.join(dir, 'draft.md');
  try {
    fs.writeFileSync(tmp, text);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'redact-secrets.js'), tmp, '--check', '--quiet'], { encoding: 'utf8' });
    return r.status === 1 ? [{ kind: 'secret', term: '(secret value)', line: 0, col: 0 }] : [];
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.draft) die('Usage: check-plugin-issue.js --draft=<file> [--config=<config.json>] [--json]');
  let text;
  try { text = fs.readFileSync(o.draft, 'utf8'); } catch (e) { die(`Cannot read draft: ${o.draft} (${e.message})`); }
  let config = null;
  if (o.config) {
    try { config = JSON.parse(fs.readFileSync(o.config, 'utf8')); } catch (e) { die(`Cannot read config: ${o.config} (${e.message})`); }
  }
  const plugin = pluginRepo(o.pluginJson || path.join(__dirname, '..', '.claude-plugin', 'plugin.json'));
  const hits = scan(text, config ? buildBlocklist(config, plugin) : [], plugin).concat(secretHits(text));
  hits.sort((a, b) => a.line - b.line || a.col - b.col);

  if (o.json) {
    console.log(JSON.stringify({ ok: hits.length === 0, hits: hits.map(h => ({ kind: h.kind, term: h.term, line: h.line })) }));
  } else {
    for (const h of hits) console.log(`${h.kind}  ${h.term}  ${h.line}:${h.col}`);
  }
  process.exit(hits.length ? 1 : 0);
}

main();
