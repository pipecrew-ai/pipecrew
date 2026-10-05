#!/usr/bin/env node
/**
 * workspace-registry.js — registry of PipeCrew workspaces.
 *
 * Supersedes the single-mutable-`workspace_root` model (see
 * docs/design/workspace-registry.md). A workspace is a self-contained folder
 * (`config.json` + context/ + agents/ + history/ + runs/) that may live ANYWHERE
 * on disk. The registry records the set of known workspaces + a default,
 * so repointing never orphans anything and a workspace can sit next to its repos.
 *
 * Plugin config (~/.claude/pipecrew/config.json):
 *   {
 *     "default_root": "<dir>",                 // where NEW workspaces are created (optional)
 *     "workspaces":   [ { "slug", "path" } ],  // registered workspaces, any location
 *     "default_workspace": "<slug>",           // fallback when nothing session-scoped resolves
 *     "workspace_root": "<dir>"                // LEGACY — kept as a hint after migration
 *   }
 *
 * Resolution precedence (resolve(slug, {cwd})) — session-scoped before global
 * (see docs/design/workspace-registry.md § Follow-up):
 *   0. $PIPECREW_WORKSPACE_ROOT env  → ephemeral: scan that dir as the candidate
 *                                      list, don't persist (steps below still run)
 *   1. --workspace=<slug>            → registry lookup; NEVER persisted
 *   2. $PIPECREW_WORKSPACE           → slug or workspace path; session-scoped pin
 *   3. cwd inference                 → cwd inside a workspace folder or one of its
 *                                      repos (config.json repos.*.path); longest
 *                                      match wins, exact tie = ambiguous
 *   4. config.default_workspace      → registry lookup
 *   5. exactly one registered        → that one
 *   6. none / ambiguous              → error (caller prompts or asks)
 *
 * Auto-migration (idempotent, never deletes): a legacy `workspace_root` string
 * with no `workspaces[]` is scanned + registered (v1.10); a legacy `current`
 * key is renamed `default_workspace`.
 *
 * CLI:
 *   --list [--json]                 list registered workspaces (default marked)
 *   --resolve [--workspace=<slug>] [--cwd=<path>|--no-cwd] [--json]
 *                                   resolve ONE workspace; prints its path (or
 *                                   {slug,path,root} with --json). Infers from
 *                                   process.cwd() unless --no-cwd. Exit 3 + list
 *                                   on stderr when ambiguous/none.
 *   --root-for=<slug>               print dirname of that slug's workspace path
 *   --register=<path> [--default]   upsert a workspace (slug read from its config.json)
 *   --set-default=<slug>            set the default workspace
 *   --adopt=<dir>                   scan <dir> for child workspaces and register each
 *   --forget=<slug>                 remove a workspace from the registry (no files touched)
 *   --config-path                   print the plugin config path
 *   (deprecated aliases kept: --set-current=<slug>, --register … --current)
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Which harness are we running under? PipeCrew is dual-target (Claude Code +
// Cursor); runtime state must land in the host harness's home dir, not a
// hardcoded ~/.claude. The plugin's install path is the signal — a Cursor plugin
// lives under `.cursor/`, a Claude Code plugin under `.claude/`. `PIPECREW_HARNESS`
// overrides (tests / edge cases). Unknown → `claude` (preserves legacy behavior
// byte-for-byte for existing Claude Code users).
function detectHarness() {
  const override = (process.env.PIPECREW_HARNESS || '').trim().toLowerCase();
  if (override === 'cursor' || override === 'claude') return override;
  const here = __dirname.replace(/\\/g, '/');
  if (/(^|\/)\.cursor(\/|$)/.test(here)) return 'cursor';
  if (/(^|\/)\.claude(\/|$)/.test(here)) return 'claude';
  if (process.env.CURSOR_PROJECT_DIR || process.env.CURSOR_VERSION) return 'cursor';
  return 'claude';
}

const HARNESS = detectHarness();
const HARNESS_HOME = path.join(HOME, HARNESS === 'cursor' ? '.cursor' : '.claude');
const PLUGIN_DIR = path.join(HARNESS_HOME, 'pipecrew');
// The plugin config path is overridable via $PIPECREW_CONFIG_FILE (used by tests
// so they never touch the user's real <harness_home>/pipecrew/config.json).
const CONFIG_FILE = process.env.PIPECREW_CONFIG_FILE
  ? path.resolve(process.env.PIPECREW_CONFIG_FILE)
  : path.join(PLUGIN_DIR, 'config.json');
const CONFIG_DIR = path.dirname(CONFIG_FILE);
const DEFAULT_ROOT = path.join(PLUGIN_DIR, 'workspaces');
const USER_AGENTS_DIR = path.join(HARNESS_HOME, 'agents');
const ENV_VAR = 'PIPECREW_WORKSPACE_ROOT';
const WS_ENV_VAR = 'PIPECREW_WORKSPACE';

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
      if (!cfg.current && !cfg.default_workspace && cfg.workspaces.length === 1) cfg.default_workspace = cfg.workspaces[0].slug;
    }
    dirty = true;
  }
  // Rename migration: `current` → `default_workspace` (see the design doc's
  // follow-up section — it's a default, not a pointer to anything live).
  if (cfg.current !== undefined) {
    if (cfg.default_workspace === undefined) cfg.default_workspace = cfg.current;
    delete cfg.current;
    dirty = true;
  }
  return { cfg, dirty };
}
function loadPersisted() {
  const { cfg, dirty } = load();
  if (dirty) writeConfig(cfg);
  return cfg;
}

function upsert(cfg, wsPath, setDefault) {
  const p = norm(expandTilde(wsPath));
  const slug = slugForDir(p);
  const existing = cfg.workspaces.find((w) => w.slug === slug);
  if (existing) existing.path = p;
  else cfg.workspaces.push({ slug, path: p });
  if (setDefault) cfg.default_workspace = slug;
  return slug;
}

// Ephemeral list for the env override: scan the env dir, don't persist.
function envWorkspaces() {
  const envRoot = process.env[ENV_VAR];
  if (!envRoot) return null;
  return scanRoot(norm(expandTilde(envRoot)));
}

// Dirs that map a cwd onto a workspace: the workspace folder itself plus every
// repo path in its config.json (a session working inside a repo means that
// repo's workspace).
function workspaceCandidateDirs(w) {
  const dirs = [norm(w.path)];
  try {
    const c = JSON.parse(fs.readFileSync(path.join(w.path, 'config.json'), 'utf8'));
    for (const key of Object.keys(c.repos || {})) {
      const p = c.repos[key] && c.repos[key].path;
      if (p) dirs.push(norm(expandTilde(p)));
    }
  } catch (_) { /* unreadable config — the workspace still matches by its own path */ }
  return dirs;
}
// Windows and macOS filesystems are case-insensitive by default.
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin';
function fold(p) { return CASE_FOLD ? p.toLowerCase() : p; }
function isWithin(child, parent) {
  const c = fold(child), p = fold(parent);
  return c === p || c.startsWith(p + '/');
}
/**
 * cwd → workspace. Longest-path match wins; an exact tie across different
 * workspaces is ambiguous (never guess, never fall through to the default —
 * that could silently pick wrong). Returns null when nothing matches.
 */
