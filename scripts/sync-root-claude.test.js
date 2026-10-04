#!/usr/bin/env node
/**
 * Unit tests for sync-root-claude.js — one test per behavior branch.
 * Zero deps: run with `node sync-root-claude.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensure, remove, resolveTargets, renderBlock, parseBlocks, ensureUserBreadcrumb } = require('./sync-root-claude');

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

function readAgents(parent) {
  return fs.readFileSync(path.join(parent, 'AGENTS.md'), 'utf8');
}
function readClaude(parent) {
  return fs.readFileSync(path.join(parent, 'CLAUDE.md'), 'utf8');
}

console.log('\nsync-root-claude tests\n');

test('creates AGENTS.md + CLAUDE.md shim at the repo parent', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'created', `expected created, got ${r.action}`);
  assert(r.target === path.join(parent, 'AGENTS.md'), `target must be AGENTS.md, got ${r.target}`);
  const body = readAgents(parent);
  assert(body.includes('<!-- pipecrew:workspace acme dir='), 'workspace block marker missing');
  assert(body.includes('/context/platform.md`'), 'platform.md pointer missing');
  assert(body.includes('`acme-troubleshooter`'), 'concrete agent name missing');
  assert(body.includes('/pipecrew:deliver'), 'routing table missing');
  assert(body.includes('pipecrew:solution-architect'), 'agent table missing');
  assert(readClaude(parent) === '@AGENTS.md\n', 'CLAUDE.md must be exactly the one-line shim');
  assert(r.warnings.length === 0, `unexpected warnings: ${r.warnings.join('; ')}`);
});

test('idempotent — second run reports unchanged, both files byte-identical', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const beforeAgents = readAgents(parent);
  const beforeClaude = readClaude(parent);
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'unchanged', `expected unchanged, got ${r.action}`);
  assert(readAgents(parent) === beforeAgents, 'AGENTS.md changed on idempotent re-run');
  assert(readClaude(parent) === beforeClaude, 'shim changed on idempotent re-run');
});

test('two workspaces sharing one repo parent → two blocks, body once, sorted', () => {
  const parent = makeDir();
  const wsZ = makeWorkspace('zeta');
  const wsA = makeWorkspace('acme');
  ensure(parent, 'zeta', wsZ);
  const r = ensure(parent, 'acme', wsA);
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  const body = readAgents(parent);
  const acmeIdx = body.indexOf('### acme');
  const zetaIdx = body.indexOf('### zeta');
  assert(acmeIdx !== -1 && zetaIdx !== -1, 'both workspace blocks must be present');
  assert(acmeIdx < zetaIdx, 'blocks must be sorted by slug');
  const routingCount = body.split('Routing user asks').length - 1;
  assert(routingCount === 1, `static body must appear exactly once, found ${routingCount}`);
});

test('migration — pre-parity plugin-owned CLAUDE.md → AGENTS.md + shim, blocks carried', () => {
  const parent = makeDir();
  const wsOld = makeWorkspace('oldws');
  // Simulate a pre-parity file: full template body in CLAUDE.md (dispatcher sentinel + container).
  const legacyBody = [
    '# PipeCrew — this directory hosts PipeCrew-managed repos',
    '',
    '<!-- pipecrew:root-dispatcher — placed by PipeCrew. -->',
    '',
    '<!-- pipecrew:workspaces -->',
    renderBlock('oldws', wsOld),
    '<!-- /pipecrew:workspaces -->',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), legacyBody);
  const wsNew = makeWorkspace('newws');
  const r = ensure(parent, 'newws', wsNew);
  assert(r.migrated === true, 'migration flag expected');
  assert(r.action === 'created', `AGENTS.md should be created, got ${r.action}`);
  const agents = readAgents(parent);
  assert(agents.includes('### newws'), 'new workspace block missing from AGENTS.md');
  assert(agents.includes('### oldws'), 'carried legacy block missing from AGENTS.md');
  assert(readClaude(parent) === '@AGENTS.md\n', 'legacy CLAUDE.md must become the one-line shim');
});

test('legacy mode — hand-authored CLAUDE.md with our container is maintained in place', () => {
  const parent = makeDir();
  const wsA = makeWorkspace('acme');
  // Simulate the pre-parity "appended" shape: user content + container, NO dispatcher sentinel.
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), [
    '# My rules', '', 'Always use tabs.', '',
    '<!-- pipecrew:workspaces -->',
    renderBlock('acme', wsA),
    '<!-- /pipecrew:workspaces -->', '',
  ].join('\n'));
  const wsB = makeWorkspace('beta');
  const r = ensure(parent, 'beta', wsB);
  assert(r.legacy === true, 'legacy flag expected');
  assert(r.target === path.join(parent, 'CLAUDE.md'), 'legacy mode must target CLAUDE.md');
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'legacy mode must not create AGENTS.md');
  const body = readClaude(parent);
  assert(body.startsWith('# My rules'), 'user content must stay first');
  assert(body.includes('### acme') && body.includes('### beta'), 'both blocks expected in place');
});

test('hand-authored CLAUDE.md without markers → AGENTS.md created, import line appended', () => {
  const parent = makeDir();
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), '# My rules\n\nAlways use tabs.\n');
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'created', `AGENTS.md should be created, got ${r.action}`);
  assert(readAgents(parent).includes('### acme'), 'workspace block missing from AGENTS.md');
  const claude = readClaude(parent);
  assert(claude.startsWith('# My rules'), 'user content must stay first and untouched');
  assert(claude.includes('Always use tabs.'), 'user content lost');
  assert(claude.trimEnd().endsWith('@AGENTS.md'), 'import line must be appended to hand-authored CLAUDE.md');
  // Re-run must not duplicate the import line.
  ensure(parent, 'acme', ws);
  assert((readClaude(parent).split('@AGENTS.md').length - 1) === 1, 'import line duplicated on re-run');
});

test('hand-authored AGENTS.md gets the managed section appended, content intact', () => {
  const parent = makeDir();
  fs.writeFileSync(path.join(parent, 'AGENTS.md'), '# My agents notes\n\nKeep calm.\n');
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws);
  assert(r.action === 'appended', `expected appended, got ${r.action}`);
  const body = readAgents(parent);
  assert(body.startsWith('# My agents notes'), 'user content must stay first');
  assert(body.includes('### acme'), 'workspace block missing');
  assert(!body.includes('Routing user asks'), 'appended mode must not inject the full template body');
  assert(readClaude(parent) === '@AGENTS.md\n', 'shim must still be written');
});

test('re-run refreshes a stale block (workspace dir moved)', () => {
  const parent = makeDir();
  const ws1 = makeWorkspace('acme');
  ensure(parent, 'acme', ws1);
  const ws2 = makeWorkspace('acme'); // same slug, new location
  ensure(parent, 'acme', ws2);
  const body = readAgents(parent);
  assert(!body.includes(ws1.replace(/\\/g, '/')), 'old workspace dir still referenced');
  assert(body.includes(ws2.replace(/\\/g, '/')), 'new workspace dir missing');
  assert((body.split('### acme').length - 1) === 1, 'slug block must not duplicate');
});

test('user edits outside the container are preserved', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const edited = readAgents(parent) + '\n## My own notes\n\nHands off this section.\n';
  fs.writeFileSync(path.join(parent, 'AGENTS.md'), edited);
  const ws2 = makeWorkspace('beta');
  ensure(parent, 'beta', ws2);
  const body = readAgents(parent);
  assert(body.includes('Hands off this section.'), 'user section was lost');
  assert(body.includes('### beta'), 'new workspace block not added');
});

test('self-pruning — a workspace whose dir is gone drops out on the next run', () => {
  const parent = makeDir();
  const wsKeep = makeWorkspace('keep');
  const wsGone = makeWorkspace('gone');
  ensure(parent, 'gone', wsGone);
  ensure(parent, 'keep', wsKeep);
  assert(readAgents(parent).includes('### gone'), 'precondition: gone listed');
  fs.rmSync(wsGone, { recursive: true, force: true });
  const r = ensure(parent, 'keep', wsKeep);
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  assert(!readAgents(parent).includes('### gone'), 'stale workspace block not pruned');
});

test('malformed container markers in AGENTS.md → throws, file untouched', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const corrupted = readAgents(parent) + '\n<!-- pipecrew:workspaces -->\n';
  fs.writeFileSync(path.join(parent, 'AGENTS.md'), corrupted);
  let threw = false;
  try { ensure(parent, 'acme', ws); } catch { threw = true; }
  assert(threw, 'expected throw on duplicated container marker');
  assert(readAgents(parent) === corrupted, 'file must be untouched on marker error');
});

test('dry-run writes nothing', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  const r = ensure(parent, 'acme', ws, { dryRun: true });
  assert(r.action === 'created', `expected created, got ${r.action}`);
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'dry-run must not write AGENTS.md');
  assert(!fs.existsSync(path.join(parent, 'CLAUDE.md')), 'dry-run must not write the shim');
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

test('user breadcrumb — created when absent, lists only live workspaces, sorted', () => {
  const target = path.join(makeDir(), 'CLAUDE.md');
  const wsB = makeWorkspace('beta');
  const wsA = makeWorkspace('acme');
  const dead = path.join(makeDir(), 'dead'); // dir without config.json → not alive
  fs.mkdirSync(dead, { recursive: true });
  const r = ensureUserBreadcrumb(target, [
    { slug: 'beta', path: wsB }, { slug: 'dead', path: dead }, { slug: 'acme', path: wsA },
  ]);
  assert(r.action === 'created', `expected created, got ${r.action}`);
  const body = fs.readFileSync(target, 'utf8');
  assert(body.includes('<!-- pipecrew:machine -->'), 'machine markers missing');
  assert(body.includes('- `acme`') && body.includes('- `beta`'), 'live workspaces missing');
  assert(!body.includes('- `dead`'), 'dead workspace must be excluded');
  assert(body.indexOf('- `acme`') < body.indexOf('- `beta`'), 'entries must be sorted');
  assert(!body.includes('Routing user asks'), 'breadcrumb must not carry the routing table');
});

test('user breadcrumb — appended to an existing personal CLAUDE.md, content intact', () => {
  const target = path.join(makeDir(), 'CLAUDE.md');
  fs.writeFileSync(target, '# Personal prefs\n\nBe terse.\n');
  const ws = makeWorkspace('acme');
  const r = ensureUserBreadcrumb(target, [{ slug: 'acme', path: ws }]);
  assert(r.action === 'appended', `expected appended, got ${r.action}`);
  const body = fs.readFileSync(target, 'utf8');
  assert(body.startsWith('# Personal prefs'), 'user content must stay first');
  assert(body.includes('Be terse.'), 'user content lost');
  assert(body.includes('- `acme`'), 'workspace entry missing');
});

test('user breadcrumb — idempotent update, block replaced in place', () => {
  const target = path.join(makeDir(), 'CLAUDE.md');
  const wsA = makeWorkspace('acme');
  ensureUserBreadcrumb(target, [{ slug: 'acme', path: wsA }]);
  const r1 = ensureUserBreadcrumb(target, [{ slug: 'acme', path: wsA }]);
  assert(r1.action === 'unchanged', `expected unchanged, got ${r1.action}`);
  const wsB = makeWorkspace('beta');
  const r2 = ensureUserBreadcrumb(target, [{ slug: 'acme', path: wsA }, { slug: 'beta', path: wsB }]);
  assert(r2.action === 'updated', `expected updated, got ${r2.action}`);
  const body = fs.readFileSync(target, 'utf8');
  assert((body.split('<!-- pipecrew:machine -->').length - 1) === 1, 'block must not duplicate');
});

test('user breadcrumb — malformed markers throw, file untouched', () => {
  const target = path.join(makeDir(), 'CLAUDE.md');
  const ws = makeWorkspace('acme');
  ensureUserBreadcrumb(target, [{ slug: 'acme', path: ws }]);
  const corrupted = fs.readFileSync(target, 'utf8') + '\n<!-- pipecrew:machine -->\n';
  fs.writeFileSync(target, corrupted);
  let threw = false;
  try { ensureUserBreadcrumb(target, [{ slug: 'acme', path: ws }]); } catch { threw = true; }
  assert(threw, 'expected throw on duplicated machine marker');
  assert(fs.readFileSync(target, 'utf8') === corrupted, 'file must be untouched on marker error');
});

test('remove — plugin-owned file with only this block → both files deleted', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  ensure(parent, 'acme', ws);
  const r = remove(parent, 'acme');
  assert(r.action === 'removed', `expected removed, got ${r.action}`);
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'AGENTS.md must be deleted');
  assert(!fs.existsSync(path.join(parent, 'CLAUDE.md')), 'one-liner shim must be deleted');
});

test('remove — other workspace blocks survive, file kept', () => {
  const parent = makeDir();
  const wsA = makeWorkspace('acme');
  const wsB = makeWorkspace('beta');
  ensure(parent, 'acme', wsA);
  ensure(parent, 'beta', wsB);
  const r = remove(parent, 'acme');
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  const body = readAgents(parent);
  assert(!body.includes('### acme'), 'removed block still present');
  assert(body.includes('### beta'), 'other workspace block lost');
  assert(fs.existsSync(path.join(parent, 'CLAUDE.md')), 'shim must survive while file remains');
});

test('remove — hand-authored legacy CLAUDE.md keeps user content, loses only the block', () => {
  const parent = makeDir();
  const ws = makeWorkspace('acme');
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), [
    '# My rules', '', 'Always use tabs.', '',
    '<!-- pipecrew:workspaces -->',
    renderBlock('acme', ws),
    '<!-- /pipecrew:workspaces -->', '',
  ].join('\n'));
  const r = remove(parent, 'acme');
  assert(r.action === 'updated', `expected updated, got ${r.action}`);
  assert(r.warnings.some(w => w.includes('hand-authored')), 'hand-authored warning expected');
  const body = readClaude(parent);
  assert(body.startsWith('# My rules') && body.includes('Always use tabs.'), 'user content lost');
  assert(!body.includes('### acme'), 'block not removed');
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'remove must not create AGENTS.md');
});

test('remove — nothing there → absent, nothing created', () => {
  const parent = makeDir();
  const r = remove(parent, 'acme');
  assert(r.action === 'absent', `expected absent, got ${r.action}`);
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'remove must not create files');
});

test('CLI — root_context:false skips generation, exit 0, nothing written', () => {
  const base = makeDir();
  const parent = path.join(base, 'repos');
  fs.mkdirSync(path.join(parent, 'repo1'), { recursive: true });
  const wsDir = path.join(base, 'acme');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify({
    workspace: { slug: 'acme', root_context: false },
    repos: { repo1: { path: path.join(parent, 'repo1') } },
  }));
  const out = execFileSync(process.execPath, [path.join(__dirname, 'sync-root-claude.js'), `--config=${path.join(wsDir, 'config.json')}`], { encoding: 'utf8' });
  assert(out.includes('root_context is disabled'), `skip note expected, got: ${out}`);
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'disabled workspace must write nothing');
});

test('CLI — --remove works even when root_context is false', () => {
  const base = makeDir();
  const parent = path.join(base, 'repos');
  fs.mkdirSync(path.join(parent, 'repo1'), { recursive: true });
  const wsDir = path.join(base, 'acme');
  fs.mkdirSync(wsDir, { recursive: true });
  const configPath = path.join(wsDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspace: { slug: 'acme' },
    repos: { repo1: { path: path.join(parent, 'repo1') } },
  }));
  execFileSync(process.execPath, [path.join(__dirname, 'sync-root-claude.js'), `--config=${configPath}`], { encoding: 'utf8' });
  assert(fs.existsSync(path.join(parent, 'AGENTS.md')), 'precondition: file generated');
  // Flip the flag off, then clean up via --remove.
  fs.writeFileSync(configPath, JSON.stringify({
    workspace: { slug: 'acme', root_context: false },
    repos: { repo1: { path: path.join(parent, 'repo1') } },
  }));
  const out = execFileSync(process.execPath, [path.join(__dirname, 'sync-root-claude.js'), `--config=${configPath}`, '--remove'], { encoding: 'utf8' });
  assert(out.includes('removed'), `removed expected, got: ${out}`);
  assert(!fs.existsSync(path.join(parent, 'AGENTS.md')), 'file must be gone after --remove');
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
