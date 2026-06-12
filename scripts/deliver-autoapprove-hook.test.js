#!/usr/bin/env node
/**
 * Unit tests for deliver-autoapprove-hook.js.
 * Zero deps: run with `node deliver-autoapprove-hook.test.js`.
 *
 * The hook reads a PreToolUse payload on stdin and either:
 *   - ALLOWS  → prints {hookSpecificOutput:{...permissionDecision:"allow"}}
 *   - DEFERS  → prints nothing (normal permission flow)
 * It self-gates on ~/.claude/.pipecrew-deliver-autoapprove pointing at a fresh
 * run dir. The test writes a temp marker + run dir, runs cases, then restores.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'deliver-autoapprove-hook.js');
const MARKER_PATH = path.join(os.homedir(), '.claude', '.pipecrew-deliver-autoapprove');

let passed = 0, failed = 0;

// Preserve any real marker so the test never clobbers a live run.
const hadMarker = fs.existsSync(MARKER_PATH);
const savedMarker = hadMarker ? fs.readFileSync(MARKER_PATH, 'utf8') : null;

const tmpRun = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-aa-run-'));
fs.writeFileSync(path.join(tmpRun, 'scratchpad.md'), '# fresh\n'); // mtime = now → "active"

function setMarker({ fresh = true } = {}) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify({ run_id: 'test', run_dir: tmpRun, created_at: new Date().toISOString() }));
  if (!fresh) {
    const old = Date.now() / 1000 - 7 * 60 * 60; // 7h ago
    fs.utimesSync(path.join(tmpRun, 'scratchpad.md'), old, old);
  } else {
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(tmpRun, 'scratchpad.md'), now, now);
  }
}
function clearMarker() { try { fs.unlinkSync(MARKER_PATH); } catch {} }

function run(payload) {
  const r = spawnSync('node', [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8' });
  const allowed = (r.stdout || '').includes('"permissionDecision":"allow"')
    || (r.stdout || '').includes('"permissionDecision": "allow"');
  return { allowed, stdout: r.stdout || '' };
}
function bash(command) { return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }; }
function tool(tool_name, tool_input = {}) { return { hook_event_name: 'PreToolUse', tool_name, tool_input }; }

function expect(label, payload, wantAllow) {
  const { allowed } = run(payload);
  if (allowed === wantAllow) { passed++; }
  else { failed++; console.error(`FAIL: ${label} — wanted ${wantAllow ? 'ALLOW' : 'DEFER'}, got ${allowed ? 'ALLOW' : 'DEFER'}`); }
}

// ── With a fresh marker ────────────────────────────────────────────────
setMarker({ fresh: true });

// ALLOW: file edits + clearly-safe Bash
expect('Edit tool', tool('Edit', { file_path: 'src/Foo.java' }), true);
expect('Write tool', tool('Write', { file_path: 'src/Bar.ts' }), true);
expect('MultiEdit tool', tool('MultiEdit', { file_path: 'x' }), true);
expect('npm test', bash('npm test'), true);
expect('mvn compile', bash('mvn -q -DskipTests compile'), true);
expect('pytest + ruff chain', bash('pytest -q && ruff check .'), true);
expect('git add + commit', bash('git add -A && git commit -m "x"'), true);
expect('git diff', bash('git diff HEAD'), true);
expect('plugin node script', bash('node /x/pipecrew/scripts/gate.js close --run-dir=/y'), true);
expect('env-prefixed npm', bash('NODE_ENV=test npm run build'), true);

// DEFER: dangerous / outbound / unclassifiable → still prompt
expect('rm -rf', bash('rm -rf build'), false);
expect('git push', bash('git push origin main'), false);
expect('git reset --hard', bash('git reset --hard'), false);
expect('sudo', bash('sudo systemctl restart nginx'), false);
expect('curl POST', bash('curl -X POST https://api.example.com/x'), false);
expect('npm publish', bash('npm publish'), false);
expect('cdk deploy', bash('cdk deploy MyStack'), false);
expect('command substitution', bash('echo $(whoami)'), false);
expect('pipe to sh', bash('echo x | sh'), false);
expect('redirect to device', bash('echo x > /dev/sda'), false);
expect('unknown binary', bash('frobnicate --all'), false);
expect('safe-then-danger chain', bash('npm test && rm -rf node_modules'), false);
expect('Read tool (not auto-approved)', tool('Read', { file_path: 'x' }), false);

// ── Gating: no marker / stale run → defer even for an Edit ──────────────
clearMarker();
expect('Edit with NO marker', tool('Edit', { file_path: 'x' }), false);

setMarker({ fresh: false });
expect('Edit with STALE run', tool('Edit', { file_path: 'x' }), false);

// ── Restore ────────────────────────────────────────────────────────────
clearMarker();
if (hadMarker) fs.writeFileSync(MARKER_PATH, savedMarker);
try { fs.rmSync(tmpRun, { recursive: true, force: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
