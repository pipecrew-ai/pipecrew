#!/usr/bin/env node
'use strict';
/**
 * Unit tests for explain-cache.js — pure core + a temp-dir store/lookup round trip.
 * Run: node scripts/explain-cache.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  tokens, normalize, cacheKey, overlap, similar, extractSources, decide, lookup, store,
} = require('./explain-cache.js');

let n = 0;
function test(name, fn) { fn(); n++; process.stdout.write(`  ok - ${name}\n`); }

const NOW = '2026-10-09T15:00:00.000Z';
function entry(over = {}) {
  return {
    schema: 1, key: 'k', question: 'how does the upload listener work', perspective: 'technical',
    depth: 'quick', repo: 'any', created_at: NOW, updated_at: NOW,
    sources: [{ path: '/a.md', sha256: 'A' }, { path: '/b.java', sha256: 'B' }, { path: '/c.yaml', sha256: 'C' }],
    repos: [{ root: '/repo', head: 'h1' }],
    ...over,
  };
}
const SAME = { hashes: { '/a.md': 'A', '/b.java': 'B', '/c.yaml': 'C' }, heads: { '/repo': 'h1' } };

// ── normalization + keys ─────────────────────────────────────────────────
test('normalize drops case, punctuation, and stopwords', () => {
  assert.strictEqual(normalize('How does the Upload-Listener work?'), 'upload listener work');
  assert.deepStrictEqual(tokens('Explain: what is TemplateSyncListener.java'), ['templatesynclistener.java']);
});

test('normalize treats hyphenated and spaced phrasing the same', () => {
  assert.strictEqual(
    normalize('How does sync-listener work end-to-end?'),
    normalize('how does sync listener work end to end'),
  );
});

test('cacheKey is stable across phrasing noise but scoped by perspective + repo', () => {
  const k = cacheKey('How does the upload listener work?', 'technical', 'any');
  assert.strictEqual(k, cacheKey('how does upload listener work', 'technical', 'any'));
  assert.notStrictEqual(k, cacheKey('How does the upload listener work?', 'product', 'any'));
  assert.notStrictEqual(k, cacheKey('How does the upload listener work?', 'technical', 'svc'));
});

// ── similarity ──────────────────────────────────────────────────────────
test('overlap scores shared words vs the shorter question; disjoint questions score 0', () => {
  assert.strictEqual(overlap('upload listener flow', 'upload listener flow'), 1);
  assert.strictEqual(overlap('upload listener', 'billing cron'), 0);
});

test('similar shortlists close matches in the same scope only', () => {
  const entries = [
    entry({ key: 'k1', question: 'how does the upload listener work end to end' }),
    entry({ key: 'k2', question: 'how does billing work', }),
    entry({ key: 'k3', question: 'how does the upload listener work end to end', perspective: 'product' }),
  ];
  const c = similar('upload listener end to end flow', 'technical', 'any', entries);
  assert.deepStrictEqual(c.map(x => x.key), ['k1']);
});

test('similar: a shorter rewording of a cached question is shortlisted (works vs work)', () => {
  const entries = [entry({ key: 'k1', question: 'how does digital-ad-template-sync-listener work end-to-end across all components?' })];
  const c = similar('how digital-ad-template-sync-listener works?', 'technical', 'any', entries);
  assert.deepStrictEqual(c.map(x => x.key), ['k1']);
});

test('similar: unrelated questions sharing one word are not shortlisted', () => {
  const entries = [entry({ key: 'k1', question: 'how does the upload listener work end to end' })];
  assert.deepStrictEqual(similar('how does billing work', 'technical', 'any', entries), []);
});

// ── sources block ───────────────────────────────────────────────────────
test('extractSources parses the block, with or without a json fence, and dedupes', () => {
  const plain = 'x\n<!-- BEGIN EXPLAIN_SOURCES -->\n["/a", "/b", "/a"]\n<!-- END EXPLAIN_SOURCES -->';
  assert.deepStrictEqual(extractSources(plain), ['/a', '/b']);
  const fenced = '<!-- BEGIN EXPLAIN_SOURCES -->\n```json\n["/a"]\n```\n<!-- END EXPLAIN_SOURCES -->';
  assert.deepStrictEqual(extractSources(fenced), ['/a']);
  assert.strictEqual(extractSources('no block'), null);
  assert.strictEqual(extractSources('<!-- BEGIN EXPLAIN_SOURCES -->not json<!-- END EXPLAIN_SOURCES -->'), null);
});

// ── decide ──────────────────────────────────────────────────────────────
test('decide: no entry or --fresh → full', () => {
  assert.strictEqual(decide(null, {}, { now: NOW }).decision, 'full');
  assert.strictEqual(decide(entry(), SAME, { now: NOW, fresh: true }).decision, 'full');
});

test('decide: nothing changed → skip, at any age under the limit', () => {
  const r = decide(entry({ updated_at: '2026-10-05T15:00:00.000Z' }), SAME, { now: NOW });
  assert.strictEqual(r.decision, 'skip');
  assert.deepStrictEqual(r.new_commits, []);
});

test('decide: older than max age → full', () => {
  const r = decide(entry({ updated_at: '2026-09-30T15:00:00.000Z' }), SAME, { now: NOW, maxAgeDays: 7 });
  assert.strictEqual(r.decision, 'full');
});

test('decide: repo HEAD moved but no recorded file changed → skip with new_commits notice', () => {
  const r = decide(entry(), { ...SAME, heads: { '/repo': 'h2' } }, { now: NOW });
  assert.strictEqual(r.decision, 'skip');
  assert.deepStrictEqual(r.new_commits, [{ root: '/repo', from: 'h1', to: 'h2' }]);
});

test('decide: a minority of sources changed (context or code) → fast with the changed list', () => {
  const r = decide(entry(), { ...SAME, hashes: { ...SAME.hashes, '/a.md': 'A2' } }, { now: NOW });
  assert.strictEqual(r.decision, 'fast');
  assert.deepStrictEqual(r.changed_files, ['/a.md']);
});

test('decide: a deleted source counts as changed', () => {
  const r = decide(entry(), { ...SAME, hashes: { ...SAME.hashes, '/b.java': null } }, { now: NOW });
  assert.deepStrictEqual(r.changed_files, ['/b.java']);
});

test('decide: most sources changed → full', () => {
  const r = decide(entry(), { heads: SAME.heads, hashes: { '/a.md': 'x', '/b.java': 'y', '/c.yaml': 'C' } }, { now: NOW });
  assert.strictEqual(r.decision, 'full');
});

test('decide: a quick answer cannot serve a deep request, but deep serves quick', () => {
  assert.strictEqual(decide(entry(), SAME, { now: NOW, depth: 'deep' }).decision, 'full');
  assert.strictEqual(decide(entry({ depth: 'deep' }), SAME, { now: NOW, depth: 'quick' }).decision, 'skip');
});

// ── store + lookup round trip (temp dir, no git) ─────────────────────────
test('store then lookup: skip, then fast after a source edit, history kept on re-store', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-cache-'));
  try {
    const src = path.join(tmp, 'doc.md');
    const src2 = path.join(tmp, 'code.java');
    fs.writeFileSync(src, 'v1');
    fs.writeFileSync(src2, 'class A {}');
    const answerFile = path.join(tmp, 'answer.md');
    fs.writeFileSync(answerFile, `## answer\n<!-- BEGIN EXPLAIN_SOURCES -->\n${JSON.stringify([src, src2])}\n<!-- END EXPLAIN_SOURCES -->\n`);
    const cacheDir = path.join(tmp, 'cache');
    const base = { 'cache-dir': cacheDir, question: 'How does the upload listener work?', perspective: 'technical' };

    const s = store({ ...base, 'answer-file': answerFile });
    assert.strictEqual(s.stored, true);
    assert.strictEqual(s.sources, 2);

    assert.strictEqual(lookup({ ...base, question: 'how does upload listener work' }).decision, 'skip');

    const near = lookup({ ...base, question: 'upload listener work end to end' });
    assert.strictEqual(near.decision, 'confirm');
    assert.strictEqual(near.candidates[0].key, s.key);
    assert.strictEqual(lookup({ ...base, question: 'upload listener work end to end', key: s.key }).decision, 'skip');

    fs.writeFileSync(src, 'v2');
    const f = lookup(base);
    assert.strictEqual(f.decision, 'fast');
    assert.deepStrictEqual(f.changed_files, [src]);

    store({ ...base, 'answer-file': answerFile });
    assert.strictEqual(fs.readdirSync(path.join(cacheDir, 'history', s.key)).length, 1);
    assert.strictEqual(lookup(base).decision, 'skip');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('store reads the answer from stdin with --answer-file=-', () => {
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-cache-'));
  try {
    const src = path.join(tmp, 'doc.md');
    fs.writeFileSync(src, 'v1');
    const answer = `## answer\n<!-- BEGIN EXPLAIN_SOURCES -->\n${JSON.stringify([src])}\n<!-- END EXPLAIN_SOURCES -->\n`;
    const cacheDir = path.join(tmp, 'cache');
    const r = spawnSync(process.execPath, [
      path.join(__dirname, 'explain-cache.js'), 'store', `--cache-dir=${cacheDir}`,
      '--question=what is a contract', '--perspective=product', '--answer-file=-',
    ], { input: answer, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.stored, true);
    assert.strictEqual(fs.readFileSync(out.answer_file, 'utf8'), answer);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('store refuses an answer without a sources block', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-cache-'));
  try {
    const answerFile = path.join(tmp, 'answer.md');
    fs.writeFileSync(answerFile, '## answer with no sources');
    const r = store({ 'cache-dir': path.join(tmp, 'c'), question: 'q x', perspective: 'technical', 'answer-file': answerFile });
    assert.strictEqual(r.stored, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${n} passed\n`);
