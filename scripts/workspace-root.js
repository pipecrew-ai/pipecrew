#!/usr/bin/env node
/**
 * workspace-root.js — BACKWARD-COMPAT shim over the workspace registry.
 *
 * The workspace model moved from a single mutable `workspace_root` to a registry
 * of workspaces that can live anywhere (see scripts/workspace-registry.js and
 * docs/design/workspace-registry.md). This shim keeps the old CLI working so the
 * skills that still call it resolve correctly during and after the transition.
 *
 * Because every workspace lives at `<parent>/<slug>`, `--get` returns the PARENT
 * of the *resolved current* workspace — so a caller that joins `{root}/{slug}`
 * for the current slug still lands on the right folder. New code should call
 * `workspace-registry.js --resolve` (path of the chosen workspace directly) or
 * `--root-for=<slug>` instead.
 *
 * Dual-target: PipeCrew installs in both Claude Code and Cursor, so runtime state
 * (config, workspaces, published agents) lands in the host harness's home dir
 * (~/.claude or ~/.cursor). Harness detection is shared with the registry; this
 * shim re-exposes the harness-specific paths (--agents-dir / --harness) so callers
 * have a single resolver. `PIPECREW_HARNESS=cursor|claude` overrides detection;
 * an unknown install location falls back to `claude` (legacy behavior preserved
 * byte-for-byte for existing Claude Code users).
 *
 * Commands (unchanged surface, plus harness flags):
 *   --get [--workspace=<slug>]
 *                 parent dir of the given workspace (or the current one). Because
 *                 a workspace lives at <parent>/<slug>, `{that}/{slug}` resolves
 *                 to the workspace regardless of where it sits on disk.
 *   --default     the default creation dir (<harness_home>/pipecrew/workspaces)
 *   --check       exit 0 if any workspace is registered / a root is set, else 2
 *   --set=<path>  set the default creation dir AND adopt workspaces already under it
 *   --config-path print <harness_home>/pipecrew/config.json
 *   --agents-dir  print the harness user-level agents dir (~/.claude/agents or
 *                 ~/.cursor/agents) the Agent tool resolves subagent_type against
 *   --harness     print the detected harness (claude | cursor)
 *   --context-filename
 *                 print the canonical per-repo context filename (AGENTS.md — same
 *                 on every harness)
 *   --context-shim
 *                 print the extra shim file to also write (CLAUDE.md under Claude
 *                 Code, nothing otherwise)
 *
 * Zero dependencies — pure Node stdlib.
 */

const path = require('path');
const os = require('os');
const reg = require('./workspace-registry');

const HOME = os.homedir();

// Harness detection is owned by the registry (single source of truth); the
// harness-home-based paths below are re-derived here so the CLI output for
// --default / --config-path / --agents-dir / --harness is independent of the
// $PIPECREW_CONFIG_FILE test override (which only redirects the registry's
// config file, not the harness home).
const HARNESS = reg.HARNESS;
const HARNESS_HOME = path.join(HOME, HARNESS === 'cursor' ? '.cursor' : '.claude');
const PLUGIN_CONFIG_FILE = path.join(HARNESS_HOME, 'pipecrew', 'config.json');
const DEFAULT_WORKSPACE_ROOT = path.join(HARNESS_HOME, 'pipecrew', 'workspaces');
const USER_AGENTS_DIR = path.join(HARNESS_HOME, 'agents');

// The per-repo agent-context file. `AGENTS.md` is the canonical, tool-agnostic
// standard (read natively by Codex, Cursor, and 30+ agents; Claude Code reads it
// via import). It is the same on every harness. Under Claude Code we ALSO write a
// thin `CLAUDE.md` shim (`@AGENTS.md`) to keep Claude's richer native loading with
// one source of content; other harnesses need no shim. CONTEXT_SHIM is the shim
// filename to also write, or '' when none is needed for this harness.
const CONTEXT_FILENAME = 'AGENTS.md';
const CONTEXT_SHIM = HARNESS === 'claude' ? 'CLAUDE.md' : '';

