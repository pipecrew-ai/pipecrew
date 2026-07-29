#!/usr/bin/env node
'use strict';
/**
 * Routing tests for pretooluse-dispatch.js.
 * Zero deps: run with `node pretooluse-dispatch.test.js`.
 *
 * The dispatcher's JOB is to read the payload once and route to the right
 * module by marker. The two modules' own tests (troubleshooter-bash-guard.test,
 * deliver-autoapprove-hook.test) cover the classification logic exhaustively;
 * here we only assert the routing:
 *   - troubleshoot marker live + Bash → guard (allow read / deny mutation)
 *   - deliver marker active + tool    → auto-approve (allow safe / defer risky)
 *   - no marker                       → no-op (exit 0, no output) for anything
 *   - non-PreToolUse / non-JSON       → no-op
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'pretooluse-dispatch.js');
const TS_MARKER = path.join(os.homedir(), '.claude', '.pipecrew-troubleshooter-active');
const AA_MARKER = path.join(os.homedir(), '.claude', '.pipecrew-deliver-autoapprove');

let passed = 0, failed = 0;
function ok(name) { console.log(`  ok - ${name}`); passed++; }
function bad(name, detail) { console.error(`  FAIL - ${name}\n         ${detail}`); failed++; }

// Preserve any real markers so we never clobber a live run.
const savedTs = fs.existsSync(TS_MARKER) ? fs.readFileSync(TS_MARKER, 'utf8') : null;
const savedAa = fs.existsSync(AA_MARKER) ? fs.readFileSync(AA_MARKER, 'utf8') : null;
function restore() {
  for (const [p, v] of [[TS_MARKER, savedTs], [AA_MARKER, savedAa]]) {
    try { fs.unlinkSync(p); } catch (_) {}
    if (v !== null) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); }
  }
}

const tmpRun = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dispatch-run-'));
fs.writeFileSync(path.join(tmpRun, 'scratchpad.md'), '# fresh\n');

function clearMarkers() { try { fs.unlinkSync(TS_MARKER); } catch (_) {} try { fs.unlinkSync(AA_MARKER); } catch (_) {} }
function setTroubleshoot() {
  fs.mkdirSync(path.dirname(TS_MARKER), { recursive: true });
  fs.writeFileSync(TS_MARKER, `pid=${process.pid} run_id=test created_at=${new Date().toISOString()}`);
}
function setDeliver() {
  fs.mkdirSync(path.dirname(AA_MARKER), { recursive: true });
  fs.writeFileSync(AA_MARKER, JSON.stringify({ run_id: 'test', run_dir: tmpRun, created_at: new Date().toISOString() }));
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(tmpRun, 'scratchpad.md'), now, now);
}

function run(payloadObj) {
  const r = spawnSync('node', [SCRIPT], { input: typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj), encoding: 'utf8' });
  return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const tool = (tool_name, tool_input = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const allowed = (r) => r.stdout.includes('"permissionDecision":"allow"');

try {
  // ── No marker: no-op for everything ──────────────────────────────────────
  clearMarkers();
  {
    const r = run(bash('rm -rf /')); // even a mutation is not our business when idle
    (r.exit === 0 && !r.stderr && !r.stdout) ? ok('no marker + bash mutation → no-op') : bad('no marker + bash mutation → no-op', `exit=${r.exit} out=${r.stdout} err=${r.stderr}`);
  }
  {
    const r = run(tool('Edit', { file_path: 'x' }));
    (r.exit === 0 && !allowed(r)) ? ok('no marker + Edit → no-op (not auto-approved)') : bad('no marker + Edit → no-op', `exit=${r.exit} out=${r.stdout}`);
  }

  // ── Troubleshoot marker live + Bash → guard ──────────────────────────────
  clearMarkers(); setTroubleshoot();
  {
    const r = run(bash('git diff main...HEAD'));
    (r.exit === 0) ? ok('troubleshoot live + read Bash → allow (exit 0)') : bad('troubleshoot live + read Bash → allow', `exit=${r.exit} err=${r.stderr}`);
  }
  {
    const r = run(bash('kubectl delete pod foo'));
    (r.exit === 1 && /DENY/.test(r.stderr)) ? ok('troubleshoot live + mutation Bash → deny (exit 1)') : bad('troubleshoot live + mutation → deny', `exit=${r.exit} err=${r.stderr}`);
  }
  {
    // Guard is Bash-only; an Edit during a troubleshoot run is not denied.
    const r = run(tool('Edit', { file_path: 'x' }));
    (r.exit === 0 && !r.stderr) ? ok('troubleshoot live + Edit → no-op (guard is Bash-only)') : bad('troubleshoot live + Edit → no-op', `exit=${r.exit} err=${r.stderr}`);
  }

  // ── Deliver marker active + tool → auto-approve ──────────────────────────
  clearMarkers(); setDeliver();
  {
    const r = run(tool('Edit', { file_path: 'src/Foo.ts' }));
    (r.exit === 0 && allowed(r)) ? ok('deliver active + Edit → auto-approve (allow)') : bad('deliver active + Edit → allow', `exit=${r.exit} out=${r.stdout}`);
  }
  {
    const r = run(bash('npm test'));
    (r.exit === 0 && allowed(r)) ? ok('deliver active + safe Bash → auto-approve (allow)') : bad('deliver active + safe Bash → allow', `exit=${r.exit} out=${r.stdout}`);
  }
  {
    const r = run(bash('rm -rf build'));
    (r.exit === 0 && !allowed(r)) ? ok('deliver active + risky Bash → defer (no allow)') : bad('deliver active + risky Bash → defer', `exit=${r.exit} out=${r.stdout}`);
  }

  // ── Malformed / non-PreToolUse input → no-op ─────────────────────────────
  clearMarkers(); setTroubleshoot();
  {
    const r = run('not json at all');
    (r.exit === 0 && !r.stderr) ? ok('non-JSON stdin → no-op') : bad('non-JSON stdin → no-op', `exit=${r.exit} err=${r.stderr}`);
  }
  {
    const r = run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    (r.exit === 0 && !r.stderr) ? ok('wrong hook_event_name → no-op') : bad('wrong hook_event_name → no-op', `exit=${r.exit} err=${r.stderr}`);
  }
} finally {
  restore();
  try { fs.rmSync(tmpRun, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
