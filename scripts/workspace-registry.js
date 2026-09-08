#!/usr/bin/env node
/**
 * workspace-registry.js — registry of PipeCrew workspaces.
 *
 * Supersedes the single-mutable-`workspace_root` model (see
 * docs/design/workspace-registry.md). A workspace is a self-contained folder
 * (`config.json` + context/ + agents/ + history/ + runs/) that may live ANYWHERE
 * on disk. The registry records the set of known workspaces + which is current,
 * so repointing never orphans anything and a workspace can sit next to its repos.
 *
 * Plugin config (~/.claude/pipecrew/config.json):
 *   {
 *     "default_root": "<dir>",                 // where NEW workspaces are created (optional)
 *     "workspaces":   [ { "slug", "path" } ],  // registered workspaces, any location
 *     "current":      "<slug>",                // active workspace
 *     "workspace_root": "<dir>"                // LEGACY — kept as a hint after migration
 *   }
 *
 * Resolution precedence (resolve()):
 *   1. $PIPECREW_WORKSPACE_ROOT env  → ephemeral: scan that dir, don't persist
 *   2. --workspace=<slug>            → registry lookup
 *   3. config.current               → registry lookup
 *   4. exactly one registered        → that one
 *   5. none / ambiguous              → null (caller prompts or asks)
 *
 * Auto-migration: the first read that finds a legacy `workspace_root` string and
 * no `workspaces[]` scans each `{workspace_root}/<slug>/config.json`, registers
 * what it finds, keeps `workspace_root` as `default_root`, and persists —
 * idempotent, never deletes.
 *
 * CLI:
 *   --list [--json]                 list registered workspaces (current marked)
 *   --resolve [--workspace=<slug>] [--json]
 *                                   resolve ONE workspace; prints its path (or
 *                                   {slug,path,root} with --json). Exit 3 + list
 *                                   on stderr when ambiguous/none.
 *   --root-for=<slug>               print dirname of that slug's workspace path
 *   --register=<path> [--current]   upsert a workspace (slug read from its config.json)
 *   --set-current=<slug>            set the active workspace
 *   --adopt=<dir>                   scan <dir> for child workspaces and register each
 *   --forget=<slug>                 remove a workspace from the registry (no files touched)
 *   --config-path                   print the plugin config path
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PLUGIN_DIR = path.join(HOME, '.claude', 'pipecrew');
// The plugin config path is overridable via $PIPECREW_CONFIG_FILE (used by tests
// so they never touch the user's real ~/.claude/pipecrew/config.json).
const CONFIG_FILE = process.env.PIPECREW_CONFIG_FILE
  ? path.resolve(process.env.PIPECREW_CONFIG_FILE)
  : path.join(PLUGIN_DIR, 'config.json');
const CONFIG_DIR = path.dirname(CONFIG_FILE);
const DEFAULT_ROOT = path.join(PLUGIN_DIR, 'workspaces');
const ENV_VAR = 'PIPECREW_WORKSPACE_ROOT';

function norm(p) {
  if (!p) return p;
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || p.replace(/\\/g, '/');
}
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// Read a workspace's slug from its config.json; fall back to the dir basename.
function slugForDir(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (c && c.workspace && c.workspace.slug) return c.workspace.slug;
  } catch (_) { /* fall through */ }
  return path.basename(norm(dir));
}
// A dir is a workspace if it has a config.json with a workspace block.
function isWorkspaceDir(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return !!(c && c.workspace && c.workspace.slug);
  } catch (_) { return false; }
}
// Scan a root for immediate child workspace dirs → [{slug, path}].
function scanRoot(root) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = norm(path.join(root, e.name));
    if (isWorkspaceDir(dir)) out.push({ slug: slugForDir(dir), path: dir });
  }
  return out;
}

// Load the config, applying one-time legacy migration. Returns { cfg, dirty }.
function load() {
  const cfg = readConfig();
  let dirty = false;
  if (!Array.isArray(cfg.workspaces)) {
    cfg.workspaces = [];
    const legacyRoot = cfg.workspace_root && norm(expandTilde(cfg.workspace_root));
    if (legacyRoot) {
      for (const ws of scanRoot(legacyRoot)) upsert(cfg, ws.path, false);
      if (!cfg.default_root) cfg.default_root = cfg.workspace_root;
      if (!cfg.current && cfg.workspaces.length === 1) cfg.current = cfg.workspaces[0].slug;
    }
    dirty = true;
  }
  return { cfg, dirty };
}
function loadPersisted() {
  const { cfg, dirty } = load();
  if (dirty) writeConfig(cfg);
  return cfg;
}

function upsert(cfg, wsPath, setCurrent) {
  const p = norm(expandTilde(wsPath));
  const slug = slugForDir(p);
  const existing = cfg.workspaces.find((w) => w.slug === slug);
  if (existing) existing.path = p;
  else cfg.workspaces.push({ slug, path: p });
  if (setCurrent) cfg.current = slug;
  return slug;
}

// Ephemeral list for the env override: scan the env dir, don't persist.
function envWorkspaces() {
  const envRoot = process.env[ENV_VAR];
  if (!envRoot) return null;
  return scanRoot(norm(expandTilde(envRoot)));
}