function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

// Legacy root: parent of the given (or current) workspace; else a configured
// default; else the hardcoded default. A slug makes `{root}/{slug}` correct for
// a workspace that lives outside the current one's parent.
function resolveRoot(slug) {
  if (!slug && process.env[reg.ENV_VAR]) {
    const r = reg.resolve(null);
    if (!r.error) return r.root; // env override still resolves via the ephemeral scan
    return reg.norm(expandTilde(process.env[reg.ENV_VAR]));
  }
  const r = reg.resolve(slug || null);
  if (!r.error) return r.root;
  const cfg = reg.loadPersisted();
  if (cfg.default_root) return reg.norm(expandTilde(cfg.default_root));
  if (cfg.workspace_root) return reg.norm(expandTilde(cfg.workspace_root));
  return reg.DEFAULT_ROOT;
}

function isConfigured() {
  if (process.env[reg.ENV_VAR]) return true;
  const cfg = reg.loadPersisted();
  return (cfg.workspaces && cfg.workspaces.length > 0) || !!cfg.default_root || !!cfg.workspace_root;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = argv[0];
  const wsFlag = (() => {
    const eq = argv.find((a) => a.startsWith('--workspace='));
    return eq ? eq.slice('--workspace='.length) : null;
  })();
  if (!arg || arg === '--get') { process.stdout.write(resolveRoot(wsFlag) + '\n'); process.exit(0); }
  if (arg === '--default')     { process.stdout.write(DEFAULT_WORKSPACE_ROOT + '\n'); process.exit(0); }
  if (arg === '--check')       { process.exit(isConfigured() ? 0 : 2); }
  if (arg === '--config-path') { process.stdout.write(PLUGIN_CONFIG_FILE + '\n'); process.exit(0); }
  if (arg === '--agents-dir')  { process.stdout.write(USER_AGENTS_DIR + '\n'); process.exit(0); }
  if (arg === '--harness')     { process.stdout.write(HARNESS + '\n'); process.exit(0); }
  if (arg === '--context-filename') { process.stdout.write(CONTEXT_FILENAME + '\n'); process.exit(0); }
  if (arg === '--context-shim') {
    // Prints the shim filename to also write (CLAUDE.md under Claude Code),
    // or nothing when this harness needs no shim.
    if (CONTEXT_SHIM) process.stdout.write(CONTEXT_SHIM + '\n');
    process.exit(0);
  }
  if (arg.startsWith('--set=')) {
    const raw = arg.slice('--set='.length).trim();
    if (!raw) { process.stderr.write('[workspace-root] --set= requires a path\n'); process.exit(1); }
    const resolved = reg.norm(path.resolve(expandTilde(raw)));
    const cfg = reg.loadPersisted();
    cfg.default_root = raw;           // preserve the user's ~-form as the creation dir
    for (const ws of reg.scanRoot(resolved)) reg.upsert(cfg, ws.path, false); // adopt existing
    if (!cfg.current && cfg.workspaces.length === 1) cfg.current = cfg.workspaces[0].slug;
    reg.writeConfig(cfg);
    process.stdout.write(resolved + '\n');
    process.exit(0);
  }
  process.stderr.write(`Unknown argument: ${arg}\n`);
  process.stderr.write('Usage: workspace-root.js [--get|--default|--check|--config-path|--agents-dir|--harness|--context-filename|--context-shim|--set=<path>]\n');
  process.exit(1);
}

module.exports = {
  resolveRoot,
  isConfigured,
  detectHarness: reg.detectHarness,
  HARNESS,
  DEFAULT_WORKSPACE_ROOT,
  PLUGIN_CONFIG_FILE,
  USER_AGENTS_DIR,
  CONTEXT_FILENAME,
  CONTEXT_SHIM,
};
