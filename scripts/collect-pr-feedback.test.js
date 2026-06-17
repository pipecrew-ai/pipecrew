#!/usr/bin/env node
/**
 * Unit tests for collect-pr-feedback.js.
 * Zero deps: run with `node collect-pr-feedback.test.js`.
 *
 * The `gh` fetch path is not exercised (it needs network + auth). Instead we
 * drive the script through its `--input=<bundle.json>` hook, which feeds a raw
 * { prView, inlineComments, conversationComments, reviewThreads } bundle
 * straight into the pure normalize() core — the part where stable-id assignment,
 * ordering, and noise filtering actually live. normalize/isNoise/parsePrUrl are
 * also tested directly via module.exports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'collect-pr-feedback.js');
const { normalize, isNoise, parsePrUrl } = require('./collect-pr-feedback.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-pr-feedback-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;
function writeBundle(bundle) {
  const filePath = path.join(TMP, `bundle-${counter++}.json`);
  fs.writeFileSync(filePath, JSON.stringify(bundle));
  return filePath;
}

function runInput(bundle, ...extra) {
  const file = writeBundle(bundle);
  const r = spawnSync('node', [SCRIPT, `--input=${file}`, ...extra], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- fixtures ---------------------------------------------------------------

function sampleBundle() {
  return {
    repo: 'org/repo',
    number: 31,
    prView: {
      title: 'Bulk content-rating tasks',
      state: 'MERGED',
      merged: true,
      headRefName: 'feature/l2-bulk-tasks-review',
      reviews: [
        { author: { login: 'alice' }, authorAssociation: 'MEMBER', state: 'CHANGES_REQUESTED',
          submittedAt: '2026-06-10T10:00:00Z', body: 'Overall looks good, a few things.' },
        { author: { login: 'alice' }, authorAssociation: 'MEMBER', state: 'APPROVED',
          submittedAt: '2026-06-11T10:00:00Z', body: '' }, // empty → dropped
      ],
    },
    inlineComments: [
      { id: 1001, user: { login: 'alice' }, author_association: 'MEMBER',
        path: 'src/Foo.java', line: 42, side: 'RIGHT', position: 5,
        created_at: '2026-06-10T09:00:00Z', html_url: 'https://gh/c/1001',
        in_reply_to_id: null, body: "don't set bookId as the taskId" },
      { id: 1002, user: { login: 'bob' }, author_association: 'CONTRIBUTOR',
        path: 'src/Bar.java', line: null, original_line: 88, side: 'RIGHT', position: null,
        created_at: '2026-06-10T09:30:00Z', html_url: 'https://gh/c/1002',
        in_reply_to_id: null, body: 'this column needs a migration' },
      { id: 1003, user: { login: 'codecov[bot]' }, author_association: 'NONE',
        path: 'src/Baz.java', line: 5, position: 1,
        created_at: '2026-06-10T09:45:00Z', body: 'coverage decreased by 2%' }, // noise
    ],
    conversationComments: [
      { id: 2001, user: { login: 'carol' }, author_association: 'MEMBER',
        created_at: '2026-06-10T08:00:00Z', html_url: 'https://gh/i/2001',
        body: 'Can we also handle the empty-selection case?' },
      { id: 2002, user: { login: 'github-actions[bot]' }, author_association: 'NONE',
        created_at: '2026-06-10T08:05:00Z', body: 'CI passed ✅' }, // noise
    ],
    reviewThreads: [
      { isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 1001 }] } },
      { isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 1002 }] } },
    ],
  };
}

// ---- normalize() core -------------------------------------------------------

test('assigns stable sequential C-n ids to signal comments only', () => {
  const r = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  // 2 inline (alice, bob) + 1 conversation (carol) + 1 review-summary (alice) = 4 signal
  assert(r.comments.length === 4, `expected 4 signal, got ${r.comments.length}`);
  assert(r.comments.map((c) => c.id).join(',') === 'C-1,C-2,C-3,C-4', 'ids not sequential');
});

test('excludes bot/CI noise from the numbered inventory', () => {
  const r = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  assert(r.excluded.length === 2, `expected 2 excluded, got ${r.excluded.length}`);
  assert(!r.comments.some((c) => /\[bot\]/.test(c.author || '')), 'a bot leaked into comments');
  assert(r.counts.excluded === 2, 'counts.excluded wrong');
});

test('drops review summaries with an empty body', () => {
  const r = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  const summaries = r.comments.filter((c) => c.kind === 'review-summary');
  assert(summaries.length === 1, `expected 1 non-empty review summary, got ${summaries.length}`);
});

test('orders by kind (inline → conversation → review-summary) then time', () => {
  const r = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  assert(r.comments[0].kind === 'inline', 'first should be inline');
  assert(r.comments[1].kind === 'inline', 'second should be inline');
  assert(r.comments[2].kind === 'conversation', 'third should be conversation');
  assert(r.comments[3].kind === 'review-summary', 'fourth should be review-summary');
  // inline ordered by created_at: 1001 (09:00) before 1002 (09:30)
  assert(r.comments[0].body.includes('taskId'), 'inline time-order wrong');
});

test('id assignment is deterministic across repeated runs', () => {
  const a = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  const b = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  assert(JSON.stringify(a.comments) === JSON.stringify(b.comments), 'non-deterministic output');
});

test('maps GraphQL resolved/outdated state onto inline comments', () => {
  const r = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  const c1 = r.comments.find((c) => c.body.includes('taskId'));
  const c2 = r.comments.find((c) => c.body.includes('migration'));
  assert(c1.resolved === true && c1.outdated === false, 'thread state for 1001 wrong');
  assert(c2.resolved === false && c2.outdated === true, 'thread state for 1002 wrong');
});

test('derives outdated from REST position when GraphQL threads absent', () => {
  const b = sampleBundle();
  b.reviewThreads = [];
  const r = normalize(b, { repo: 'org/repo', number: 31 });
  const c2 = r.comments.find((c) => c.body.includes('migration'));
  // position null + original_line set → outdated; resolved unknown → null
  assert(c2.outdated === true, 'should derive outdated from null position');
  assert(c2.resolved === null, 'resolved should be null without GraphQL');
});

test('carries pr metadata through', () => {
  const r = normalize(sampleBundle(), { repo: 'org/repo', number: 31 });
  assert(r.pr.repo === 'org/repo' && r.pr.number === 31, 'pr meta wrong');
  assert(r.pr.state === 'MERGED' && r.pr.merged === true, 'pr state wrong');
  assert(r.pr.head === 'feature/l2-bulk-tasks-review', 'head ref wrong');
});

test('empty bundle yields zero comments, not a crash', () => {
  const r = normalize({}, { repo: 'org/repo', number: 7 });
  assert(r.comments.length === 0 && r.counts.signal === 0, 'empty handling wrong');
});

// ---- isNoise / parsePrUrl ---------------------------------------------------

test('isNoise flags [bot] suffixes and denylisted logins', () => {
  assert(isNoise('dependabot[bot]') === true);
  assert(isNoise('github-actions') === true);
  assert(isNoise('SonarCloud') === true);
  assert(isNoise('alice') === false);
  assert(isNoise('') === true);
  assert(isNoise(null) === true);
});

test('parsePrUrl extracts repo + number, rejects junk', () => {
  assert(JSON.stringify(parsePrUrl('https://github.com/org/repo/pull/31')) ===
    JSON.stringify({ repo: 'org/repo', number: 31 }));
  assert(parsePrUrl('https://example.com/not/a/pr') === null);
});

// ---- CLI surface ------------------------------------------------------------

test('CLI: --input + --out writes canonical JSON and prints a one-line summary', () => {
  const file = writeBundle(sampleBundle());
  const outPath = path.join(TMP, 'out.json');
  const r = spawnSync('node', [SCRIPT, `--input=${file}`, `--out=${outPath}`], { encoding: 'utf8' });
  assert(r.status === 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert(!r.stdout.includes('\n') || r.stdout.trim().split('\n').length === 1, 'summary should be one line');
  assert(r.stdout.includes('C-1..C-4'), `summary missing id range: ${r.stdout}`);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert(written.comments.length === 4, 'written file comment count wrong');
});

test('CLI: --input without --out prints canonical JSON to stdout', () => {
  const r = runInput(sampleBundle());
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.comments[0].id === 'C-1', 'stdout JSON malformed');
});

test('CLI: exit 1 on usage error (no source args)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

test('CLI: exit 1 on missing --input file', () => {
  const r = spawnSync('node', [SCRIPT, `--input=${path.join(TMP, 'nope.json')}`], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

test('CLI: exit 3 on malformed --input JSON', () => {
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{ not valid json ');
  const r = spawnSync('node', [SCRIPT, `--input=${bad}`], { encoding: 'utf8' });
  assert(r.status === 3, `expected 3, got ${r.status}`);
});

test('CLI: exit 1 on unparseable --pr URL (no network reached)', () => {
  const r = spawnSync('node', [SCRIPT, '--pr=https://example.com/x'], { encoding: 'utf8' });
  assert(r.status === 1, `expected 1, got ${r.status}`);
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
