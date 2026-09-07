#!/usr/bin/env node
/**
 * Unit tests for rehydrate-config.js (the /join config transform).
 * Zero deps: run with `node rehydrate-config.test.js`.
 */
const { rehydrate, normRoot, joinPath } = require('./rehydrate-config');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// A portable config as sync-memory.js would emit it: `dir` + optional `repo_url`,
// `path` stripped, `${REPOS_ROOT}` placeholder + markers present.
function portable() {
  return {
    _portable: true,
    _repos_root_note: 'Absolute paths stripped. On a fresh clone, run /pipecrew:join ...',
    repos_root: '${REPOS_ROOT}',
    workspace: { name: 'Acme', slug: 'acme', primary_language: 'en' },
    repos: {
      'acme-backend':  { dir: 'acme-backend',  repo_url: 'git@github.com:acme/acme-backend.git',  type: 'spring-boot', role: 'api-service' },
      'acme-frontend': { dir: 'acme-frontend', repo_url: 'git@github.com:acme/acme-frontend.git', type: 'react',       role: 'frontend' },
    },
    services: { 'acme-backend': { repo: 'acme-backend', spec_policy: 'code-first' } },
  };
}

// Mirror of sync-memory.js regeneratePortableConfig() path logic — lets the
// round-trip test assert rehydrate() truly inverts the generator.
function toPortable(cfg, reposRoot) {
  const p = JSON.parse(JSON.stringify(cfg));
  p._portable = true;
  p.repos_root = reposRoot ? '${REPOS_ROOT}' : undefined;
  for (const r of Object.values(p.repos || {})) {
    if (r.path) {
      const root = reposRoot.replace(/\\/g, '/');
      const rp = r.path.replace(/\\/g, '/');
      r.dir = rp.startsWith(root) ? rp.slice(root.length).replace(/^[/\\]/, '') : r.path.split('/').pop();
      delete r.path;
    }
  }
  return p;
}

console.log('\nrehydrate-config tests\n');

test('default --repos-root: path = {root}/{key}, dir/markers stripped, repo_url kept', () => {
  const { config, unresolved } = rehydrate(portable(), { reposRoot: '/Users/bob/src/acme' });
  eq(unresolved.length, 0, 'no unresolved');
  eq(config.repos['acme-backend'].path, '/Users/bob/src/acme/acme-backend', 'backend path');
  eq(config.repos['acme-frontend'].path, '/Users/bob/src/acme/acme-frontend', 'frontend path');
  assert(!('dir' in config.repos['acme-backend']), 'dir stripped');
  assert(!('_portable' in config), '_portable stripped');
  assert(!('repos_root' in config), 'repos_root stripped');
  assert(!('_repos_root_note' in config), 'note stripped');
  eq(config.repos['acme-backend'].repo_url, 'git@github.com:acme/acme-backend.git', 'repo_url preserved');
});

test('explicit --map wins over --repos-root (point-to-local an existing copy)', () => {
  const { config } = rehydrate(portable(), {
    reposRoot: '/Users/bob/src/acme',
    map: { 'acme-frontend': 'D:/existing/my-frontend' },
  });
  eq(config.repos['acme-backend'].path, '/Users/bob/src/acme/acme-backend', 'unmapped uses root');
  eq(config.repos['acme-frontend'].path, 'D:/existing/my-frontend', 'mapped uses override');
});

test('backward compat: portable without repo_url still rehydrates', () => {
  const p = portable();
  delete p.repos['acme-backend'].repo_url;
  delete p.repos['acme-frontend'].repo_url;
  const { config, unresolved } = rehydrate(p, { reposRoot: '/root' });
  eq(unresolved.length, 0, 'no unresolved');
  eq(config.repos['acme-backend'].path, '/root/acme-backend', 'path still built');
  assert(!('repo_url' in config.repos['acme-backend']), 'no repo_url invented');
});

test('drive-root repos_root survives (C: -> C:/key, not the drive-relative C:key)', () => {
  const { config } = rehydrate(portable(), { reposRoot: 'C:' });
  eq(config.repos['acme-backend'].path, 'C:/acme-backend', 'drive-root joined correctly');
});

test('--skip drops the repo AND any service referencing it', () => {
  const { config } = rehydrate(portable(), { reposRoot: '/root', skip: new Set(['acme-backend']) });
  assert(!('acme-backend' in config.repos), 'repo dropped');
  assert(!('acme-backend' in config.services), 'orphaned service dropped');
  assert('acme-frontend' in config.repos, 'other repo kept');
});

test('unresolved: no map and no repos-root -> reported, not thrown', () => {
  const { unresolved } = rehydrate(portable(), {});
  eq(unresolved.length, 2, 'both repos unresolved');
  assert(unresolved.includes('acme-backend') && unresolved.includes('acme-frontend'), 'lists both');
});

test('FULL round-trip: config -> portable -> rehydrate reproduces paths under a new root', () => {
  const original = {
    workspace: { name: 'Acme', slug: 'acme' },
    repos: {
      'acme-backend':  { path: 'C:/work/acme/acme-backend',  type: 'spring-boot', role: 'api-service' },
      'acme-frontend': { path: 'C:/work/acme/acme-frontend', type: 'react',       role: 'frontend' },
    },
    services: {},
  };
  const p = toPortable(original, 'C:/work/acme');
  eq(p.repos['acme-backend'].dir, 'acme-backend', 'portable dir == key for clean layout');
  const { config } = rehydrate(p, { reposRoot: '/team/pc' });
  eq(config.repos['acme-backend'].path, '/team/pc/acme-backend', 'rebuilt under teammate root');
  eq(config.repos['acme-frontend'].path, '/team/pc/acme-frontend', 'rebuilt under teammate root');
});

test('normRoot/joinPath helpers', () => {
  eq(normRoot('C:\\a\\b\\'), 'C:/a/b', 'backslashes + trailing slash');
  eq(normRoot('C:'), 'C:', 'bare drive preserved');
  eq(joinPath('C:', 'x'), 'C:/x', 'drive-root join');
  eq(joinPath('/root/', '/x'), '/root/x', 'no double slash');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
