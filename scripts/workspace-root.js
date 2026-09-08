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
 * Commands (unchanged surface, plus one optional flag):
 *   --get [--workspace=<slug>]
 *                 parent dir of the given workspace (or the current one). Because
 *                 a workspace lives at <parent>/<slug>, `{that}/{slug}` resolves
 *                 to the workspace regardless of where it sits on disk.
 *   --default     the hardcoded default creation dir
 *   --check       exit 0 if any workspace is registered / a root is set, else 2
 *   --set=<path>  set the default creation dir AND adopt workspaces already under it
 *   --config-path print ~/.claude/pipecrew/config.json
 *
 * Zero dependencies — pure Node stdlib.
 */

const path = require('path');
const reg = require('./workspace-registry');

function expandTilde(p) {
  if (!p) return p;
  const HOME = require('os').homedir();
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
  if (arg === '--default')     { process.stdout.write(reg.DEFAULT_ROOT + '\n'); process.exit(0); }
  if (arg === '--check')       { process.exit(isConfigured() ? 0 : 2); }
  if (arg === '--config-path') { process.stdout.write(reg.CONFIG_FILE + '\n'); process.exit(0); }
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
  process.stderr.write('Usage: workspace-root.js [--get|--default|--check|--config-path|--set=<path>]\n');
  process.exit(1);
}

module.exports = { resolveRoot, isConfigured, DEFAULT_WORKSPACE_ROOT: reg.DEFAULT_ROOT, PLUGIN_CONFIG_FILE: reg.CONFIG_FILE };