/**
 * Resolve to a single workspace. Returns { slug, path, root } or
 * { error, candidates } when ambiguous / none.
 */
function resolve(slug) {
  const env = envWorkspaces();
  const list = env || loadPersisted().workspaces;
  const cfg = env ? {} : loadPersisted();

  if (slug) {
    const w = list.find((x) => x.slug === slug);
    return w ? withRoot(w) : { error: `no registered workspace with slug "${slug}"`, candidates: list };
  }
  if (!env && cfg.current) {
    const w = list.find((x) => x.slug === cfg.current);
    if (w) return withRoot(w);
  }
  if (list.length === 1) return withRoot(list[0]);
  return { error: list.length ? 'multiple workspaces registered — pass --workspace=<slug>' : 'no workspaces registered — run /discover or /join', candidates: list };
}
function withRoot(w) { return { slug: w.slug, path: w.path, root: norm(path.dirname(w.path)) }; }

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const eq = argv.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null;
  };
  const asJson = argv.includes('--json');

  if (argv.includes('--config-path')) { process.stdout.write(CONFIG_FILE + '\n'); process.exit(0); }

  if (argv.includes('--list')) {
    const cfg = loadPersisted();
    if (asJson) {
      process.stdout.write(JSON.stringify({ current: cfg.current || null, default_root: cfg.default_root || null, workspaces: cfg.workspaces }, null, 2) + '\n');
    } else if (!cfg.workspaces.length) {
      process.stdout.write('(no workspaces registered — run /discover or /join)\n');
    } else {
      for (const w of cfg.workspaces) process.stdout.write(`${w.slug === cfg.current ? '* ' : '  '}${w.slug}\t${w.path}\n`);
    }
    process.exit(0);
  }

  if (argv.includes('--resolve')) {
    const r = resolve(flag('--workspace') || null);
    if (r.error) {
      process.stderr.write(r.error + '\n');
      for (const c of (r.candidates || [])) process.stderr.write(`  ${c.slug}\t${c.path}\n`);
      process.exit(3);
    }
    process.stdout.write((asJson ? JSON.stringify(r) : r.path) + '\n');
    process.exit(0);
  }

  const rootFor = flag('--root-for');
  if (rootFor && rootFor !== true) {
    const r = resolve(rootFor);
    if (r.error) { process.stderr.write(r.error + '\n'); process.exit(3); }
    process.stdout.write(r.root + '\n');
    process.exit(0);
  }

  const reg = flag('--register');
  if (reg && reg !== true) {
    const abs = norm(path.resolve(expandTilde(reg)));
    if (!isWorkspaceDir(abs)) { process.stderr.write(`not a workspace dir (no config.json with workspace.slug): ${abs}\n`); process.exit(2); }
    const cfg = loadPersisted();
    const slug = upsert(cfg, abs, argv.includes('--current'));
    writeConfig(cfg);
    process.stdout.write(`registered ${slug} -> ${abs}${argv.includes('--current') ? ' (current)' : ''}\n`);
    process.exit(0);
  }

  const setCur = flag('--set-current');
  if (setCur && setCur !== true) {
    const cfg = loadPersisted();
    if (!cfg.workspaces.find((w) => w.slug === setCur)) { process.stderr.write(`no registered workspace with slug "${setCur}"\n`); process.exit(2); }
    cfg.current = setCur; writeConfig(cfg);
    process.stdout.write(`current -> ${setCur}\n`);
    process.exit(0);
  }

  const adopt = flag('--adopt');
  if (adopt && adopt !== true) {
    const dir = norm(expandTilde(adopt));
    const found = scanRoot(dir);
    if (!found.length) { process.stderr.write(`no workspaces found under ${dir}\n`); process.exit(2); }
    const cfg = loadPersisted();
    const added = [];
    for (const ws of found) { const before = cfg.workspaces.length; upsert(cfg, ws.path, false); if (cfg.workspaces.length > before) added.push(ws.slug); }
    writeConfig(cfg);
    process.stdout.write(`adopted ${found.length} workspace(s) under ${dir}: ${found.map((w) => w.slug).join(', ')}\n`);
    process.exit(0);
  }

  const forget = flag('--forget');
  if (forget && forget !== true) {
    const cfg = loadPersisted();
    const before = cfg.workspaces.length;
    cfg.workspaces = cfg.workspaces.filter((w) => w.slug !== forget);
    if (cfg.workspaces.length === before) { process.stderr.write(`no registered workspace with slug "${forget}"\n`); process.exit(2); }
    if (cfg.current === forget) delete cfg.current;
    writeConfig(cfg);
    process.stdout.write(`forgot ${forget} (files left on disk)\n`);
    process.exit(0);
  }

  process.stderr.write('Usage: workspace-registry.js [--list|--resolve|--root-for=<slug>|--register=<path>|--set-current=<slug>|--adopt=<dir>|--forget=<slug>|--config-path] [--workspace=<slug>] [--json] [--current]\n');
  process.exit(1);
}

module.exports = {
  CONFIG_FILE, DEFAULT_ROOT, ENV_VAR,
  readConfig, writeConfig, load, loadPersisted, resolve, scanRoot,
  slugForDir, isWorkspaceDir, upsert, norm,
};
