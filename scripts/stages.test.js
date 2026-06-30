#!/usr/bin/env node
/**
 * Unit tests for stages.js — the canonical pipeline-stage vocabulary.
 * Zero deps: run with `node stages.test.js`.
 */

const { STAGES, ROLE_TO_STAGE, phaseToStage, resolveStage, isStage } = require('./stages.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

test('STAGES is the six ordered chapters', () => {
  eq(STAGES.join(','), 'understand,contract,build,verify,ship,learn');
});

test('phaseToStage covers every /deliver phase format', () => {
  eq(phaseToStage('1'), 'understand', 'requirements');
  eq(phaseToStage('2'), 'understand', 'architecture');
  eq(phaseToStage('3'), 'contract', 'spec');
  eq(phaseToStage('3a'), 'contract', 'contract-edit');
  eq(phaseToStage('3b'), 'contract', 'spec-edit');
  eq(phaseToStage('4'), 'contract', 'sync');
  eq(phaseToStage('4.5'), 'contract', 'plan');
  eq(phaseToStage('4.5-adjust-r2'), 'contract', 'plan sub-phase');
  eq(phaseToStage('5'), 'build', 'impl');
  eq(phaseToStage('5a'), 'build', 'backend');
  eq(phaseToStage('5d-addendum'), 'build', 'impl suffix');
  eq(phaseToStage('5.5'), 'verify', 'review');
  eq(phaseToStage('5.5-fix-r2'), 'verify', 'fix round');
  eq(phaseToStage('5.75'), 'verify', 'security');
  eq(phaseToStage('6'), 'verify', 'assess');
  eq(phaseToStage('7'), 'ship', 'report');
  eq(phaseToStage('8'), 'ship', 'publish');
});

test('phaseToStage returns null for unknown / empty', () => {
  eq(phaseToStage(''), null);
  eq(phaseToStage(null), null);
  eq(phaseToStage('—'), null);
  eq(phaseToStage('99'), null);
});

test('resolveStage is role-first (feedback-learner is the key case)', () => {
  // phase 8 alone → ship, but the loop role pins it to learn.
  eq(phaseToStage('8'), 'ship', 'phase-only');
  eq(resolveStage('loop', '8'), 'learn', 'role wins');
  // task-planner (foreman) in phase 4.5 → contract via either path.
  eq(resolveStage('foreman', '4.5'), 'contract');
});

test('resolveStage falls back to phase when role is unknown', () => {
  eq(resolveStage('some-new-agent', '5a'), 'build');
  eq(resolveStage(null, '5.5'), 'verify');
  eq(resolveStage('mystery', '99'), null, 'truly unknown → null');
});

test('resolveStage honours a valid emitted stage_group over derivation', () => {
  eq(resolveStage('bruno', '5a', 'ship'), 'ship', 'emitted canonical wins');
  eq(resolveStage('bruno', '5a', 'NOPE'), 'build', 'invalid emitted ignored → derive');
});

test('every ROLE_TO_STAGE target is a canonical stage', () => {
  for (const [role, stage] of Object.entries(ROLE_TO_STAGE)) {
    if (!isStage(stage)) throw new Error(`role ${role} maps to non-stage ${stage}`);
  }
});

test('isStage validates membership', () => {
  eq(isStage('build'), true);
  eq(isStage('BUILD'), true);
  eq(isStage('deploy'), false);
  eq(isStage(null), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
