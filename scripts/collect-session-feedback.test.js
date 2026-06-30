#!/usr/bin/env node
/**
 * Unit tests for collect-session-feedback.js.
 * Zero deps: run with `node collect-session-feedback.test.js`.
 *
 * The filesystem path (reading a real ~/.claude/projects transcript) is exercised
 * via a temp transcript + --projects-dir override. The normalization core — where
 * stable-id assignment, ordering, and noise filtering live — is driven through the
 * `--input=<lines.json>` hook and tested directly via module.exports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'collect-session-feedback.js');
const { normalize, extractText, stripReminders } = require('./collect-session-feedback.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-session-feedback-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;
function writeLines(lines) {
  const filePath = path.join(TMP, `lines-${counter++}.json`);
  fs.writeFileSync(filePath, JSON.stringify(lines));
  return filePath;
}

function runInput(lines, ...extra) {
  const file = writeLines(lines);
  const r = spawnSync('node', [SCRIPT, `--input=${file}`, ...extra], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- fixtures ---------------------------------------------------------------

// A realistic mix: meta lines, real user turns, an assistant turn, a tool-result
// user message, a local-command echo, a system-reminder-only turn, and a
// sub-agent sidechain user line.
function sampleLines() {
  return [
    { type: 'mode', mode: 'normal', sessionId: 'S1' },
    { type: 'permission-mode', permissionMode: 'default', sessionId: 'S1' },
    // real user turn (string content)
    { type: 'user', sessionId: 'S1', timestamp: '2026-07-01T10:00:00Z',
      message: { role: 'user', content: 'we always want a modal, not a separate route' } },
    // assistant turn — not a candidate
    { type: 'assistant', sessionId: 'S1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] } },
    // tool-result user message — excluded
    { type: 'user', sessionId: 'S1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    // real user turn carrying a leading system-reminder that must be stripped
    { type: 'user', sessionId: 'S1', timestamp: '2026-07-01T10:05:00Z',
      message: { role: 'user', content: '<system-reminder>ambient</system-reminder>\nnever split publisher modules' } },
    // system-reminder-ONLY user turn — excluded
    { type: 'user', sessionId: 'S1',
      message: { role: 'user', content: '<system-reminder>just context</system-reminder>' } },
    // local-command echo — excluded
    { type: 'user', sessionId: 'S1',
      message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' } },
    // sub-agent sidechain user line — excluded
    { type: 'user', sessionId: 'S1', isSidechain: true,
      message: { role: 'user', content: 'sub-agent prompt' } },
    // compact summary user line — excluded
    { type: 'user', sessionId: 'S1', isCompactSummary: true,
      message: { role: 'user', content: 'big summary blob' } },
    // real user turn (array content with a text block)
    { type: 'user', sessionId: 'S1', timestamp: '2026-07-01T10:10:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'prefer Specification queries over raw JPQL' }] } },
  ];
}

// ---- normalize() core -------------------------------------------------------

test('keeps only genuine user turns, numbers them C-1..C-n in transcript order', () => {
  const r = normalize(sampleLines());
  assert(r.comments.length === 3, `expected 3 user turns, got ${r.comments.length}`);
  assert(r.comments.map((c) => c.id).join(',') === 'C-1,C-2,C-3', 'ids not sequential');
  assert(r.comments[0].body.includes('modal'), 'turn 1 wrong / out of order');
  assert(r.comments[1].body === 'never split publisher modules', 'reminder not stripped from turn 2');
  assert(r.comments[2].body.includes('Specification'), 'array-content turn not captured');
});

test('every comment is kind user-turn and carries its timestamp', () => {
  const r = normalize(sampleLines());
  assert(r.comments.every((c) => c.kind === 'user-turn'), 'wrong kind');
  assert(r.comments[0].ts === '2026-07-01T10:00:00Z', 'timestamp not carried');
});

test('routes tool-results / reminders / local-commands / sidechain / compact into excluded', () => {
  const r = normalize(sampleLines());
  const reasons = r.excluded.map((e) => e.reason).sort();
  assert(reasons.includes('tool-result'), 'tool-result not excluded');
  assert(reasons.includes('system-reminder'), 'reminder-only not excluded');
  assert(reasons.includes('local-command'), 'local-command not excluded');
  assert(reasons.includes('sidechain'), 'sidechain not excluded');
  assert(reasons.includes('compact-summary'), 'compact summary not excluded');
});

test('assistant + mode lines are skipped silently, not counted as excluded', () => {
  const r = normalize(sampleLines());
  // 5 dropped user lines above; assistant/mode lines must NOT inflate this.
  assert(r.counts.excluded === 5, `expected 5 excluded user turns, got ${r.counts.excluded}`);
});

test('captures sessionId from the transcript', () => {
  const r = normalize(sampleLines());
  assert(r.session.id === 'S1', `session id wrong: ${r.session.id}`);
  assert(r.session.turns === 3, 'turns count wrong');
});

test('id assignment is deterministic across repeated runs', () => {
  const a = normalize(sampleLines());
  const b = normalize(sampleLines());
  assert(JSON.stringify(a.comments) === JSON.stringify(b.comments), 'non-deterministic output');
});

test('empty / non-array input yields zero comments, not a crash', () => {
  assert(normalize([]).comments.length === 0, 'empty array handling wrong');
  assert(normalize(null).comments.length === 0, 'null handling wrong');
});

// ---- helpers ----------------------------------------------------------------

test('stripReminders removes system-reminder blocks anywhere in the text', () => {
  assert(stripReminders('<system-reminder>x</system-reminder>\nhello') === 'hello');
  assert(stripReminders('a<system-reminder>x</system-reminder>b').replace(/\s/g, '') === 'ab');
});

test('extractText pulls text blocks and flags tool-result-only content', () => {
  assert(extractText('hi').hadText === true);
  const tr = extractText([{ type: 'tool_result', content: 'x' }]);
  assert(tr.hadText === false && tr.hadToolResult === true, 'tool-result detection wrong');
});

// ---- CLI surface ------------------------------------------------------------

test('CLI: --input + --out writes canonical JSON and prints a one-line summary', () => {
  const file = writeLines(sampleLines());
  const outPath = path.join(TMP, 'out.json');
  const r = spawnSync('node', [SCRIPT, `--input=${file}`, `--out=${outPath}`], { encoding: 'utf8' });
  assert(r.status === 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert(r.stdout.trim().split('\n').length === 1, 'summary should be one line');
  assert(r.stdout.includes('C-1..C-3'), `summary missing id range: ${r.stdout}`);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert(written.comments.length === 3, 'written file comment count wrong');
});

test('CLI: --input without --out prints canonical JSON to stdout', () => {
  const r = runInput(sampleLines());
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.comments[0].id === 'C-1', 'stdout JSON malformed');
});

test('CLI: --session resolves a real .jsonl transcript path', () => {
  const jsonl = sampleLines().map((l) => JSON.stringify(l)).join('\n') + '\n';
  const tFile = path.join(TMP, 'real-transcript.jsonl');
  fs.writeFileSync(tFile, jsonl);
  const r = spawnSync('node', [SCRIPT, `--session=${tFile}`], { encoding: 'utf8' });
  assert(r.status === 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.comments.length === 3, 'transcript path parse wrong');
  assert(out.session.path === tFile, 'session.path not set');
});

test('CLI: --session resolves a bare session id under --projects-dir', () => {
  const projDir = path.join(TMP, 'projects');
  const sub = path.join(projDir, 'some-encoded-cwd');
  fs.mkdirSync(sub, { recursive: true });
  const jsonl = sampleLines().map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(sub, 'ABC-123.jsonl'), jsonl);
  const r = spawnSync('node', [SCRIPT, '--session=ABC-123', `--projects-dir=${projDir}`], { encoding: 'utf8' });
  assert(r.status === 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert(JSON.parse(r.stdout).comments.length === 3, 'id resolution parse wrong');
});

test('CLI: exit 1 when a session id is not found', () => {
  const projDir = path.join(TMP, 'projects');
  const r = spawnSync('node', [SCRIPT, '--session=does-not-exist', `--projects-dir=${projDir}`], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

test('CLI: exit 1 when --session=current (handled by the skill, not the collector)', () => {
  const r = spawnSync('node', [SCRIPT, '--session=current'], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

test('CLI: exit 1 on usage error (no source args)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

test('CLI: exit 3 on malformed --input JSON', () => {
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{ not valid json ');
  const r = spawnSync('node', [SCRIPT, `--input=${bad}`], { encoding: 'utf8' });
  assert(r.status === 3, `expected 3, got ${r.status}`);
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
