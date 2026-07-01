#!/usr/bin/env node
/**
 * update-check-hook.js — SessionStart hook that nudges the user when a newer
 * PipeCrew release is available.
 *
 * Third-party marketplaces have auto-update OFF by default, and Claude Code has
 * no built-in "update available" banner, so users who don't enable auto-update
 * silently drift behind. This hook closes that gap: at most once per day, it
 * compares the installed plugin version against the latest GitHub Release and,
 * if behind, injects a short SessionStart `additionalContext` note telling the
 * user how to update.
 *
 * Design constraints — this runs on EVERY session start, so it must be:
 *   - throttled  : one network check per 24h (marker in ~/.claude), otherwise a
 *                  no-op that exits immediately;
 *   - fail-silent: any error (offline, rate-limited, parse failure, no releases)
 *                  emits nothing and exits 0 — it must never disrupt a session;
 *   - fast       : the GitHub request has its own short timeout well under the
 *                  hook timeout in hooks.json.
 *
 * Output contract (SessionStart): when an update is found, print a single JSON
 * object with hookSpecificOutput.additionalContext so Claude can relay it. When
 * up to date / throttled / on error, print nothing.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const REPO = 'pipecrew-ai/pipecrew';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const REQUEST_TIMEOUT_MS = 3000;
const MARKER = path.join(os.homedir(), '.claude', '.pipecrew-update-check');

// Always succeed — a hook must never break the session.
function done() { process.exit(0); }

function readInstalledVersion() {
  // Prefer the plugin root Claude Code hands us; fall back to this file's location.
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT,
    path.join(__dirname, '..'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (pj && typeof pj.version === 'string') return pj.version;
    } catch (_) { /* try next */ }
  }
  return null;
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (_) { return {}; }
}
function writeMarker(obj) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify(obj));
  } catch (_) { /* ignore */ }
}

// Parse "1.2.3" (tolerating a leading "v") into comparable [major, minor, patch].
function parseSemver(v) {
  if (!v) return null;
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// > 0 when a is newer than b.
function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

function fetchLatestTag() {
  return new Promise((resolve) => {
    const req = https.get(
      { host: 'api.github.com', path: `/repos/${REPO}/releases/latest`,
        headers: { 'User-Agent': 'pipecrew-update-check', 'Accept': 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body).tag_name || null); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
  });
}

function emitUpdateNotice(installed, latest) {
  const context =
    `[PipeCrew] An update is available: v${latest} (you have v${installed}). ` +
    `To update, tell the user to run:\n` +
    `  /plugin marketplace update pipecrew\n` +
    `  /plugin install pipecrew@pipecrew\n` +
    `  /reload-plugins\n` +
    `Or enable auto-update once: /plugin → Marketplaces → pipecrew → Enable auto-update. ` +
    `Release notes: https://github.com/${REPO}/releases/latest`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

async function main() {
  const installed = readInstalledVersion();
  const installedSv = parseSemver(installed);
  if (!installedSv) return done(); // can't tell what we're on → stay quiet

  const marker = readMarker();
  const now = Date.now();
  if (marker.lastCheck && (now - marker.lastCheck) < CHECK_INTERVAL_MS) return done();

  const latestTag = await fetchLatestTag();
  writeMarker({ lastCheck: now, latest: latestTag || marker.latest || null });
  const latestSv = parseSemver(latestTag);
  if (!latestSv) return done();

  if (cmpSemver(latestSv, installedSv) > 0) {
    emitUpdateNotice(installed, String(latestTag).replace(/^v/i, ''));
  }
  done();
}

// Hard safety net: if anything unexpected throws, exit clean and silent.
main().catch(() => done());
