#!/usr/bin/env node
'use strict';
/** Unit tests for siteview-fleet/launch.js resolver. Zero deps, plain assert. */
const assert = require('assert');
const path = require('path');
const { resolveLaunch, passthroughArgs, npmInstallCmd } = require('./launch.js');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const NONE = () => false;               // existsSync: nothing on disk
const NOWHICH = () => null;             // which: nothing on PATH

ok('prefers $PIPECREW_SITEVIEW_DIR when its bin exists', () => {
  const dir = path.join('X:', 'custom', 'siteview');
  const binP = path.join(dir, 'bin', 'pipecrew-siteview.js');
  const plan = resolveLaunch({
    env: { PIPECREW_SITEVIEW_DIR: dir },
    homedir: path.join('H:', 'home'),
    existsSync: (p) => p === binP,
    which: NOWHICH,
  });
  assert.strictEqual(plan.kind, 'node');
  assert.deepStrictEqual(plan.args, [binP]);
  assert.ok(/PIPECREW_SITEVIEW_DIR/.test(plan.note));
});

ok('falls back to the ~/pipecrew-siteview clone', () => {
  const home = path.join('H:', 'home');
  const binP = path.join(home, 'pipecrew-siteview', 'bin', 'pipecrew-siteview.js');
  const plan = resolveLaunch({
    env: {},
    homedir: home,
    existsSync: (p) => p === binP,
    which: NOWHICH,
  });
  assert.strictEqual(plan.kind, 'node');
  assert.deepStrictEqual(plan.args, [binP]);
});

ok('uses a global bin on PATH when no dir/clone exists', () => {
  const binPath = path.join('U:', 'bin', 'pipecrew-siteview');
  const plan = resolveLaunch({
    env: {}, homedir: path.join('H:', 'home'),
    existsSync: NONE,
    which: (n) => (n === 'pipecrew-siteview' ? binPath : null),
  });
  assert.strictEqual(plan.kind, 'bin');
  assert.strictEqual(plan.cmd, binPath);
});

ok('falls through to npx when nothing is installed', () => {
  const plan = resolveLaunch({ env: {}, homedir: path.join('H:', 'home'), existsSync: NONE, which: NOWHICH });
  assert.strictEqual(plan.kind, 'npx');
  assert.deepStrictEqual(plan.args, ['--yes', 'pipecrew-siteview']);
});

ok('returns null when npx is disallowed and nothing resolves', () => {
  const plan = resolveLaunch({ env: {}, homedir: path.join('H:', 'home'), existsSync: NONE, which: NOWHICH, allowNpx: false });
  assert.strictEqual(plan, null);
});

ok('precedence: dir beats clone beats PATH', () => {
  const dir = path.join('X:', 'd');
  const home = path.join('H:', 'home');
  const plan = resolveLaunch({
    env: { PIPECREW_SITEVIEW_DIR: dir }, homedir: home,
    existsSync: () => true,                    // both dir bin AND clone bin exist
    which: () => path.join('U:', 'bin', 'pipecrew-siteview'),
  });
  assert.deepStrictEqual(plan.args, [path.join(dir, 'bin', 'pipecrew-siteview.js')]);
});

ok('passthroughArgs keeps only the flags the standalone understands', () => {
  const kept = passthroughArgs(['--port=5200', '--demo', '--workspace=dal', '--projects-dir=/p', '--no-open', '--evil']);
  assert.deepStrictEqual(kept, ['--port=5200', '--demo', '--projects-dir=/p', '--no-open']);
});

ok('npmInstallCmd is the global-install command with a platform-correct npm', () => {
  const { cmd, args } = npmInstallCmd();
  assert.deepStrictEqual(args, ['install', '-g', 'pipecrew-siteview']);
  assert.ok(cmd === 'npm' || cmd === 'npm.cmd');   // .cmd on Windows
});

console.log(`\n${passed} tests passed.`);
