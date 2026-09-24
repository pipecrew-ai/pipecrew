#!/usr/bin/env node
/**
 * Unit tests for sync-root-claude.js — one test per behavior branch.
 * Zero deps: run with `node sync-root-claude.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensure, resolveTargets, renderBlock, parseBlocks } = require('./sync-root-claude');

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

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-root-claude-'));
}

/** A fake workspace dir (holds config.json) somewhere outside the repo parent. */
function makeWorkspace(slug) {
  const dir = path.join(makeDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  return dir;
}

function read(parent) {
  return fs.readFileSync(path.join(parent, 'CLAUDE.md'), 'utf8');
}

console.log('\nsync-root-claude tests\n');

test('creates CLAUDE.md at the repo parent with the workspace block', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'created', `expected created, got ${r.action}`);
  const body = read(parent);
  assert(body.includes('<!-- pipecrew:workspace acme dir='), 'workspace block marker missing');
  assert(body.includes('/context/platform.md`'), 'platform.md pointer missing');
  assert(body.includes('`acme-troubleshooter`'), 'concrete agent name missing');
  assert(body.includes('/pipecrew:deliver'), 'routing table missing');
  assert(body.includes('pipecrew:solution-architect'), 'agent table missing');
  assert(r.warnings.length === 0, `unexpected warnings: ${r.warnings.join('; ')}`);
});

test('idempotent — second run reports unchanged, byte-identical file', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const before = read(parent);
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'unchanged', `expected unchanged, got ${r.action}`);
  assert(read(parent) === before, 'file changed on idempotent re-run');
});

test('two workspaces sharing one repo parent → two blocks, body once, sorted', () => {
  const parent = makeDir();
  const wsZ = makeWorkspace('zeta');
  const wsA = makeWorkspace('acme');
  ensure(parent, 'zeta', wsZ);
  const r = ensure(parent, 'acme', wsA);
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  const body = read(parent);
  const acmeIdx = body.indexOf('### acme');
  const zetaIdx = body.indexOf('### zeta');
  assert(acmeIdx !== -1 && zetaIdx !== -1, 'both workspace blocks must be present');
  assert(acmeIdx < zetaIdx, 'blocks must be sorted by slug');
  const routingCount = body.split('Routing user asks').length - 1;
  assert(routingCount === 1, `static body must appear exactly once, found ${routingCount}`);
});

test('re-run refreshes a stale block (workspace dir moved)', () => {
  const parent = makeDir();
  const ws1 = makeWorkspace('acme');
  ensure(parent, 'acme', ws1);
  const ws2 = makeWorkspace('acme'); // same slug, new location
  ensure(parent, 'acme', ws2);
  const body = read(parent);
  assert(!body.includes(ws1.replace(/\\/g, '/')), 'old workspace dir still referenced');
  assert(body.includes(ws2.replace(/\\/g, '/')), 'new workspace dir missing');
  assert((body.split('### acme').length - 1) === 1, 'slug block must not duplicate');
});

test('user edits outside the container are preserved', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const edited = read(parent) + '\n## My own notes\n\nHands off this section.\n';
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), edited);
  const ws2 = makeWorkspace('beta');
  ensure(parent, 'beta', ws2);
  const body = read(parent);
  assert(body.includes('Hands off this section.'), 'user section was lost');
  assert(body.includes('### beta'), 'new workspace block not added');
});

test('pre-existing hand-authored CLAUDE.md gets the block appended, content intact', () => {
  const parent = makeDir();
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), '# My rules\n\nAlways use tabs.\n');
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'appended', `expected appended, got ${r.action}`);
  const body = read(parent);
  assert(body.startsWith('# My rules'), 'user content must stay first and untouched');
  assert(body.includes('Always use tabs.'), 'user content lost');
  assert(body.includes('### acme'), 'workspace block missing');
  assert(!body.includes('Routing user asks'), 'appended mode must not inject the full template body');
});

test('self-pruning — a workspace whose dir is gone drops out on the next run', () => {
  const parent = makeDir();
  const wsKeep = makeWorkspace('keep');
  const wsGone = makeWorkspace('gone');
  ensure(parent, 'gone', wsGone);
  ensure(parent, 'keep', wsKeep);
  assert(read(parent).includes('### gone'), 'precondition: gone listed');
  fs.rmSync(wsGone, { recursive: true, force: true });
  const r = ensure(parent, 'keep', wsKeep);
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  assert(!read(parent).includes('### gone'), 'stale workspace block not pruned');
});

