#!/usr/bin/env node
/**
 * notify-hook.js — Claude Code hook wired into Notification / UserPromptSubmit /
 * PostToolUse events, configured in ~/.claude/settings.json.
 *
 * Purpose: when Claude Code pauses for user permission on a tool call, the user
 * often misses the inline prompt if the pipeline-view UI is on a second monitor.
 * This hook writes/clears `awaiting_claude_approval.json` in every ACTIVE run
 * dir so the UI can surface a banner + audible beep — the same way it handles
 * the pipeline's own gate.js gates.
 *
 * Usage (invoked by Claude Code, not manually):
 *   node notify-hook.js on-notification     # called on Notification event
 *   node notify-hook.js clear               # called on UserPromptSubmit / PostToolUse
 *
 * Stdin: Claude Code passes a JSON payload we parse opportunistically for
 *   { tool_name, tool_input, message, ... }. We only use fields for the
 *   banner preview; missing fields fall back to generic text.
 *
 * An "active" run dir = any run dir under ~/.claude/workspaces/<slug>/runs/feature/
 * whose scratchpad.md was modified in the last 60 minutes. This matches the
 * pipeline-view server's auto-detect heuristic.
 *
 * File shape written:
 *   {
 *     "since":           "2026-04-16T11:30:00Z",
 *     "tool":            "Bash",
 *     "command_preview": "mvn test -Dexclude=<glob>/integration/<glob>",
 *     "message":         "Claude needs permission to run this Bash command"
 *   }
 *
 * The hook must exit 0 unconditionally — any failure here should NOT block
 * Claude Code's normal flow. All errors are swallowed silently (or logged to
 * stderr only when CLAUDE_DEBUG=1).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ACTION = process.argv[2] || 'on-notification';
const HOME = os.homedir();
const WS_DIR = path.join(HOME, '.claude', 'workspaces');
const FLAG_NAME = 'awaiting_claude_approval.json';
const HOOK_ERROR_NAME = 'hook_error.json';
const GLOBAL_HOOK_ERROR_LOG = path.join(HOME, '.claude', 'logs', 'pipeline-view-hook-errors.log');
const ACTIVE_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const MAX_ERRORS_KEPT = 3;

function debug(msg) {
  if (process.env.CLAUDE_DEBUG === '1') {
    try { fs.appendFileSync(path.join(HOME, '.claude', 'notify-hook.log'),
      `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
  }
}

// Persist a hook-level error so the pipeline-view UI can surface it.
// Strategy: if we can identify one or more active run dirs, write / rotate a
// `hook_error.json` inside each one (cap of MAX_ERRORS_KEPT entries). If we
// can't find any, append a single-line JSON record to the global fallback log.
function recordHookError(err, context) {
  const entry = {
    ts: new Date().toISOString(),
    error: err && err.message ? err.message : String(err),
    context: context || null,
  };
  let dirs = [];
  try { dirs = activeRunDirs(); } catch (_) { /* runs listing itself blew up */ }
  if (dirs.length === 0) {
    try {
      fs.mkdirSync(path.dirname(GLOBAL_HOOK_ERROR_LOG), { recursive: true });
      // Keep the global log bounded — read last N-1 then append.
      let existing = [];
      if (fs.existsSync(GLOBAL_HOOK_ERROR_LOG)) {
        existing = fs.readFileSync(GLOBAL_HOOK_ERROR_LOG, 'utf8').split('\n').filter(Boolean);
      }
      existing.push(JSON.stringify(entry));
      const trimmed = existing.slice(-MAX_ERRORS_KEPT);
      fs.writeFileSync(GLOBAL_HOOK_ERROR_LOG, trimmed.join('\n') + '\n');
    } catch (_) {}
    return;
  }
  for (const d of dirs) {
    const p = path.join(d, HOOK_ERROR_NAME);
    let payload = { errors: [] };
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && Array.isArray(parsed.errors)) payload = parsed;
      }
    } catch (_) { /* corrupt file — overwrite */ }
    payload.errors.push(entry);
    // Rotate — keep only the most recent MAX_ERRORS_KEPT.
    payload.errors = payload.errors.slice(-MAX_ERRORS_KEPT);
    try { fs.writeFileSync(p, JSON.stringify(payload, null, 2)); } catch (_) {}
  }
}

function readStdinSync() {
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return buf || '';
  } catch (_) {
    return '';
  }
}

