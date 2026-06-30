#!/usr/bin/env node
/**
 * collect-session-feedback.js — extract the human feedback spine from a Claude
 * Code session transcript (.jsonl) and normalize it into a canonical,
 * pre-numbered list the feedback-learner builds its C-n inventory from.
 *
 * WHY A SCRIPT (not inline parsing in the skill): same reason as
 * collect-pr-feedback.js — the /learn completeness guard is only as reliable as
 * the list it validates against. A session transcript is mostly noise
 * (assistant turns, tool results, local-command stdout, system reminders,
 * sub-agent sidechains). If the orchestrator hand-walked the JSONL a real user
 * turn could be missed BEFORE the inventory step runs. This script keeps only
 * genuine human turns, drops the noise into an audit list, and assigns stable
 * ids (C-1, C-2, …) so "did we cover every turn?" is a mechanical count. Same
 * shape family as collect-pr-feedback.js: read → normalize → write a file the
 * agent Reads (the full bodies stay out of orchestrator context).
 *
 * Usage:
 *   node collect-session-feedback.js --session=<path-to.jsonl> [--out=<file>]
 *   node collect-session-feedback.js --session=<session-id> [--projects-dir=<dir>] [--out=<file>]
 *   node collect-session-feedback.js --input=<lines.json> [--out=<file>]   # offline test hook
 *
 * --session : a transcript path (ends .jsonl or contains a path separator), OR a
 *             bare session id resolved against {projects-dir}/{any}/{id}.jsonl.
 *             ('current' is handled by the /learn skill itself, not here.)
 * --projects-dir : override the Claude projects root (default ~/.claude/projects).
 * --out     : write the canonical JSON here + print a one-line summary to stdout.
 *             Omit to print the canonical JSON to stdout instead.
 * --input   : read a JSON array of raw transcript line objects from this file
 *             INSTEAD of touching the filesystem. Lets normalization be
 *             exercised offline (used by the test).
 *
 * Exit 0 success · 1 usage error / file-or-id not found / ambiguous id
 *        · 3 unparseable transcript (no line parsed).
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

// ---- pure normalization (no I/O) — the testable core ------------------------

// A user line whose cleaned text starts with one of these is a slash-command /
// local-command echo, not human feedback.
const COMMAND_WRAPPER_RE =
  /^<(command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat)\b/;

function stripReminders(text) {
  // Harness-injected <system-reminder> blocks are not the user's words.
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Pull the human-authored text out of a user message's `content`.
 * @returns { text, hadText, hadToolResult }
 */
function extractText(content) {
  if (typeof content === 'string') {
    return { text: content, hadText: content.trim().length > 0, hadToolResult: false };
  }
  if (Array.isArray(content)) {
    const texts = [];
    let hadToolResult = false;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'tool_result') hadToolResult = true;
    }
    const text = texts.join('\n').trim();
    return { text, hadText: texts.length > 0, hadToolResult };
  }
  return { text: '', hadText: false, hadToolResult: false };
}

/**
 * @param {object[]} lines parsed transcript line objects, in transcript order
 * @returns canonical { session, counts, comments, excluded }
 */
