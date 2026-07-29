#!/usr/bin/env node
'use strict';
/**
 * deliver-autoapprove-hook.js — opt-in PreToolUse hook that auto-approves the
 * routine, clearly-safe tool calls a `/deliver` run makes, so the user is not
 * prompted dozens of times per implementer for Bash / Edit / Write.
 *
 * This is the ALLOW counterpart to scripts/troubleshooter-bash-guard.js (which
 * DENIES). It is deliberately conservative and FAIL-SAFE:
 *
 *   - It only ever emits `permissionDecision: "allow"` for calls it can prove
 *     are safe (file edits, and Bash commands whose every segment is a known
 *     build/test/local-git/read verb with no dangerous or unclassifiable part).
 *   - For ANYTHING else it emits NOTHING and exits 0, leaving Claude Code's
 *     normal permission prompt intact. So even with auto-approve ON, genuinely
 *     risky commands STILL ask the user.
 *   - On any internal error it emits nothing (normal flow). A bug here can
 *     never auto-approve something; worst case it just doesn't help.
 *
 * USED TWO WAYS:
 *   - Standalone PreToolUse hook (this file's own entry point).
 *   - As a module imported by scripts/pretooluse-dispatch.js, which reads the
 *     hook payload once and routes to classifyToolCall() / activeMarker() so a
 *     single dispatch spawns ONE node process instead of two.
 *
 * OPT-IN VIA MARKER FILE:
 *   No-op unless ~/.claude/.pipecrew-deliver-autoapprove exists AND points at a
 *   currently-active /deliver run. The /deliver skill writes that marker ONLY
 *   when the user passes --auto-approve, and removes it at run_end / interruption
 *   (see scripts/autoapprove-marker.js). "Active" = the run's scratchpad.md /
 *   checkpoints.jsonl touched within FRESH_WINDOW_MS.
 *
 * PreToolUse output contract (current Claude Code):
 *   allow  → {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"..."}}
 *   defer  → no stdout → normal permission flow
 *   exit 0 always (exit 2 would HARD-skip permission flow — we never want that).
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_PATH = path.join(os.homedir(), '.claude', '.pipecrew-deliver-autoapprove');
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — run is "active" if its files were touched within this

// Allowlist of leading verbs a safe Bash segment may start with. (push/force/
// reset --hard/clean are blocked in DANGER; rm is excluded here.)
const SAFE_VERBS = new Set([
  // JVM
  'mvn', 'mvnw', 'gradle', 'gradlew',
  // JS/TS
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'jest', 'vitest', 'eslint', 'prettier', 'biome', 'deno', 'bun',
  // Python
  'pytest', 'python', 'python3', 'pip', 'pip3', 'poetry', 'ruff', 'mypy', 'black', 'isort', 'flake8', 'tox', 'uv',
  // Go / Rust / .NET / Ruby / Elixir
  'go', 'gofmt', 'golangci-lint', 'cargo', 'rustc', 'rustfmt', 'dotnet', 'bundle', 'rake', 'rspec', 'mix',
  // build
  'make', 'cmake',
  // VCS (push/force/reset --hard/clean already blocked below)
  'git',
  // read / text / fs (rm excluded — it's in DANGER)
  'ls', 'cat', 'grep', 'rg', 'ack', 'ag', 'find', 'fd', 'tree', 'head', 'tail', 'wc', 'sort', 'uniq',
  'cut', 'tr', 'sed', 'awk', 'column', 'xargs', 'echo', 'printf', 'pwd', 'cd', 'test', 'true', 'false',
  'env', 'printenv', 'which', 'type', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'diff',
  'comm', 'jq', 'yq', 'mkdir', 'cp', 'mv', 'touch', 'ln', 'stat', 'file', 'tee',
]);

const EVASION = [
  /\$\([^)]*\)/,            // $(...) command substitution
  /`[^`]*`/,               // backtick substitution
  /(?:^|[;|&]\s*)(eval|exec)\s/, // standalone eval/exec
  /\|\s*(sh|bash|zsh)\b/,  // pipe into a shell
  /\bbase64\s+(-d|--decode)\b/,
  />>(?!\s*\/dev\/null\b)/,
  /(^|[^>2])>(?!>|\s*\/dev\/null\b)/,
];

const DANGER = [
  /(^|[\s;|&(])rm\s/, /(^|[\s;|&(])(rmdir|shred|dd|mkfs|fdisk|parted|wipefs)\b/,
  /\bsudo\b/, /\bsu\s+-/,
  /\bgit\s+push\b/, /\bgit\s+\S*\s*--force\b/, /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b/,
  /\b(cdk\s+(deploy|destroy|bootstrap|import)|terraform\s+(apply|destroy|import)|serverless\s+(deploy|remove)|sls\s+(deploy|remove))\b/i,
  /\bkubectl\s+(apply|delete|patch|scale|rollout|exec|drain|cordon|replace)\b/i,
  /\bdocker\s+(push|rmi|rm|system\s+prune|volume\s+rm)\b/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i, /\bcargo\s+publish\b/i, /\bgem\s+push\b/i, /\btwine\s+upload\b/i,
  /\bcurl\b[^|;&]*\s-X\s*(POST|PUT|PATCH|DELETE)\b/i, /\bcurl\b[^|;&]*--request\s+(POST|PUT|PATCH|DELETE)\b/i,
  /\bwget\b[^|;&]*--post-(data|file)\b/i,
  /\b(nc|ncat|netcat|telnet)\b/, /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,
  /\bsystemctl\b/, /(^|[\s;|&])service\s+\S+\s+(start|stop|restart)\b/,
  /\bchmod\s+-R\b/, /\bchown\s+-R\b/, /:\(\)\s*\{/, // fork bomb
];

function leadVerb(segment) {
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  // skip leading ENV=val assignments
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  if (i >= toks.length) return null;
  let v = toks[i];
  v = v.replace(/^.*\//, ''); // strip a leading ./ or path, keep the basename
  return v.toLowerCase();
}

// ── Pure classifier: PreToolUse payload → { decision: 'allow'|'defer', label } ──
// Marker gating is NOT done here (see activeMarker) — this is purely "is this
// call clearly safe to auto-approve?".
function classifyToolCall(payload) {
  const tool = payload && payload.tool_name;

  // File-edit tools: auto-approve. (Under opt-in, editing worktree files is the
  // whole point — these are the bulk of the prompt flood.)
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return { decision: 'allow', label: tool };
  }

  // Only Bash needs classification beyond here.
  if (tool !== 'Bash') return { decision: 'defer' };

  const command = payload.tool_input && typeof payload.tool_input.command === 'string'
    ? payload.tool_input.command : '';
  if (!command.trim()) return { decision: 'defer' };

  const normalized = command.replace(/\s+/g, ' ').trim();

  // 1) Evasion / unclassifiable constructs → defer (let the user decide).
  for (const re of EVASION) if (re.test(normalized)) return { decision: 'defer' };

  // 2) Danger blocklist → NEVER auto-approve (prompt as normal, even in auto mode).
  for (const re of DANGER) if (re.test(normalized)) return { decision: 'defer' };

  // 3) Allowlist — auto-approve only when EVERY command segment leads with a
  //    known-safe verb. Anything else defers to a normal prompt.
  const segments = normalized.split(/\s*(?:&&|\|\||;|\||&)\s*/).filter(Boolean);
  if (segments.length === 0) return { decision: 'defer' };
  for (const seg of segments) {
    const v = leadVerb(seg);
    if (!v || !SAFE_VERBS.has(v)) return { decision: 'defer' };
  }
  return { decision: 'allow', label: 'safe Bash' };
}

