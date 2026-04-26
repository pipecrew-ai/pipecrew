#!/usr/bin/env node
/**
 * Unit tests for validate-claude-md.js — one test per guardrail plus happy path.
 * Zero deps: run with `node validate-claude-md.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('./validate-claude-md');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function hasErr(result, substring) {
  return result.errors.some(e => e.includes(substring));
}
function hasWarn(result, substring) {
  return result.warnings.some(w => w.includes(substring));
}

// Temp repo with stub agent-context files for dead-link tests.
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-validator-'));
fs.mkdirSync(path.join(tmpRepo, 'agent-context'), { recursive: true });
fs.mkdirSync(path.join(tmpRepo, 'agent-context', 'common'), { recursive: true });
fs.writeFileSync(path.join(tmpRepo, 'agent-context', 'AGENT_INDEX.md'), '# index');
fs.writeFileSync(path.join(tmpRepo, 'agent-context', 'common', 'TESTING.md'), '# testing');

const validBody = [
  '# test-repo',
  '',
  'One-line purpose.',
  '',
  '## Agent guidelines',
  '',
  '- Before planning any change, read `agent-context/AGENT_INDEX.md` — it maps tasks to the relevant feature, service, and convention files.',
  '- When you add, change, or restructure a feature, integration, or module, update the matching file under `agent-context/` in the same change. Docs must not drift behind the code.',
  '',
  '## Quick facts',
  '- Stack: Node',
  '',
  '## Build & run',
  '```bash',
  'npm install',
  '```',
  '',
  '## Must-know guidelines (repo-specific)',
  '',
  '1. Rule A',
  '2. Rule B',
  '',
  '## Deep context (topic → file)',
  '',
  '| Topic | File |',
  '|---|---|',
  '| Testing | `agent-context/common/TESTING.md` |',
  ''
].join('\n');

console.log('\nvalidate-claude-md tests\n');

test('happy path — valid file has no errors or warnings', () => {
  const r = validate(validBody, tmpRepo);
  assert(r.errors.length === 0, `unexpected errors: ${r.errors.join('; ')}`);
  assert(r.warnings.length === 0, `unexpected warnings: ${r.warnings.join('; ')}`);
});

test('1. coupling scan — rejects ~/.claude/workspaces/ reference', () => {
  const body = validBody + '\nSee ~/.claude/workspaces/dal/platform.md for more.\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'workspace path reference'), 'missed workspace path');
  assert(hasErr(r, '"platform.md" reference'), 'missed platform.md word');
});

test('1. coupling scan — rejects "divergence" language', () => {
  const body = validBody + '\nFor divergences from the workspace baseline see elsewhere.\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'divergence'), 'missed divergence');
  assert(hasErr(r, 'workspace baseline'), 'missed workspace baseline');
});

test('1. coupling scan — rejects audit-findings reference', () => {
  const body = validBody + '\nCheck audit-findings for known bugs.\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'audit-findings'), 'missed audit-findings');
});

test('2. mandatory bullets — missing first bullet fails', () => {
  const body = validBody.replace(/- Before planning[^\n]+\n/, '');
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'mandatory-bullet'), 'missed mandatory bullet 1');
});

test('2. mandatory bullets — missing second bullet fails', () => {
  const body = validBody.replace(/- When you add[^\n]+\n/, '');
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'mandatory-bullet'), 'missed mandatory bullet 2');
});

test('3. dead-link — missing agent-context file fails', () => {
  const body = validBody.replace('agent-context/common/TESTING.md', 'agent-context/common/MISSING.md');
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'dead-link'), 'missed dead link');
  assert(hasErr(r, 'MISSING.md'), 'dead link error lacks filename');
});

test('3. dead-link — existing agent-context file passes', () => {
  const r = validate(validBody, tmpRepo);
  assert(!hasErr(r, 'dead-link'), 'false positive on existing link');
});

test('3. dead-link — glob path `services/*.md` is skipped (doc shorthand)', () => {
  const body = validBody.replace(
    '| Testing | `agent-context/common/TESTING.md` |',
    '| Testing | `agent-context/common/TESTING.md` |\n| Services | `agent-context/services/*.md` |'
  );
  const r = validate(body, tmpRepo);
  assert(!hasErr(r, 'dead-link'), 'false positive on glob path');
});

test('3. dead-link — brace-expansion path skipped (doc shorthand)', () => {
  const body = validBody.replace(
    '| Testing | `agent-context/common/TESTING.md` |',
    '| Testing | `agent-context/common/TESTING.md` |\n| Per-service | `agent-context/services/{USER,PUB}_API.md` |'
  );
  const r = validate(body, tmpRepo);
  assert(!hasErr(r, 'dead-link'), 'false positive on brace path');
});

test('4. absolute-path — Windows C:/ path rejected', () => {
  const body = validBody + '\nSee C:/ABVI/thing for details.\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'Windows absolute path'), 'missed C:/ path');
});

test('4. absolute-path — /Users/ path rejected', () => {
  const body = validBody + '\nCheck /Users/dev/thing.txt next.\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'macOS absolute path'), 'missed /Users/ path');
});

test('5. size — 151-line body warns, 201-line body fails', () => {
  const filler = Array(130).fill('filler line').join('\n');
  const bigBody = validBody + '\n' + filler;
  const r1 = validate(bigBody, tmpRepo);
  assert(hasWarn(r1, 'above soft ceiling'), 'should warn at >150');
  assert(!r1.errors.some(e => e.includes('exceeds hard ceiling')), 'should not hard-fail at <=200');

  const hugeBody = validBody + '\n' + Array(200).fill('filler').join('\n');
  const r2 = validate(hugeBody, tmpRepo);
  assert(hasErr(r2, 'exceeds hard ceiling'), 'should hard-fail at >200');
});

test('6. must-know cap — 11 bullets fails', () => {
  const elevenBullets = Array.from({ length: 11 }, (_, i) => `${i + 1}. Rule ${i}`).join('\n');
  const body = validBody.replace('1. Rule A\n2. Rule B', elevenBullets);
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'must-know'), 'missed must-know cap violation');
  assert(hasErr(r, '11 bullets'), 'error should report actual count');
});

test('6. must-know cap — 10 bullets passes', () => {
  const tenBullets = Array.from({ length: 10 }, (_, i) => `${i + 1}. Rule ${i}`).join('\n');
  const body = validBody.replace('1. Rule A\n2. Rule B', tenBullets);
  const r = validate(body, tmpRepo);
  assert(!hasErr(r, 'must-know'), 'false positive on 10 bullets');
});

test('7. secret scan — AWS access key rejected', () => {
  const body = validBody + '\nkey: AKIAIOSFODNN7EXAMPLE\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'AWS access key'), 'missed AKIA key');
});

test('7. secret scan — GitHub PAT rejected', () => {
  const body = validBody + '\ntoken: ghp_' + 'a'.repeat(36) + '\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'GitHub personal access token'), 'missed ghp_ token');
});

test('7. secret scan — AWS account ID near "account-id" rejected', () => {
  const body = validBody + '\nAWS Account ID: 123456789012\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'AWS account ID'), 'missed account ID near label');
});

test('7. secret scan — bare 12-digit number NOT flagged (false-positive guard)', () => {
  const body = validBody + '\nserial 123456789012 is unrelated.\n';
  const r = validate(body, tmpRepo);
  assert(!hasErr(r, 'AWS account ID'), 'false positive on bare 12-digit number');
});

test('7. secret scan — email flagged', () => {
  const body = validBody + '\nContact: alice@corp.com\n';
  const r = validate(body, tmpRepo);
  assert(hasErr(r, 'email address'), 'missed email');
});

test('7. secret scan — example.com / anthropic.com emails NOT flagged', () => {
  const body = validBody + '\nDemo: user@example.com, bot@anthropic.com\n';
  const r = validate(body, tmpRepo);
  assert(!hasErr(r, 'email address'), 'false positive on example/anthropic email');
});

test('10. idempotency — "Last Updated: YYYY-MM-DD" trailer warns', () => {
  const body = validBody + '\n---\n\n*Last Updated: 2026-04-15*\n';
  const r = validate(body, tmpRepo);
  assert(hasWarn(r, 'idempotency'), 'missed Last Updated trailer');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