test('malformed container markers → throws, file untouched', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const corrupted = read(parent) + '\n<!-- pipecrew:workspaces -->\n';
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), corrupted);
  let threw = false;
  try { ensure(parent, 'acme', ws); } catch { threw = true; }
  assert(threw, 'expected throw on duplicated container marker');
  assert(read(parent) === corrupted, 'file must be untouched on marker error');
});

test('dry-run writes nothing', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws, { dryRun: true });
  assert(r.action === 'created', `expected created, got ${r.action}`);
  assert(!fs.existsSync(path.join(parent, 'CLAUDE.md')), 'dry-run must not write');
});

test('resolveTargets — distinct repo parents, deduped', () => {
  const base = makeDir();
  fs.mkdirSync(path.join(base, 'groupA', 'repo1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'groupA', 'repo2'), { recursive: true });
  fs.mkdirSync(path.join(base, 'groupB', 'repo3'), { recursive: true });
  const config = { repos: {
    r1: { path: path.join(base, 'groupA', 'repo1') },
    r2: { path: path.join(base, 'groupA', 'repo2') },
    r3: { path: path.join(base, 'groupB', 'repo3') },
  } };
  const { targets, skipped } = resolveTargets(config);
  assert(targets.length === 2, `expected 2 parents, got ${targets.length}: ${targets.join(', ')}`);
  assert(skipped.length === 0, `unexpected skips: ${skipped.map(s => s.dir).join(', ')}`);
});

test('resolveTargets — skips filesystem root, home dir, and ~/.claude', () => {
  const home = os.homedir();
  const driveRoot = path.parse(home).root; // e.g. C:\ or /
  const config = { repos: {
    atRoot: { path: path.join(driveRoot, 'lone-repo') },              // parent = drive root
    atHome: { path: path.join(home, 'some-repo') },                   // parent = home
    inClaude: { path: path.join(home, '.claude', 'plugins', 'marketplaces', 'pipecrew') },
  } };
  const { targets, skipped } = resolveTargets(config);
  assert(targets.length === 0, `expected 0 targets, got: ${targets.join(', ')}`);
  assert(skipped.length === 3, `expected 3 skips, got ${skipped.length}`);
  assert(skipped.some(s => s.reason === 'filesystem root'), 'drive root not skipped');
  assert(skipped.some(s => s.reason === 'home directory'), 'home dir not skipped');
  assert(skipped.some(s => s.reason.includes('.claude')), '~/.claude not skipped');
});

test('resolveTargets — monorepo parent inside a git repo hoists above the repo', () => {
  const base = makeDir();
  const repoTop = path.join(base, 'holding', 'monorepo');
  fs.mkdirSync(path.join(repoTop, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repoTop, 'web-api'), { recursive: true });
  fs.mkdirSync(path.join(repoTop, 'worker'), { recursive: true });
  const config = { repos: {
    api: { path: path.join(repoTop, 'web-api') },
    worker: { path: path.join(repoTop, 'worker') },
  } };
  const { targets, skipped, hoisted } = resolveTargets(config);
  const expected = path.join(base, 'holding').replace(/\\/g, '/');
  assert(targets.length === 1 && targets[0] === expected,
    `expected hoist to ${expected}, got: ${targets.join(', ')}`);
  assert(hoisted.length === 1 && hoisted[0].to === expected, 'hoist not reported');
  assert(skipped.length === 0, `unexpected skips: ${skipped.map(s => s.dir).join(', ')}`);
});

test('parseBlocks round-trips a rendered block', () => {
  const ws = makeWorkspace('acme');
  const block = renderBlock('acme', ws);
  const blocks = parseBlocks(block);
  assert(blocks.length === 1, `expected 1 block, got ${blocks.length}`);
  assert(blocks[0].slug === 'acme', 'slug not parsed');
  assert(blocks[0].dir === ws.replace(/\\/g, '/'), 'dir attr not parsed');
  assert(blocks[0].raw === block, 'raw block must round-trip exactly');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