function inferFromCwd(list, cwd) {
  const c = norm(cwd);
  let bestLen = -1, best = [];
  for (const w of list) {
    for (const dir of workspaceCandidateDirs(w)) {
      if (!dir || !isWithin(c, dir)) continue;
      if (dir.length > bestLen) { bestLen = dir.length; best = [w]; }
      else if (dir.length === bestLen && !best.includes(w)) best.push(w);
    }
  }
  if (!best.length) return null;
  if (best.length > 1) return { error: `cwd belongs to ${best.length} workspaces (${best.map((w) => w.slug).join(', ')}) — pass --workspace=<slug>`, candidates: best };
  return withRoot(best[0]);
}

/**
 * Resolve to a single workspace. Returns { slug, path, root } or
 * { error, candidates } when ambiguous / none.
 *
 * opts.cwd enables cwd inference (step 3 of the precedence). Library callers
 * must opt in; the CLI passes process.cwd() unless --no-cwd.
 */
function resolve(slug, opts) {
  opts = opts || {};
  const env = envWorkspaces();
  const cfg = env ? {} : loadPersisted();
  const list = env || cfg.workspaces;

  if (slug) {
    const w = list.find((x) => x.slug === slug);
    return w ? withRoot(w) : { error: `no registered workspace with slug "${slug}"`, candidates: list };
  }
  const pin = (process.env[WS_ENV_VAR] || '').trim();
  if (pin) {
    const bySlug = list.find((x) => x.slug === pin);
    if (bySlug) return withRoot(bySlug);
    const p = norm(path.resolve(expandTilde(pin)));
    if (isWorkspaceDir(p)) return withRoot({ slug: slugForDir(p), path: p });
    return { error: `$${WS_ENV_VAR}="${pin}" is neither a registered slug nor a workspace dir`, candidates: list };
  }
  if (opts.cwd) {
    const hit = inferFromCwd(list, opts.cwd);
    if (hit) return hit; // match or tie-ambiguity — both stop here
  }
  if (!env && cfg.default_workspace) {
    const w = list.find((x) => x.slug === cfg.default_workspace);
    if (w) return withRoot(w);
  }
  if (list.length === 1) return withRoot(list[0]);
  return { error: list.length ? 'multiple workspaces registered and none matches this session — pass --workspace=<slug> or set one with --set-default' : 'no workspaces registered — run /discover or /join', candidates: list };
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
      // `current` is a deprecated mirror of `default_workspace`, kept one release
      // for script consumers of this JSON output.
      process.stdout.write(JSON.stringify({ default_workspace: cfg.default_workspace || null, current: cfg.default_workspace || null, default_root: cfg.default_root || null, workspaces: cfg.workspaces }, null, 2) + '\n');
    } else if (!cfg.workspaces.length) {
      process.stdout.write('(no workspaces registered — run /discover or /join)\n');
    } else {
      for (const w of cfg.workspaces) process.stdout.write(`${w.slug === cfg.default_workspace ? '* ' : '  '}${w.slug}\t${w.path}\n`);
    }
    process.exit(0);
  }

  if (argv.includes('--resolve')) {
    const cwdFlag = flag('--cwd');
    const cwd = argv.includes('--no-cwd') ? null : (typeof cwdFlag === 'string' ? cwdFlag : process.cwd());
    const r = resolve(flag('--workspace') || null, { cwd });
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
    const makeDefault = argv.includes('--default') || argv.includes('--current'); // --current: deprecated alias
    const slug = upsert(cfg, abs, makeDefault);
    writeConfig(cfg);
    process.stdout.write(`registered ${slug} -> ${abs}${makeDefault ? ' (default)' : ''}\n`);
    process.exit(0);
  }

  const setDefRaw = flag('--set-default');
  const setCurRaw = flag('--set-current'); // deprecated alias
  const setDef = (setDefRaw && setDefRaw !== true) ? setDefRaw : ((setCurRaw && setCurRaw !== true) ? setCurRaw : null);
  if (setDef) {
    const cfg = loadPersisted();
    if (!cfg.workspaces.find((w) => w.slug === setDef)) { process.stderr.write(`no registered workspace with slug "${setDef}"\n`); process.exit(2); }
    cfg.default_workspace = setDef; writeConfig(cfg);
    process.stdout.write(`default -> ${setDef}\n`);
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
    if (cfg.default_workspace === forget) delete cfg.default_workspace;
    writeConfig(cfg);
    process.stdout.write(`forgot ${forget} (files left on disk)\n`);
    process.exit(0);
  }

  process.stderr.write('Usage: workspace-registry.js [--list|--resolve|--root-for=<slug>|--register=<path>|--set-default=<slug>|--adopt=<dir>|--forget=<slug>|--config-path] [--workspace=<slug>] [--cwd=<path>|--no-cwd] [--json] [--default]\n');
  process.exit(1);
}

module.exports = {
  CONFIG_FILE, DEFAULT_ROOT, ENV_VAR, WS_ENV_VAR,
  HARNESS, HARNESS_HOME, USER_AGENTS_DIR, detectHarness,
  readConfig, writeConfig, load, loadPersisted, resolve, scanRoot,
  slugForDir, isWorkspaceDir, upsert, norm, inferFromCwd,
};
