#!/usr/bin/env node
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
 *   - For ANYTHING else — a dangerous command, an unknown binary, shell
 *     substitution it can't statically read — it emits NOTHING and exits 0,
 *     which leaves Claude Code's normal permission prompt intact. So even with
 *     auto-approve ON, genuinely risky commands STILL ask the user.
 *   - On any internal error it emits nothing (normal flow). A bug here can
 *     never auto-approve something; worst case it just doesn't help.
 *
 * OPT-IN VIA MARKER FILE:
 *   The hook is registered globally (fires on every Bash/Edit/Write in the
 *   session), but it is a no-op unless ~/.claude/.pipecrew-deliver-autoapprove
 *   exists AND points at a currently-active /deliver run. The /deliver skill
 *   writes that marker ONLY when the user passes --auto-approve, and removes it
 *   at run_end / interruption (see scripts/autoapprove-marker.js). "Active" is
 *   verified by the run's scratchpad.md / checkpoints.jsonl having been touched
 *   within FRESH_WINDOW_MS — so a crashed run whose marker was never cleaned up
 *   ages out and stops auto-approving (same self-gating idea as notify-hook).
 *
 * PreToolUse output contract (current Claude Code):
 *   allow  → {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"..."}}
 *   defer  → no stdout (or permissionDecision:"defer") → normal permission flow
 *   exit 0 always (exit 2 would HARD-skip permission flow — we never want that).
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_PATH = path.join(os.homedir(), '.claude', '.pipecrew-deliver-autoapprove');
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — run is "active" if its files were touched within this

// Always end the process without disturbing normal flow.
function defer() { process.exit(0); }

function allow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// ── Read the PreToolUse payload from stdin ─────────────────────────────
let payload;
try {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw.startsWith('{')) defer();
  payload = JSON.parse(raw);
} catch { defer(); }

if (!payload || payload.hook_event_name !== 'PreToolUse' || typeof payload.tool_name !== 'string') defer();

// ── Marker-file self-gating ────────────────────────────────────────────
let marker;
try { marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); }
catch { defer(); } // no marker (or unreadable) → auto-approve is off → normal flow

const runDir = marker && typeof marker.run_dir === 'string' ? marker.run_dir : null;
if (!runDir) defer();

function freshest(...files) {
  let newest = 0;
  for (const f of files) {
    try { const m = fs.statSync(f).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
  }
  return newest;
}
const lastActivity = freshest(
  path.join(runDir, 'scratchpad.md'),
  path.join(runDir, 'checkpoints.jsonl'),
);
if (!lastActivity || (Date.now() - lastActivity) > FRESH_WINDOW_MS) {
  // Stale / finished run — marker outlived its run. Best-effort clean up, defer.
  try { fs.unlinkSync(MARKER_PATH); } catch { /* ignore */ }
  defer();
}

// ── Classify the tool call ─────────────────────────────────────────────
const tool = payload.tool_name;

// File-edit tools: auto-approve. (Under opt-in, editing worktree files is the
// whole point — these are the bulk of the prompt flood.)
if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
  allow(`pipecrew /deliver auto-approve: ${tool} (run ${marker.run_id || '?'})`);
}

// Only Bash needs classification beyond here.
if (tool !== 'Bash') defer();

const command = payload.tool_input && typeof payload.tool_input.command === 'string'
  ? payload.tool_input.command : '';
if (!command.trim()) defer();

const normalized = command.replace(/\s+/g, ' ').trim();

// 1) Evasion / unclassifiable constructs → defer (let the user decide).
const EVASION = [
  /\$\([^)]*\)/,            // $(...) command substitution
  /`[^`]*`/,               // backtick substitution
  /(?:^|[;|&]\s*)(eval|exec)\s/, // standalone eval/exec
  /\|\s*(sh|bash|zsh)\b/,  // pipe into a shell
  /\bbase64\s+(-d|--decode)\b/,
  // Any output redirect EXCEPT to /dev/null → defer (implementers write files
  // via the Edit/Write tools, not raw shell redirects; a `>` to a real path is
  // unclassifiable here, so let the user decide).
  />>(?!\s*\/dev\/null\b)/,
  /(^|[^>2])>(?!>|\s*\/dev\/null\b)/,
];
for (const re of EVASION) if (re.test(normalized)) defer();

// 2) Danger blocklist → NEVER auto-approve (prompt as normal, even in auto mode).
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
for (const re of DANGER) if (re.test(normalized)) defer();

// 3) Allowlist — auto-approve only when EVERY command segment leads with a
//    known-safe verb. Anything else defers to a normal prompt.
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
  // VCS (push/force/reset --hard/clean already blocked above)
  'git',
  // read / text / fs (rm excluded — it's in DANGER)
  'ls', 'cat', 'grep', 'rg', 'ack', 'ag', 'find', 'fd', 'tree', 'head', 'tail', 'wc', 'sort', 'uniq',
  'cut', 'tr', 'sed', 'awk', 'column', 'xargs', 'echo', 'printf', 'pwd', 'cd', 'test', 'true', 'false',
  'env', 'printenv', 'which', 'type', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'diff',
  'comm', 'jq', 'yq', 'mkdir', 'cp', 'mv', 'touch', 'ln', 'stat', 'file', 'tee',
]);

function leadVerb(segment) {
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  // skip leading ENV=val assignments
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  if (i >= toks.length) return null;
  let v = toks[i];
  // strip a leading ./ or path, keep the basename
  v = v.replace(/^.*\//, '');
  return v.toLowerCase();
}

const segments = normalized.split(/\s*(?:&&|\|\||;|\||&)\s*/).filter(Boolean);
if (segments.length === 0) defer();
for (const seg of segments) {
  const v = leadVerb(seg);
  if (!v || !SAFE_VERBS.has(v)) defer(); // unknown verb anywhere → normal prompt
}

allow(`pipecrew /deliver auto-approve: safe Bash (run ${marker.run_id || '?'})`);
