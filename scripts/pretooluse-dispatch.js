#!/usr/bin/env node
'use strict';
/**
 * pretooluse-dispatch.js — the SINGLE PreToolUse hook the PipeCrew plugin
 * registers (see .claude-plugin/hooks/hooks.json).
 *
 * WHY: PipeCrew has two PreToolUse concerns — the /troubleshoot read-only guard
 * (DENY) and the /deliver --auto-approve helper (ALLOW). Registering them as two
 * separate hooks meant every Bash dispatch spawned TWO node processes even when
 * idle. This dispatcher reads the hook payload ONCE and routes to the right
 * module, so a Bash call now costs ONE node process instead of two, and Edit/
 * Write still cost one.
 *
 * The two concerns are gated on mutually-exclusive markers (a /troubleshoot run
 * vs a /deliver --auto-approve run), so at most one branch ever acts. When
 * neither marker is active — the overwhelmingly common case — this is a fast
 * no-op that exits 0 and leaves normal permission flow untouched.
 *
 * The actual logic lives in the two modules (each still standalone + unit-tested);
 * this file is only the read-once + route shim.
 *
 *   troubleshoot guard  → DENY via exit 1 + stderr reason (Bash only)
 *   deliver auto-approve → ALLOW via {permissionDecision:"allow"} on stdout
 *   otherwise            → exit 0, no output (normal permission prompt)
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const guard = require('./troubleshooter-bash-guard.js');
const autoapprove = require('./deliver-autoapprove-hook.js');

// ── Read the PreToolUse payload from stdin, once ────────────────────────────
let payload;
try {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw.startsWith('{')) process.exit(0);
  payload = JSON.parse(raw);
} catch (_) { process.exit(0); }

if (!payload || payload.hook_event_name !== 'PreToolUse' || typeof payload.tool_name !== 'string') process.exit(0);

// ── 1) /troubleshoot read-only guard (DENY) — Bash only, when a run is live ──
if (payload.tool_name === 'Bash' && guard.markerActive()) {
  const command = payload.tool_input && typeof payload.tool_input.command === 'string'
    ? payload.tool_input.command : '';
  const { allow, reason } = guard.classifyCommand(command);
  if (!allow) {
    console.error(`DENY: ${reason}`);
    console.error(`  command: ${command}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── 2) /deliver --auto-approve helper (ALLOW) — when a run is active ─────────
const marker = autoapprove.activeMarker();
if (marker) {
  const res = autoapprove.classifyToolCall(payload);
  if (res.decision === 'allow') {
    process.stdout.write(autoapprove.allowOutput(
      `pipecrew /deliver auto-approve: ${res.label} (run ${marker.run_id || '?'})`));
    process.exit(0);
  }
}

// ── 3) Neither active (or deferred) → normal permission flow ────────────────
process.exit(0);