function activeRunDirs() {
  const out = [];
  if (!fs.existsSync(WS_DIR)) return out;
  const now = Date.now();
  let workspaces;
  try { workspaces = fs.readdirSync(WS_DIR); } catch (_) { return out; }
  for (const slug of workspaces) {
    const featureDir = path.join(WS_DIR, slug, 'runs', 'feature');
    if (!fs.existsSync(featureDir)) continue;
    let runs;
    try { runs = fs.readdirSync(featureDir); } catch (_) { continue; }
    for (const runId of runs) {
      const runDir = path.join(featureDir, runId);
      const scratchpad = path.join(runDir, 'scratchpad.md');
      if (!fs.existsSync(scratchpad)) continue;
      try {
        const mtime = fs.statSync(scratchpad).mtimeMs;
        if (now - mtime <= ACTIVE_WINDOW_MS) out.push(runDir);
      } catch (_) {}
    }
  }
  return out;
}

function extractPreview(payload) {
  // Best-effort extraction of the tool + command summary from the notification
  // payload. Claude Code's Notification event schema isn't strictly documented,
  // so we probe several fields.
  const out = { tool: null, command_preview: null, message: null };
  if (!payload || typeof payload !== 'object') return out;
  if (payload.tool_name) out.tool = payload.tool_name;
  if (payload.message) out.message = String(payload.message).slice(0, 400);
  if (payload.tool_input) {
    const ti = payload.tool_input;
    if (typeof ti === 'object') {
      // Bash commands carry .command; Write/Edit carry .file_path.
      if (ti.command)      out.command_preview = String(ti.command).slice(0, 240);
      else if (ti.file_path) out.command_preview = String(ti.file_path).slice(0, 240);
      else {
        try { out.command_preview = JSON.stringify(ti).slice(0, 240); } catch (_) {}
      }
    } else if (typeof ti === 'string') {
      out.command_preview = ti.slice(0, 240);
    }
  }
  return out;
}

function onNotification() {
  const raw = readStdinSync();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch (e) {
      // Malformed JSON on stdin isn't fatal — we treat the raw string as a
      // message. Still record the parse failure for UI surfacing so the user
      // knows their hook had a hiccup.
      try { recordHookError(e, { stage: 'stdin-parse', raw_preview: raw.slice(0, 120) }); } catch (_) {}
      payload = { message: raw.slice(0, 400) };
    }
  }
  // Claude Code fires Notification for several reasons. We only care about the
  // "waiting for permission" variant. The message text is the most reliable
  // signal; fall back to always-write if we can't tell (better false-positive
  // than miss the real case).
  const msg = payload && payload.message ? String(payload.message).toLowerCase() : '';
  const isPermissionPrompt =
    msg.includes('permission') ||
    msg.includes('approval') ||
    msg.includes('waiting for') ||
    msg.includes('needs your');

  // If we can't decide, default to writing the flag — the UI will clear it as
  // soon as the user responds (UserPromptSubmit / PostToolUse hooks below).
  if (msg && !isPermissionPrompt) {
    debug(`skip non-permission notification: ${msg.slice(0, 80)}`);
    return;
  }

  const preview = extractPreview(payload);
  const flag = {
    since: new Date().toISOString(),
    tool: preview.tool || 'tool',
    command_preview: preview.command_preview || '',
    message: preview.message || 'Claude Code is waiting for your approval',
  };
  const dirs = activeRunDirs();
  debug(`on-notification: ${dirs.length} active run(s), tool=${flag.tool}`);
  if (dirs.length === 0) {
    // No active runs — not strictly an error, but we want the UI to know when
    // the hook fired-but-found-nothing if a user is debugging. Only surface
    // via global log, not as a per-run error.
    return;
  }
  for (const d of dirs) {
    try { fs.writeFileSync(path.join(d, FLAG_NAME), JSON.stringify(flag, null, 2)); }
    catch (e) {
      debug(`write fail ${d}: ${e.message}`);
      try { recordHookError(e, { stage: 'flag-write', run_dir: d }); } catch (_) {}
    }
  }
}

function clear() {
  const dirs = activeRunDirs();
  let cleared = 0;
  for (const d of dirs) {
    const p = path.join(d, FLAG_NAME);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); cleared++; } catch (_) {}
    }
  }
  debug(`clear: removed ${cleared} flag(s)`);
}

try {
  if (ACTION === 'on-notification') onNotification();
  else if (ACTION === 'clear') clear();
  else debug(`unknown action: ${ACTION}`);
} catch (e) {
  debug(`unhandled: ${e.message}`);
  try { recordHookError(e, { action: ACTION }); } catch (_) {}
}
// Always exit 0 — don't break Claude Code's flow on hook error.
process.exit(0);
