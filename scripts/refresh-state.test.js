#!/usr/bin/env node
'use strict';
/**
 * Unit tests for refresh-state.js — pure core only (no git, no FS).
 * Run: node scripts/refresh-state.test.js
 */

const assert = require('assert');
const path = require('path');
const {
  STATE_REL, statePathFor, newEntry, hasConflictMarkers, parseStateText, decide,
} = require('./refresh-state.js');

let n = 0;
function test(name, fn) { fn(); n++; process.stdout.write(`  ok - ${name}\n`); }

// ── statePathFor ────────────────────────────────────────────────────────────
test('statePathFor puts the file under agent-context/', () => {
  assert.strictEqual(statePathFor('/repo'), path.join('/repo', STATE_REL));
  assert.ok(statePathFor('/repo').endsWith(path.join('agent-context', '.refresh-state.json')));
});

// ── newEntry ──────────────────────────────────────────────────────────────
test('newEntry records the bookmark fields (no counter anymore)', () => {
  const e = newEntry({ headSha: 'abc', branch: 'main', ranAt: 'T', mode: 'full', by: 'discover', repo: 'svc' });
  assert.strictEqual(e.schema, 1);
  assert.strictEqual(e.repo, 'svc');
  assert.deepStrictEqual(Object.keys(e.baseline).sort(), ['branch', 'by', 'head_sha', 'mode', 'ran_at']);
  assert.strictEqual(e.baseline.head_sha, 'abc');
  assert.strictEqual(e.baseline.mode, 'full');
});

test('newEntry carries repo from prev when not given explicitly', () => {
  const prev = { schema: 1, repo: 'svc', baseline: { head_sha: 'old', branch: 'main' } };
  const e = newEntry({ headSha: 'new', branch: 'main', ranAt: 'T', mode: 'fast', prev });
  assert.strictEqual(e.repo, 'svc');
  assert.strictEqual(e.baseline.head_sha, 'new');
});

// ── decide ────────────────────────────────────────────────────────────────
test('decide → full when there is no baseline', () => {
  assert.strictEqual(decide(null, { headSha: 'x', branch: 'main' }).path, 'full');
  assert.strictEqual(decide({ baseline: {} }, { headSha: 'x', branch: 'main' }).path, 'full');
});

test('decide → full on --full override even if nothing changed', () => {
  const s = { baseline: { head_sha: 'x', branch: 'main' } };
  assert.strictEqual(decide(s, { headSha: 'x', branch: 'main', full: true }).path, 'full');
});

test('decide → full when the branch changed', () => {
  const s = { baseline: { head_sha: 'x', branch: 'main' } };
  const d = decide(s, { headSha: 'y', branch: 'feature' });
  assert.strictEqual(d.path, 'full');
  assert.match(d.reason, /branch changed/);
});

test('decide → skip when HEAD unchanged and tree clean', () => {
  const s = { baseline: { head_sha: 'x', branch: 'main' } };
  assert.strictEqual(decide(s, { headSha: 'x', branch: 'main', dirtyCount: 0 }).path, 'skip');
});

test('decide → full when HEAD unchanged but tree is dirty', () => {
  const s = { baseline: { head_sha: 'x', branch: 'main' } };
  const d = decide(s, { headSha: 'x', branch: 'main', dirtyCount: 3 });
  assert.strictEqual(d.path, 'full');
  assert.match(d.reason, /uncommitted/);
});

test('decide → fast with comparisonSha when HEAD moved', () => {
  const s = { baseline: { head_sha: 'old', branch: 'main' } };
  const d = decide(s, { headSha: 'new', branch: 'main', dirtyCount: 0 });
  assert.strictEqual(d.path, 'fast');
  assert.strictEqual(d.comparisonSha, 'old');
});

// ── parse / conflict detection ──────────────────────────────────────────────
test('parseStateText tolerates empty / garbage → null', () => {
  assert.strictEqual(parseStateText('').state, null);
  assert.strictEqual(parseStateText('   ').state, null);
  assert.strictEqual(parseStateText('not json').state, null);
  assert.strictEqual(parseStateText(null).state, null);
  assert.deepStrictEqual(parseStateText('{"schema":1}').state, { schema: 1 });
});

test('hasConflictMarkers detects a git-conflicted file (we do NOT resolve it)', () => {
  const conflicted = [
    '{ "baseline": {',
    '<<<<<<< HEAD',
    '  "head_sha": "aaa"',
    '=======',
    '  "head_sha": "bbb"',
    '>>>>>>> other',
    '} }',
  ].join('\n');
  assert.strictEqual(hasConflictMarkers(conflicted), true);
  assert.strictEqual(hasConflictMarkers('{ "baseline": { "head_sha": "aaa" } }'), false);
  // A conflicted file is unparseable → treated as "no baseline" → full scan.
  assert.strictEqual(parseStateText(conflicted).state, null);
});

process.stdout.write(`\n${n} tests passed\n`);