function freshest(...files) {
  let newest = 0;
  for (const f of files) {
    try { const m = fs.statSync(f).mtimeMs; if (m > newest) newest = m; } catch (_) { /* ignore */ }
  }
  return newest;
}

// ── Marker gate: returns the marker object when a /deliver --auto-approve run is
//    active, else null (→ normal permission flow). Cleans up a stale marker. ──
function activeMarker() {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); }
  catch (_) { return null; } // no marker (or unreadable) → auto-approve is off

  const runDir = marker && typeof marker.run_dir === 'string' ? marker.run_dir : null;
  if (!runDir) return null;

  const lastActivity = freshest(
    path.join(runDir, 'scratchpad.md'),
    path.join(runDir, 'checkpoints.jsonl'),
  );
  if (!lastActivity || (Date.now() - lastActivity) > FRESH_WINDOW_MS) {
    // Stale / finished run — marker outlived its run. Best-effort clean up.
    try { fs.unlinkSync(MARKER_PATH); } catch (_) { /* ignore */ }
    return null;
  }
  return marker;
}

// Build the allow-decision stdout payload.
function allowOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  });
}

module.exports = { classifyToolCall, activeMarker, allowOutput, MARKER_PATH, FRESH_WINDOW_MS };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const defer = () => process.exit(0);

  let payload;
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw.startsWith('{')) defer();
    payload = JSON.parse(raw);
  } catch (_) { defer(); }

  if (!payload || payload.hook_event_name !== 'PreToolUse' || typeof payload.tool_name !== 'string') defer();

  const marker = activeMarker();
  if (!marker) defer();

  const res = classifyToolCall(payload);
  if (res.decision === 'allow') {
    process.stdout.write(allowOutput(`pipecrew /deliver auto-approve: ${res.label} (run ${marker.run_id || '?'})`));
    process.exit(0);
  }
  defer();
}
