#!/usr/bin/env node
/**
 * PipeCrew — /sites — list every running site-view server on localhost.
 *
 * Probes ports 5173–5195 via HTTP GET /state. Any server that answers with
 * a PipeCrew-shaped JSON ({ workspace, runId, characters: [...] }) is listed
 * with port, PID (best effort per platform), workspace, run-id, character
 * count, and awaiting-input flag.
 *
 * Zero dependencies — pure Node stdlib. Cross-platform (Windows / macOS / Linux).
 *
 * Usage:  node scan.js [--from=5173] [--to=5195] [--timeout-ms=600]
 */

const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

// ─── CLI args ────────────────────────────────────────────────
let fromPort = 5173;
let toPort = 5195;
let timeoutMs = 600;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--from=')) fromPort = parseInt(arg.slice('--from='.length), 10);
  else if (arg.startsWith('--to=')) toPort = parseInt(arg.slice('--to='.length), 10);
  else if (arg.startsWith('--timeout-ms=')) timeoutMs = parseInt(arg.slice('--timeout-ms='.length), 10);
}
if (!Number.isFinite(fromPort) || !Number.isFinite(toPort) || fromPort > toPort) {
  console.error('Invalid port range. Use --from=<N> --to=<N> where from ≤ to.');
  process.exit(1);
}

// ─── Probe one port ──────────────────────────────────────────
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/state', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const state = JSON.parse(data);
            // PipeCrew site-view shape: has runId key and characters array
            if (
              state &&
              Object.prototype.hasOwnProperty.call(state, 'runId') &&
              Array.isArray(state.characters)
            ) {
              resolve({
                port,
                workspace: state.workspace || '—',
                runId: state.runId || '(no run)',
                featureName: state.featureName || '—',
                charCount: state.characters.length,
                hasInput: !!state.awaitingInput,
                updatedAt: state.updatedAt || '—',
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// ─── Lookup PID listening on a port (best-effort per OS) ─────
function getPid(port) {
  try {
    if (os.platform() === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING\\s+(\\d+)`, 'i');
      const m = out.match(re);
      return m ? m[1] : '?';
    } else {
      // Linux / macOS — try lsof first, fall back to ss
      try {
        const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out || '?';
      } catch (e) {
        const out = execSync(`ss -ltnp 2>/dev/null | awk '$4 ~ /:${port}$/ {print $7}'`, {
          encoding: 'utf8',
        }).trim();
        const m = out.match(/pid=(\d+)/);
        return m ? m[1] : '?';
      }
    }
  } catch (e) {
    return '?';
  }
}

// ─── Main ────────────────────────────────────────────────────
(async () => {
  const ports = [];
  for (let p = fromPort; p <= toPort; p++) ports.push(p);
  const results = (await Promise.all(ports.map(probe))).filter(Boolean);

  if (results.length === 0) {
    console.log(`No PipeCrew site-view servers running (scanned ports ${fromPort}–${toPort}).`);
    console.log(`Start one with: /pipecrew:site-view`);
    process.exit(0);
  }

  const plural = results.length === 1 ? '' : 's';
  console.log(`\n${results.length} site-view server${plural} running:\n`);

  // Header
  const headers = ['PORT', 'PID', 'WORKSPACE', 'RUN ID', 'CHARS', 'INPUT', 'FEATURE'];
  const widths = [6, 8, 11, 50, 7, 7, 30];
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(''));
  console.log(widths.map((w) => '-'.repeat(w - 2) + '  ').join(''));

  // Rows
  for (const r of results) {
    const pid = getPid(r.port);
    const row = [
      String(r.port),
      String(pid),
      r.workspace,
      r.runId,
      String(r.charCount),
      r.hasInput ? 'YES' : 'no',
      r.featureName,
    ];
    console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join(''));
  }

  // Summary line
  const awaiting = results.filter((r) => r.hasInput).length;
  if (awaiting > 0) {
    console.log(`\n⏸ ${awaiting} server${awaiting === 1 ? '' : 's'} waiting for user input.`);
  }
  console.log('');
})();
