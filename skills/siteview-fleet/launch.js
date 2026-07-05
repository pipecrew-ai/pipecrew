#!/usr/bin/env node
'use strict';
/**
 * launch.js — start the standalone `pipecrew-siteview` fleet dashboard from
 * inside the PipeCrew plugin (the `/pipecrew:siteview-fleet` skill).
 *
 * The fleet view is a SEPARATE tool (npm: pipecrew-siteview) that shows EVERY
 * Claude Code session on the machine — not just the current /deliver run. This
 * launcher resolves wherever it happens to be installed and hands off to it,
 * passing through --port / --projects-dir / --demo / --no-open.
 *
 * Resolution order (first hit wins), so it works whether the user installed it
 * globally, cloned it, or just wants npx to fetch it once published:
 *   1. $PIPECREW_SITEVIEW_DIR/bin/pipecrew-siteview.js   (explicit override)
 *   2. ~/pipecrew-siteview/bin/pipecrew-siteview.js       (conventional clone)
 *   3. a `pipecrew-siteview` binary on PATH                (global npm install)
 *   4. `npx --yes pipecrew-siteview`                       (fetch from npm)
 *
 * Zero dependencies. `--print` resolves and prints the plan without spawning
 * (used by the co-located test). Exit 0 on launch/print; 1 if unresolvable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

// Pure resolver — no spawning, no real FS unless injected. Returns the launch
// plan { kind, cmd, args, note } or null when nothing resolves. Injectable deps
// keep it unit-testable across platforms.
function resolveLaunch(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.homedir || os.homedir();
  const existsSync = opts.existsSync || fs.existsSync;
  const which = opts.which || defaultWhich;
  const bin = 'pipecrew-siteview';
  const relBin = path.join('bin', 'pipecrew-siteview.js');

  const fromDir = (dir, note) => {
    if (!dir) return null;
    const p = path.join(dir, relBin);
    return existsSync(p) ? { kind: 'node', cmd: process.execPath, args: [p], note } : null;
  };

  return (
    fromDir(env.PIPECREW_SITEVIEW_DIR, 'from $PIPECREW_SITEVIEW_DIR') ||
    fromDir(path.join(home, 'pipecrew-siteview'), 'from ~/pipecrew-siteview clone') ||
    (which(bin) ? { kind: 'bin', cmd: which(bin), args: [], note: 'global install on PATH' } : null) ||
    (opts.allowNpx === false ? null : { kind: 'npx', cmd: npxCmd(), args: ['--yes', bin], note: 'via npx (fetched from npm)' })
  );
}

function npxCmd() { return process.platform === 'win32' ? 'npx.cmd' : 'npx'; }
function npmCmd() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

// The command a `--install` opt-in runs. Pure (no spawn) so it's unit-testable.
function npmInstallCmd() { return { cmd: npmCmd(), args: ['install', '-g', 'pipecrew-siteview'] }; }

// Where `npm install -g pipecrew-siteview` puts the bin, so we can launch it
// right after installing even if PATH isn't refreshed in this process.
function globalBinPath() {
  let prefix;
  try { prefix = String(execFileSync(npmCmd(), ['prefix', '-g'], { encoding: 'utf8' })).trim(); }
  catch (_) { return null; }
  if (!prefix) return null;
  return process.platform === 'win32'
    ? path.join(prefix, 'pipecrew-siteview.cmd')
    : path.join(prefix, 'bin', 'pipecrew-siteview');
}

// Look up an executable on PATH without shelling out. Returns the full path or null.
function defaultWhich(name) {
  const env = process.env;
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d, name + e.toLowerCase()) ;
      const fullU = path.join(d, name + e);
      try { if (fs.existsSync(full)) return full; } catch (_) {}
      try { if (fs.existsSync(fullU)) return fullU; } catch (_) {}
    }
  }
  return null;
}

// Passthrough only the flags the standalone understands.
function passthroughArgs(argv) {
  const keep = [];
  for (const a of argv) {
    if (/^--port=/.test(a) || /^--projects-dir=/.test(a) || a === '--demo' || a === '--no-open') keep.push(a);
  }
  return keep;
}

module.exports = { resolveLaunch, passthroughArgs, defaultWhich, npmInstallCmd, globalBinPath };

function launch(plan, extra) {
  const args = plan.args.concat(extra);
  console.log(`Launching pipecrew-siteview fleet view (${plan.note})…`);
  const child = spawn(plan.cmd, args, { stdio: 'inherit', shell: false });
  child.on('error', (e) => {
    console.error('Failed to launch pipecrew-siteview:', e.message);
    console.error('Install it with:  npm install -g pipecrew-siteview');
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code || 0));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes('--print');
  const doInstall = argv.includes('--install');
  const extra = passthroughArgs(argv);

  // Passive by default: only real installs (dir / clone / PATH), never npx or a
  // silent install. The opt-in install is explicit via --install.
  let plan = resolveLaunch({ allowNpx: false });

  if (printOnly) {
    if (plan) console.log(JSON.stringify({ found: true, ...plan, fullArgs: plan.args.concat(extra) }, null, 2));
    else console.log(JSON.stringify({ found: false, wouldInstall: npmInstallCmd() }, null, 2));
    process.exit(0);
  }

  if (!plan && doInstall) {
    const { cmd, args } = npmInstallCmd();
    console.log(`Installing the fleet view:  ${cmd} ${args.join(' ')} …`);
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
    if (r.status !== 0) {
      console.error(`\nnpm install failed (exit ${r.status == null ? '?' : r.status}). ` +
        'The package may not be published to npm yet — clone it to ~/pipecrew-siteview instead.');
      process.exit(1);
    }
    // Re-resolve after install; fall back to the computed global bin path.
    plan = resolveLaunch({ allowNpx: false });
    if (!plan) {
      const gb = globalBinPath();
      if (gb && fs.existsSync(gb)) plan = { kind: 'bin', cmd: gb, args: [], note: 'freshly installed (global prefix)' };
    }
    if (!plan) {
      console.error('Installed, but could not locate the pipecrew-siteview binary. Try running it directly: pipecrew-siteview');
      process.exit(1);
    }
  }

  if (!plan) {
    console.error('pipecrew-siteview (fleet view) is not installed.\n' +
      'Auto-install (opt-in):  re-run this launcher with --install   → runs `npm install -g pipecrew-siteview`\n' +
      'Install yourself:       npm install -g pipecrew-siteview\n' +
      'Or clone to ~/pipecrew-siteview, or set $PIPECREW_SITEVIEW_DIR.');
    process.exit(1);
  }

  launch(plan, extra);
}
