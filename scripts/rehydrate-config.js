#!/usr/bin/env node
/**
 * rehydrate-config.js — rebuild a local config.json from a committed
 * config.portable.json on a teammate's machine (the inverse of
 * sync-memory.js's regeneratePortableConfig).
 *
 * The portable config is machine-independent: each repo carries `dir` (its
 * subpath under the ORIGINAL machine's repos_root) and, optionally, `repo_url`
 * (a clone URL). This script maps each repo to a LOCAL absolute `path` — either
 * an explicit path the caller resolved (clone target or an existing local copy)
 * or, as a default, `{repos_root}/{repo-key}`.
 *
 * The /join skill decides per repo (clone vs point-to-local vs skip) and does the
 * git work; this script is the deterministic, side-effect-free config transform.
 *
 * Path joining is forward-slash string concat, NOT path.join — on win32
 * path.join('C:', 'x') yields the drive-RELATIVE 'C:x'. A drive-root repos_root
 * ('C:') must survive, so we normalize and concat manually.
 *
 * Usage:
 *   node rehydrate-config.js --portable=<config.portable.json> --out=<config.json>
 *        [--repos-root=<dir>]            default local root: {root}/{repo-key} per repo
 *        [--map=key=abs,key2=abs2,...]   explicit absolute path per repo (wins over root)
 *        [--skip=key,key2]               drop these repos (and services referencing them)
 *        [--stdout]                      print result to stdout instead of writing --out
 *
 * Offline test hook: pass --stdout (no --out) to get the rehydrated JSON on stdout.
 *
 * Exit: 0 ok, 2 usage / unresolved repos.
 * Zero dependencies — pure Node stdlib.
 */
const fs = require('fs');

function flag(name, argv) {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (i >= 0 ? true : null);
}

// Normalize to forward slashes and drop trailing slashes (but keep a bare drive
// like "C:" intact). Returns '' for falsy input.
function normRoot(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function joinPath(root, tail) {
  return normRoot(root) + '/' + String(tail).replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseMap(raw) {
  const m = {};
  if (!raw || raw === true) return m;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) m[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return m;
}

/**
 * Core transform. Pure: (portableObj, opts) -> { config, unresolved[] }.
 *   opts.reposRoot : default local root ('' = none)
 *   opts.map       : { repoKey -> absolute path }  (authoritative)
 *   opts.skip      : Set of repo keys to drop
 */
function rehydrate(portable, opts = {}) {
  const reposRoot = normRoot(opts.reposRoot || '');
  const map = opts.map || {};
  const skip = opts.skip || new Set();

  const cfg = JSON.parse(JSON.stringify(portable));
  delete cfg._portable;
  delete cfg._repos_root_note;
  delete cfg.repos_root;

  const unresolved = [];
  const repos = cfg.repos || {};
  for (const key of Object.keys(repos)) {
    if (skip.has(key)) { delete repos[key]; continue; }
    const r = repos[key];
    let localPath = map[key];
    if (!localPath) {
      if (reposRoot) localPath = joinPath(reposRoot, key); // clone target: {root}/{key}
      else { unresolved.push(key); continue; }
    }
    r.path = normRoot(localPath);
    delete r.dir; // dir was the source machine's layout — meaningless locally
    // repo_url is kept: it's a useful, machine-independent field to retain locally.
  }

  // Drop services whose repo was skipped, so the result stays validator-clean.
  if (cfg.services && skip.size) {
    for (const [svc, s] of Object.entries(cfg.services)) {
      if (s && skip.has(s.repo)) delete cfg.services[svc];
    }
  }

  return { config: cfg, unresolved };
}

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const portablePath = flag('--portable', argv);
  const outPath = flag('--out', argv);
  const toStdout = argv.includes('--stdout') || !outPath;

  if (!portablePath || portablePath === true) {
    console.error('Usage: rehydrate-config.js --portable=<config.portable.json> (--out=<config.json> | --stdout) [--repos-root=<dir>] [--map=k=abs,...] [--skip=k,...]');
    process.exit(2);
  }
  let portable;
  try {
    portable = JSON.parse(fs.readFileSync(portablePath, 'utf8'));
  } catch (e) {
    console.error(`rehydrate-config: cannot read/parse ${portablePath}: ${e.message}`);
    process.exit(2);
  }

  const skipRaw = flag('--skip', argv);
  const { config, unresolved } = rehydrate(portable, {
    reposRoot: flag('--repos-root', argv),
    map: parseMap(flag('--map', argv)),
    skip: new Set(skipRaw && skipRaw !== true ? skipRaw.split(',').map((s) => s.trim()).filter(Boolean) : []),
  });

  if (unresolved.length) {
    console.error(`rehydrate-config: no local path for repo(s): ${unresolved.join(', ')} — pass --repos-root or --map for each (or --skip to drop).`);
    process.exit(2);
  }

  const out = JSON.stringify(config, null, 2) + '\n';
  if (toStdout && !outPath) {
    process.stdout.write(out);
  } else {
    fs.writeFileSync(outPath, out);
    console.log(`rehydrate-config: wrote ${outPath} (${Object.keys(config.repos || {}).length} repos)`);
  }
  process.exit(0);
}

module.exports = { rehydrate, normRoot, joinPath, parseMap };
