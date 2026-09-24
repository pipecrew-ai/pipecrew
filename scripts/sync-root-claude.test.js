#!/usr/bin/env node
/**
 * Unit tests for sync-root-claude.js — one test per behavior branch.
 * Zero deps: run with `node sync-root-claude.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensure, discoverSlugs, renderBlock } = require('./sync-root-claude');

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

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-root-claude-'));
}

function addWorkspace(root, slug, configName = 'config.json') {
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(path.join(root, slug, configName), '{}');
}

function read(root) {
  return fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
}

console.log('\nsync-root-claude tests\n');

test('creates CLAUDE.md from template with the slug indexed', () => {
  const root = makeRoot();
  addWorkspace(root, 'acme-saas');
  const r = ensure(root, 'acme-saas');
  assert(r.action === 'created', `expected created, got ${r.action}`);
  const body = read(root);
  assert(body.includes('`acme-saas/context/platform.md`'), 'slug line missing');
  assert(body.includes('/pipecrew:deliver'), 'routing table missing');
  assert(body.includes('pipecrew:solution-architect'), 'agent table missing');
  assert(r.warnings.length === 0, `unexpected warnings: ${r.warnings.join('; ')}`);
});

test('idempotent — second run reports unchanged, byte-identical file', () => {
  const root = makeRoot();
  addWorkspace(root, 'acme-saas');
  ensure(root, 'acme-saas');
  const before = read(root);
  const r = ensure(root, 'acme-saas');
  assert(r.action === 'unchanged', `expected unchanged, got ${r.action}`);
  assert(read(root) === before, 'file changed on idempotent re-run');
});

test('second slug is added to the index, sorted', () => {
  const root = makeRoot();
  addWorkspace(root, 'zeta');
  ensure(root, 'zeta');
  addWorkspace(root, 'acme', 'config.portable.json'); // /join layout: portable config only
  const r = ensure(root, 'acme');
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  const body = read(root);
  const acmeIdx = body.indexOf('- `acme`');
  const zetaIdx = body.indexOf('- `zeta`');
  assert(acmeIdx !== -1 && zetaIdx !== -1, 'both slugs must be listed');
  assert(acmeIdx < zetaIdx, 'slugs must be sorted');
});

test('user edits outside the markers are preserved', () => {
  const root = makeRoot();
  addWorkspace(root, 'acme');
  ensure(root, 'acme');
  const edited = read(root) + '\n## My own notes\n\nHands off this section.\n';
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), edited);
  addWorkspace(root, 'beta');
  ensure(root, 'beta');
  const body = read(root);
  assert(body.includes('Hands off this section.'), 'user section was lost');
  assert(body.includes('- `beta`'), 'new slug not added');
});

test('pre-existing hand-authored CLAUDE.md gets the block appended, content intact', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# My rules\n\nAlways use tabs.\n');
  addWorkspace(root, 'acme');
  const r = ensure(root, 'acme');
  assert(r.action === 'appended', `expected appended, got ${r.action}`);
  const body = read(root);
  assert(body.startsWith('# My rules'), 'user content must stay first and untouched');
  assert(body.includes('Always use tabs.'), 'user content lost');
  assert(body.includes('- `acme`'), 'slug index missing');
  assert(!body.includes('Routing user asks'), 'appended mode must not inject the full template body');
});

test('self-pruning — removed workspace dir drops out of the index', () => {
  const root = makeRoot();
  addWorkspace(root, 'acme');
  addWorkspace(root, 'gone');
  ensure(root);
  assert(read(root).includes('- `gone`'), 'precondition: gone listed');
  fs.rmSync(path.join(root, 'gone'), { recursive: true, force: true });
  const r = ensure(root);
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  assert(!read(root).includes('- `gone`'), 'stale slug not pruned');
});

test('malformed markers → throws, file untouched', () => {
  const root = makeRoot();
  addWorkspace(root, 'acme');
  ensure(root, 'acme');
  const corrupted = read(root) + '\n<!-- pipecrew:slugs -->\n';
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), corrupted);
  let threw = false;
  try { ensure(root, 'acme'); } catch { threw = true; }
  assert(threw, 'expected throw on duplicated marker');
  assert(read(root) === corrupted, 'file must be untouched on marker error');
});

test('empty root → placeholder line, no slug entries', () => {
  const root = makeRoot();
  const r = ensure(root);
  assert(r.action === 'created', `expected created, got ${r.action}`);
  assert(read(root).includes('no workspaces onboarded yet'), 'placeholder missing');
  assert(r.slugs.length === 0, 'no slugs expected');
});

test('--slug force-includes a workspace whose config lands later in the phase', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'early')); // dir exists, config not written yet
  const r = ensure(root, 'early');
  assert(r.slugs.includes('early'), 'forced slug missing from index');
  assert(read(root).includes('- `early`'), 'forced slug line missing');
});

test('discoverSlugs ignores plain dirs and files', () => {
  const root = makeRoot();
  addWorkspace(root, 'real');
  fs.mkdirSync(path.join(root, 'real-repos'));       // sibling clone root — no config
  fs.writeFileSync(path.join(root, 'notes.md'), ''); // plain file
  const slugs = discoverSlugs(root);
  assert(slugs.length === 1 && slugs[0] === 'real', `unexpected slugs: ${slugs.join(', ')}`);
});

test('dry-run writes nothing', () => {
  const root = makeRoot();
  addWorkspace(root, 'acme');
  const r = ensure(root, 'acme', { dryRun: true });
  assert(r.action === 'created', `expected created, got ${r.action}`);
  assert(!fs.existsSync(path.join(root, 'CLAUDE.md')), 'dry-run must not write');
});

test('renderBlock keeps exactly one marker pair', () => {
  const block = renderBlock(['a', 'b']);
  assert(block.startsWith('<!-- pipecrew:slugs -->'), 'begin marker missing');
  assert(block.endsWith('<!-- /pipecrew:slugs -->'), 'end marker missing');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