function normalize(lines) {
  const comments = [];
  const excluded = [];
  let seq = 0;
  let sessionId = null;
  let total = 0;

  const drop = (reason, snippet) =>
    excluded.push({ reason, snippet: (snippet || '').slice(0, 80) });

  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || typeof line !== 'object') continue;
    total++;
    if (!sessionId && line.sessionId) sessionId = line.sessionId;

    // Only user lines are feedback candidates. Everything else (assistant, mode,
    // system, attachment, file, create, …) is skipped silently — counting
    // hundreds of assistant turns as "excluded" would bury the meaningful drops.
    if (line.type !== 'user') continue;

    // Sub-agent traffic and harness-injected meta turns are not the user talking.
    if (line.isSidechain === true) { drop('sidechain'); continue; }
    if (line.isMeta === true) { drop('meta'); continue; }
    if (line.isCompactSummary === true) { drop('compact-summary'); continue; }

    const msg = line.message;
    if (!msg || msg.role !== 'user') { drop('non-user-message'); continue; }

    const { text, hadText, hadToolResult } = extractText(msg.content);
    if (!hadText && hadToolResult) { drop('tool-result'); continue; }
    if (!hadText) { drop('no-text'); continue; }

    const cleaned = stripReminders(text);
    if (!cleaned) { drop('system-reminder', text); continue; }
    if (COMMAND_WRAPPER_RE.test(cleaned)) { drop('local-command', cleaned); continue; }

    seq++;
    comments.push({
      id: `C-${seq}`,
      kind: 'user-turn',
      ts: line.timestamp || null,
      body: cleaned,
    });
  }

  return {
    session: { id: sessionId, path: null, turns: comments.length },
    counts: { signal: comments.length, excluded: excluded.length, lines: total },
    comments,
    excluded,
  };
}

// ---- filesystem helpers (production path) -----------------------------------

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`transcript not readable: ${file} (${e.message})`, 1);
  }
  const out = [];
  let seen = 0;
  for (const ln of raw.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s) continue;
    seen++;
    try {
      out.push(JSON.parse(s));
    } catch {
      // Tolerate an individual malformed line (a trailing partial write is
      // possible on an append-only transcript) — skip it and keep going.
    }
  }
  if (seen > 0 && out.length === 0) {
    fail(`could not parse any JSON line from transcript: ${file}`, 3);
  }
  return out;
}

function resolveSessionFile(value, projectsDirArg) {
  // Explicit transcript path.
  if (value.endsWith('.jsonl') || value.includes('/') || value.includes('\\')) {
    if (!fs.existsSync(value)) fail(`transcript file not found: ${value}`, 1);
    return value;
  }
  // Otherwise treat as a bare session id under the Claude projects root.
  const base = projectsDirArg || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) {
    fail(`Claude projects dir not found: ${base} (pass --projects-dir or a transcript path)`, 1);
  }
  const matches = [];
  for (const d of fs.readdirSync(base)) {
    const f = path.join(base, d, `${value}.jsonl`);
    if (fs.existsSync(f)) matches.push(f);
  }
  if (matches.length === 0) fail(`no transcript found for session id "${value}" under ${base}`, 1);
  if (matches.length > 1) {
    fail(`session id "${value}" is ambiguous — matched ${matches.length} transcripts:\n  ${matches.join('\n  ')}`, 1);
  }
  return matches[0];
}

// ---- main -------------------------------------------------------------------

function main() {
  const out = arg('out');
  const input = arg('input');
  const session = arg('session');
  const projectsDir = arg('projects-dir');

  let lines;
  let sourcePath = null;

  if (input) {
    if (!fs.existsSync(input)) fail(`input file not found: ${input}`, 1);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
    } catch (e) {
      fail(`could not parse --input as JSON: ${e.message}`, 3);
    }
    lines = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.lines) ? parsed.lines : null);
    if (!lines) fail('--input must be a JSON array of transcript line objects (or { "lines": [...] })', 1);
  } else if (session) {
    if (session === 'current') {
      fail("'--session=current' is handled by the /learn skill, not this collector — pass a transcript path or a session id.", 1);
    }
    sourcePath = resolveSessionFile(session, projectsDir);
    lines = readJsonl(sourcePath);
  } else {
    fail('usage: collect-session-feedback.js --session=<path|id> | --input=<lines.json> [--projects-dir=<dir>] [--out=<file>]', 1);
  }

  const result = normalize(lines);
  if (sourcePath) result.session.path = sourcePath;
  const json = JSON.stringify(result);

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    const c = result.counts;
    const range = c.signal > 0 ? ` (C-1..C-${c.signal})` : '';
    console.log(
      `wrote ${c.signal} user turns${range} to ${out} ` +
      `[excluded=${c.excluded} non-feedback, scanned=${c.lines} lines]`
    );
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
} else {
  module.exports = { normalize, extractText, stripReminders, resolveSessionFile };
}
