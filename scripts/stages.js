#!/usr/bin/env node
/**
 * stages.js — the canonical pipeline-stage vocabulary, shared across consumers.
 *
 * A `/deliver` run's many phases group into SIX ordered chapters. This module
 * is the single source of truth for that grouping so the site-view rail, the
 * reporter, and the checkpoint validator all agree instead of each
 * re-implementing the map.
 *
 * Design note — `phase` is the source of truth, not an LLM-typed string. The
 * stage is DERIVED from the structured, already-validated `phase` field, with a
 * small set of ROLE exceptions for agents whose phase doesn't imply their
 * chapter (the feedback-learner runs in phase 8 / "publish" but is its own
 * Learn chapter). A checkpoint MAY also carry an explicit `stage_group` enum;
 * when present and valid it wins, but it is optional hardening — never the
 * authority. `resolveStage()` encodes that precedence: emitted → role → phase.
 *
 * Zero dependencies — pure Node stdlib, safe to require from any script.
 */

// The six canonical chapters, in pipeline order.
const STAGES = ['understand', 'contract', 'build', 'verify', 'ship', 'learn'];
const STAGE_SET = new Set(STAGES);

// Agent role → stage. Stable, and required for roles whose phase would map
// elsewhere (notably `loop`/feedback-learner, which runs in phase 8).
const ROLE_TO_STAGE = {
  pip: 'understand', archie: 'understand',
  yara: 'contract', foreman: 'contract',
  tya: 'build', bruno: 'build', pixel: 'build', echo: 'build', stratos: 'build',
  crit: 'verify', shield: 'verify', judge: 'verify',
  scribe: 'ship', sage: 'ship',
  loop: 'learn',
};

/**
 * Map a structured `phase` value to its canonical stage.
 * Coarser than the site-view's phase→label map (we only need chapter
 * granularity, not fix-round numbers), but covers the same phase formats:
 * 1, 2, 3, 3a, 3b, 4, 4.5(+sub), 5/5a-d(+suffix), 5.5(+fix), 5.75, 6, 7, 8.
 * Returns one of STAGES, or null when the phase is unknown/empty.
 */
function phaseToStage(phase) {
  if (!phase) return null;
  const p = String(phase).trim().toLowerCase();
  if (!p || p === '—') return null;
  // Verify chapter — review (+fix rounds), security, assessment.
  if (/^5\.5(\b|-)/.test(p)) return 'verify';   // 5.5, 5.5-fix, 5.5-fix-r2
  if (p === '5.75') return 'verify';
  if (p === '6') return 'verify';
  // Contract chapter — plan (4.5 + sub-phases) before the bare-5 impl test.
  if (/^4\.5(\b|-)/.test(p)) return 'contract';
  // Build chapter — 5, 5a-5d, plus suffixes like 5d-addendum (dotted 5.x
  // already handled above, so a bare 5-prefix is always implementation).
  if (/^5[a-z]?(-[a-z0-9]+)*$/.test(p)) return 'build';
  // Understand chapter.
  if (p === '1' || p === '2') return 'understand';
  // Remaining Contract phases — schemas / spec / sync.
  if (p === '3' || p === '3a' || p === '3b' || p === '4') return 'contract';
  // Ship chapter — report + publish.
  if (p === '7' || p === '8') return 'ship';
  return null;
}

/**
 * Resolve a character/event's canonical stage.
 * Precedence: explicit (valid) emitted stage → role → phase. Returns one of
 * STAGES, or null when nothing resolves (caller may apply its own fallback).
 */
function resolveStage(role, phase, emitted) {
  if (emitted && STAGE_SET.has(String(emitted).toLowerCase())) {
    return String(emitted).toLowerCase();
  }
  if (role && ROLE_TO_STAGE[role]) return ROLE_TO_STAGE[role];
  return phaseToStage(phase);
}

/** True when `value` is one of the canonical stage ids. */
function isStage(value) {
  return typeof value === 'string' && STAGE_SET.has(value.toLowerCase());
}

module.exports = { STAGES, ROLE_TO_STAGE, phaseToStage, resolveStage, isStage };
