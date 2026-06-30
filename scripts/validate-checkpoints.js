#!/usr/bin/env node
/**
 * Validator for runs/{skill}/{run_id}/checkpoints.jsonl.
 * Enforces the event schema documented in rules/observability.md.
 *
 * Usage:  node validate-checkpoints.js <path-to-checkpoints.jsonl>
 * Exit 0 = clean, 1 = hard-fail, 2 = soft warning.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const { STAGES } = require('./stages.js');

const ALLOWED_STAGE_GROUPS = new Set(STAGES);

const ALLOWED_EVENTS = new Set([
  'run_start', 'run_end',
  'phase_start', 'phase_end',
  'agent_start', 'agent_end', 'orch_checkpoint',
  'bash_slow', 'retry',
  'gate_open', 'gate_close',
]);

const ALLOWED_GATE_KINDS = new Set(['approval', 'clarify', 'fix-round']);

const ALLOWED_SKILLS = new Set([
  'discover', 'deliver', 'learn', 'review', 'assess', 'context-refresh',
  'onboard', 'feature', // 'onboard' and 'feature' kept for pre-rename checkpoints
]);

const ALLOWED_AGENT_STATUS = new Set(['ok', 'retry', 'failed', 'deferred']);
const ALLOWED_RUN_STATUS   = new Set(['completed', 'failed', 'aborted', 'resumed_later']);

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]*(-\d+)?$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function validate(lines) {
  const errors = [];
  const warnings = [];
  const seenRunIds = new Set();
  let sawRunStart = false;
  let sawRunEnd   = false;
  let prevTs      = null;

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (raw.trim() === '') return;

    let ev;
    try { ev = JSON.parse(raw); }
    catch (e) {
      errors.push(`line ${lineNo}: invalid JSON — ${e.message}`);
      return;
    }

    // Common fields
    for (const k of ['ts', 'event', 'skill', 'run_id']) {
      if (!(k in ev)) errors.push(`line ${lineNo}: missing required field "${k}"`);
    }
    if (ev.ts && !ISO_TS_RE.test(ev.ts)) {
      errors.push(`line ${lineNo}: ts "${ev.ts}" is not ISO8601 UTC (e.g., "2026-04-15T14:27:44Z")`);
    }
    if (ev.ts && prevTs && ev.ts < prevTs) {
      warnings.push(`line ${lineNo}: ts ${ev.ts} is before previous event ts ${prevTs} (non-monotonic)`);
    }
    prevTs = ev.ts || prevTs;

    if (ev.event && !ALLOWED_EVENTS.has(ev.event)) {
      errors.push(`line ${lineNo}: unknown event "${ev.event}"`);
    }
    if (ev.skill && !ALLOWED_SKILLS.has(ev.skill)) {
      errors.push(`line ${lineNo}: unknown skill "${ev.skill}"`);
    }
    if (ev.run_id && !RUN_ID_RE.test(ev.run_id)) {
      errors.push(`line ${lineNo}: run_id "${ev.run_id}" does not match {YYYY-MM-DD-HHMMSS}-{slug}`);
    }
    if (ev.run_id) seenRunIds.add(ev.run_id);
    // stage_group is optional, but when present must be a canonical chapter.
    if ('stage_group' in ev && !ALLOWED_STAGE_GROUPS.has(ev.stage_group)) {
      errors.push(`line ${lineNo}: stage_group "${ev.stage_group}" not in ${[...ALLOWED_STAGE_GROUPS].join('|')}`);
    }

    // Event-specific
    switch (ev.event) {
      case 'run_start':
        sawRunStart = true;
        if (lineNo !== 1) warnings.push(`line ${lineNo}: run_start should be the first line`);
        require_(ev, ['workspace_slug'], lineNo, errors);
        break;
      case 'run_end':
        sawRunEnd = true;
        require_(ev, ['status', 'duration_ms'], lineNo, errors);
        if (ev.status && !ALLOWED_RUN_STATUS.has(ev.status)) {
          errors.push(`line ${lineNo}: run_end status "${ev.status}" not in ${[...ALLOWED_RUN_STATUS].join('|')}`);
        }
        checkNonNegInt(ev, 'duration_ms', lineNo, errors);
        break;
      case 'phase_start':
        require_(ev, ['phase', 'stage'], lineNo, errors);
        break;
      case 'phase_end':
        require_(ev, ['phase', 'stage', 'duration_ms'], lineNo, errors);
        checkNonNegInt(ev, 'duration_ms', lineNo, errors);
        break;
      case 'agent_start':
        require_(ev, ['agent_type', 'description'], lineNo, errors);
        break;
      case 'agent_end':
        require_(ev, ['agent_type', 'description', 'status'], lineNo, errors);
        if (ev.status && !ALLOWED_AGENT_STATUS.has(ev.status)) {
          errors.push(`line ${lineNo}: agent_end status "${ev.status}" not in ${[...ALLOWED_AGENT_STATUS].join('|')}`);
        }
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens', 'tool_uses', 'duration_ms', 'audit_findings_count']) {
          if (k in ev) checkNonNegInt(ev, k, lineNo, errors);
        }
        break;
      case 'orch_checkpoint':
        require_(ev, ['jsonl_offset', 'orch_since_last'], lineNo, errors);
        checkNonNegInt(ev, 'jsonl_offset', lineNo, errors);
        if (ev.orch_since_last && typeof ev.orch_since_last === 'object') {
          for (const k of ['input_tokens', 'output_tokens']) {
            if (!(k in ev.orch_since_last)) {
              errors.push(`line ${lineNo}: orch_since_last missing required "${k}"`);
            } else if (!Number.isInteger(ev.orch_since_last[k]) || ev.orch_since_last[k] < 0) {
              errors.push(`line ${lineNo}: orch_since_last.${k} must be non-negative integer`);
            }
          }
        } else {
          errors.push(`line ${lineNo}: orch_since_last must be an object`);
        }
        break;
      case 'bash_slow':
        require_(ev, ['duration_ms', 'cmd_summary'], lineNo, errors);
        if (Number.isInteger(ev.duration_ms) && ev.duration_ms < 5000) {
          errors.push(`line ${lineNo}: bash_slow duration_ms=${ev.duration_ms} below 5000ms threshold`);
        }
        if (typeof ev.cmd_summary === 'string' && ev.cmd_summary.length > 60) {
          errors.push(`line ${lineNo}: cmd_summary length ${ev.cmd_summary.length} exceeds 60 chars`);
        }
        break;
      case 'retry':
        require_(ev, ['agent_type', 'description', 'retry_reason'], lineNo, errors);
        break;
      case 'gate_open':
        require_(ev, ['phase', 'gate', 'question'], lineNo, errors);
        if (ev.gate && !ALLOWED_GATE_KINDS.has(ev.gate)) {
          errors.push(`line ${lineNo}: gate_open gate "${ev.gate}" not in ${[...ALLOWED_GATE_KINDS].join('|')}`);
        }
        break;
      case 'gate_close':
        checkNonNegInt(ev, 'duration_ms', lineNo, errors);
        break;
    }
  });

  // Run-level invariants (warnings)
  if (seenRunIds.size > 1) {
    warnings.push(`file contains events from ${seenRunIds.size} run_ids — expected 1 per checkpoints.jsonl`);
  }
  if (!sawRunStart && lines.some(l => l.trim() !== '')) {
    warnings.push('no run_start event seen — reporter will struggle to bracket the run');
  }
  if (!sawRunEnd && lines.some(l => l.trim() !== '')) {
    warnings.push('no run_end event seen — run may have been aborted or still in progress');
  }

  return { errors, warnings };
}

function require_(ev, keys, lineNo, errors) {
  for (const k of keys) {
    if (!(k in ev)) errors.push(`line ${lineNo}: ${ev.event} missing required field "${k}"`);
  }
}
function checkNonNegInt(ev, key, lineNo, errors) {
  if (!(key in ev)) return;
  if (!Number.isInteger(ev[key]) || ev[key] < 0) {
    errors.push(`line ${lineNo}: ${key} must be non-negative integer (got ${JSON.stringify(ev[key])})`);
  }
}

// CLI entry
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node validate-checkpoints.js <checkpoints.jsonl path>');
    process.exit(1);
  }
  let body;
  try { body = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { console.error(`Failed to read ${filePath}: ${e.message}`); process.exit(1); }

  const { errors, warnings } = validate(body.split(/\r?\n/));
  for (const w of warnings) console.warn(`WARN:  ${w}`);
  for (const e of errors)   console.error(`ERROR: ${e}`);

  if (errors.length) {
    console.error(`\n${errors.length} hard-fail(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  if (warnings.length) {
    console.warn(`\nClean of hard-fails; ${warnings.length} warning(s) above.`);
    process.exit(2);
  }
  console.log(`Clean: ${filePath}`);
  process.exit(0);
}

module.exports = { validate };
