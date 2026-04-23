#!/usr/bin/env node
/**
 * PipeCrew — /sites-cleanup — kill stale site-view servers.
 *
 * Scans ports 5173–5195 the same way /sites does. Then, based on the
 * preservation flags, kills the stale ones.
 *
 * Flags (at least one kill-mode flag is required; default is --dry-run):
 *   --keep-port=<N>    keep the server on port N
 *   --keep-run=<id>    keep all servers serving this run-id
 *   --keep-latest      keep the server on the highest-numbered port
 *   --all              kill every site-view found
 *   --dry-run          preview (default when no kill flag given)
 *   --from=<N>         scan-range start (default 5173)
 *   --to=<N>           scan-range end (default 5195)
 *
 * Exit codes:
 *   0  success (any number killed, including zero)
 *   1  invalid args
 *   2  no site-view servers found
 */

const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

// ─── CLI args ────────────────────────────────────────────────
let fromPort = 5173;
let toPort = 5195;
let keepPort = null;
let keepRun = null;
let keepLatest = false;
let killAll = false;
let dryRun = false;
let sawKillFlag = false;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--from=')) fromPort = parseInt(arg.slice('--from='.length), 10);
  else if (arg.startsWith('--to=')) toPort = parseInt(arg.slice('--to='.length), 10);
  else if (arg.startsWith('--keep-port=')) { keepPort = parseInt(arg.slice('--keep-port='.length), 10); sawKillFlag = true; }
  else if (arg.startsWith('--keep-run=')) { keepRun = arg.slice('--keep-run='.length); sawKillFlag = true; }
  else if (arg === '--keep-latest') { keepLatest = true; sawKillFlag = true; }
  else if (arg === '--all') { killAll = true; sawKillFlag = true; }
  else if (arg === '--dry-run') { dryRun = true; }
  else { console.error(`Unknown flag: ${arg}`); process.exit(1); }
}
if (!sawKillFlag) dryRun = true;

// Validate mutually-exclusive flags
const kept = [keepPort, keepRun, keepLatest, killAll].filter((v) => v !== null && v !== false).length;
if (kept > 1) {
  console.error('Use only one of: --keep-port, --keep-run, --keep-latest, --all');
  process.exit(1);
}

// ─── Probe one port (mirror of sites/scan.js) ────────────────
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/state', timeout: 600 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const s = JSON.parse(data);
            if (s && Object.prototype.hasOwnProperty.call(s, 'runId') && Array.isArray(s.characters)) {
              resolve({ port, runId: s.runId || '', workspace: s.workspace || '', featureName: s.featureName || '' });
            } else {
              resolve(null);
            }
          } catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function getPid(port) {
  try {
    if (os.platform() === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING\\s+(\\d+)`, 'i');
      const m = out.match(re);
      return m ? m[1] : null;
    } else {
      try {
        const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return out || null;
      } catch (e) {
        const out = execSync(`ss -ltnp 2>/dev/null | awk '$4 ~ /:${port}$/ {print $7}'`, { encoding: 'utf8' }).trim();
        const m = out.match(/pid=(\d+)/);
        return m ? m[1] : null;
      }
    }
  } catch (e) { return null; }
}

function killPid(pid) {
  try {
    if (os.platform() === 'win32') {
      // PowerShell's Stop-Process works where taskkill /F intermittently
      // hits a "timeout period expired" error on Claude-Code-managed procs.
      execSync(`powershell -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, { stdio: 'pipe' });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
    }
    return true;
  } catch (e) { return false; }
}

// ─── Main ────────────────────────────────────────────────────
(async () => {
  const ports = [];
  for (let p = fromPort; p <= toPort; p++) ports.push(p);
  const running = (await Promise.all(ports.map(probe))).filter(Boolean);

  if (running.length === 0) {
    console.log(`No site-view servers running (scanned ${fromPort}–${toPort}).`);
    process.exit(2);
  }

  // Determine which to keep vs kill
  let toKeep = new Set();
  if (killAll) {
    // keep nothing
  } else if (keepPort !== null) {
    toKeep = new Set(running.filter((r) => r.port === keepPort).map((r) => r.port));
  } else if (keepRun) {
    toKeep = new Set(running.filter((r) => r.runId === keepRun).map((r) => r.port));
  } else if (keepLatest) {
    const max = Math.max(...running.map((r) => r.port));
    toKeep = new Set([max]);
  } else {
    // dry-run with no kill flag: keep everything (just report)
    toKeep = new Set(running.map((r) => r.port));
  }

  const kills = running.filter((r) => !toKeep.has(r.port));
  const keeps = running.filter((r) => toKeep.has(r.port));

  console.log(`\n${running.length} site-view server(s) found: ${keeps.length} keep, ${kills.length} kill\n`);

  if (keeps.length > 0) {
    console.log('KEEP:');
    for (const r of keeps) console.log(`  :${r.port}  ${r.runId}`);
    console.log('');
  }
  if (kills.length === 0) {
    console.log('Nothing to kill.');
    process.exit(0);
  }

  console.log(dryRun ? 'WOULD KILL (dry-run):' : 'KILLING:');
  for (const r of kills) {
    const pid = getPid(r.port);
    console.log(`  :${r.port}  ${pid ? 'PID=' + pid : '(no PID)'}  ${r.runId}`);
  }

  if (dryRun) {
    console.log('\nDry-run — no processes were killed. Re-run with --keep-latest, --keep-port=<N>, --keep-run=<id>, or --all to kill.');
    process.exit(0);
  }

  // Do the killing
  let killed = 0;
  for (const r of kills) {
    const pid = getPid(r.port);
    if (pid && killPid(pid)) killed++;
  }

  // Wait a moment, then verify
  await new Promise((r) => setTimeout(r, 250));
  const stillAlive = (await Promise.all(kills.map((r) => probe(r.port)))).filter(Boolean);

  console.log(`\n${killed} killed, ${stillAlive.length} still alive.`);
  if (stillAlive.length > 0) {
    console.log('Still alive (may need manual taskkill):');
    for (const r of stillAlive) console.log(`  :${r.port}  ${r.runId}`);
    process.exit(1);
  }
  process.exit(0);
})();
