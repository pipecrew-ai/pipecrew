#!/usr/bin/env node
/**
 * REPO_PROFILE validator.
 *
 * Validates the standalone JSON profile(s) emitted by the `repo-discoverer`
 * agent (Sonnet) during `/discover` Phase B2.0. Runs as a deterministic gate
 * at the end of B2.0, BEFORE the Opus `solution-architect` synthesis dispatch,
 * so a truncated / prose-wrapped / key-missing profile is caught cheaply here
 * instead of failing mid-synthesis (an expensive Opus retry).
 *
 * Contract enforced (see templates/blocks/block-schemas.md#repo_profile):
 *   - the file is bare JSON (no markdown fence, no BEGIN/END markers);
 *   - every key in the canonical example is present;
 *   - role-non-applicable fields are null (objects) or [] (arrays), never omitted;
 *   - `integrations` always carries its five sub-arrays;
 *   - `audit_findings[]` severities are in the known enum.
 *
 * Usage:
 *   node validate-repo-profile.js <file.json>          validate one profile
 *   node validate-repo-profile.js <repo-profiles dir>   validate every *.json
 *                                                       in the dir (skips
 *                                                       *example* fixtures)
 *
 * Exit codes:
 *   0 — all validated profiles are valid
 *   1 — at least one profile is invalid / unreadable / not JSON
 *   2 — usage error
 *
 * Schema reference: templates/blocks/block-schemas.md#repo_profile
 * Canonical example: templates/blocks/repo-profile.example.json
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const SPEC_POLICIES = ['api-first', 'code-first', 'no-api'];
const INTEGRATION_SUBARRAYS = [
  'outbound_http', 'outbound_events', 'outbound_storage',
  'inbound_http', 'inbound_events',
];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate one already-parsed profile object. Returns an array of error
 * strings (empty = valid).
 */
function validateProfile(p) {
  const errors = [];

  if (!isPlainObject(p)) {
    return ['root is not a JSON object'];
  }

  // --- schema_version: required integer ≥ 1 -------------------------------
  // The discover-cache (Win #6) uses this to invalidate stale cache entries
  // when the REPO_PROFILE shape changes. Bumping this in the canonical example
  // automatically forces a rescan on every workspace's next /discover run.
  if (!('schema_version' in p)) {
    errors.push('missing key "schema_version" (integer, set to 1 today; the canonical example carries the current value)');
  } else if (!Number.isInteger(p.schema_version) || p.schema_version < 1) {
    errors.push(`"schema_version" must be a positive integer (got ${JSON.stringify(p.schema_version)})`);
  }

  // --- required non-empty strings -----------------------------------------
  for (const f of ['repo_key', 'type', 'role', 'notes_for_architect']) {
    if (!nonEmptyString(p[f])) errors.push(`missing or empty string "${f}"`);
  }

  // --- description: present + string (empty allowed as escape hatch) ------
  if (!('description' in p)) {
    errors.push('missing key "description" (use "" when the discoverer could not extract a useful sentence, never omit)');
  } else if (typeof p.description !== 'string') {
    errors.push('"description" must be a string');
  }

  // --- keys that must be PRESENT (value may be null) ----------------------
  for (const f of ['framework', 'auth', 'persistence', 'tests',
                    'frontend_signals', 'infra_signals']) {
    if (!(f in p)) errors.push(`missing key "${f}" (use null when not applicable, never omit)`);
  }
  // endpoints OR event_handlers — at least one key present
  if (!('endpoints' in p) && !('event_handlers' in p)) {
    errors.push('missing both "endpoints" and "event_handlers" (api-services use endpoints, workers use event_handlers; the unused one is null)');
  }
  if (!('entities' in p)) {
    errors.push('missing key "entities" (use null for frontend/infra repos, never omit)');
  } else if (Array.isArray(p.entities)) {
    p.entities.forEach((e, i) => {
      const where = `entities[${i}]`;
      if (!isPlainObject(e)) { errors.push(`${where} must be an object`); return; }
      if (!nonEmptyString(e.name)) errors.push(`${where}.name must be a non-empty string`);
      if (!('purpose' in e)) {
        errors.push(`${where}.purpose missing (use "" when the discoverer would be guessing, never omit)`);
      } else if (typeof e.purpose !== 'string') {
        errors.push(`${where}.purpose must be a string`);
      }
    });
  }

  // --- required arrays (must be arrays, may be empty) ---------------------
  for (const f of ['key_conventions', 'constraints_observed', 'audit_findings', 'specs']) {
    if (!Array.isArray(p[f])) errors.push(`"${f}" must be an array (use [] when empty, never omit/null)`);
  }

  // --- framework (object|null); when present, needs a name ----------------
  if ('framework' in p && p.framework !== null) {
    if (!isPlainObject(p.framework)) {
      errors.push('"framework" must be an object or null');
    } else if (!nonEmptyString(p.framework.name)) {
      errors.push('"framework.name" must be a non-empty string when framework is not null');
    }
  }

  // --- integrations: always present, never null, five sub-arrays ----------
  if (!('integrations' in p) || p.integrations === null) {
    errors.push('"integrations" must be present and non-null (use the empty-arrays object for repos with no integrations)');
  } else if (!isPlainObject(p.integrations)) {
    errors.push('"integrations" must be an object');
  } else {
    for (const sub of INTEGRATION_SUBARRAYS) {
      if (!Array.isArray(p.integrations[sub])) {
        errors.push(`"integrations.${sub}" must be an array (use [] when none)`);
      }
    }
  }

  // --- audit_findings[] shape + severity enum -----------------------------
  if (Array.isArray(p.audit_findings)) {
    p.audit_findings.forEach((af, i) => {
      const where = `audit_findings[${i}]`;
      if (!isPlainObject(af)) { errors.push(`${where} must be an object`); return; }
      if (!SEVERITIES.includes(af.severity)) {
        errors.push(`${where}.severity "${af.severity}" not in ${SEVERITIES.join('/')}`);
      }
      if (!nonEmptyString(af.file)) errors.push(`${where}.file must be a non-empty string`);
      if (af.line === undefined || af.line === null ||
          (typeof af.line !== 'number' && typeof af.line !== 'string')) {
        errors.push(`${where}.line must be a number or string`);
      }
      if (!nonEmptyString(af.description)) errors.push(`${where}.description must be a non-empty string`);
    });
  }

  // --- specs[] shape ------------------------------------------------------
  if (Array.isArray(p.specs)) {
    p.specs.forEach((s, i) => {
      const where = `specs[${i}]`;
      if (!isPlainObject(s)) { errors.push(`${where} must be an object`); return; }
      if (!nonEmptyString(s.path)) errors.push(`${where}.path must be a non-empty string`);
      if (s.spec_policy_inferred !== undefined &&
          !SPEC_POLICIES.includes(s.spec_policy_inferred)) {
        errors.push(`${where}.spec_policy_inferred "${s.spec_policy_inferred}" not in ${SPEC_POLICIES.join('/')}`);
      }
    });
  }

  // --- metrics: object with boolean scan_truncated when present -----------
  if (!isPlainObject(p.metrics)) {
    errors.push('"metrics" must be an object');
  } else if (p.metrics.scan_truncated !== undefined &&
             typeof p.metrics.scan_truncated !== 'boolean') {
    errors.push('"metrics.scan_truncated" must be a boolean');
  }

  // --- frontend_signals / infra_signals: object or null -------------------
  for (const f of ['frontend_signals', 'infra_signals']) {
    if (f in p && p[f] !== null && !isPlainObject(p[f])) {
      errors.push(`"${f}" must be an object or null`);
    }
  }

  return errors;
}

/** Read + parse + validate one file path. Returns {file, errors[]}. */
function validateFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { file, errors: [`unreadable: ${e.message}`] }; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    return {
      file,
      errors: [`not valid JSON: ${e.message} (a markdown code fence or trailing prose around the JSON is the usual cause)`],
    };
  }
  return { file, errors: validateProfile(parsed) };
}

// ---------------------------------------------------------------------------

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node validate-repo-profile.js <profile.json | repo-profiles dir>');
    process.exit(2);
  }

  let stat;
  try { stat = fs.statSync(target); }
  catch (e) { console.error(`Not found: ${target}`); process.exit(1); }

  let files;
  if (stat.isDirectory()) {
    files = fs.readdirSync(target)
      .filter(n => n.endsWith('.json') && !n.toLowerCase().includes('example'))
      .sort()
      .map(n => path.join(target, n));
    if (files.length === 0) {
      console.error(`No *.json profiles found in ${target}`);
      process.exit(1);
    }
  } else {
    files = [target];
  }

  let invalid = 0;
  for (const f of files) {
    const { errors } = validateFile(f);
    const base = path.basename(f);
    if (errors.length) {
      invalid++;
      console.error(`INVALID  ${base} (${errors.length} error${errors.length > 1 ? 's' : ''}):`);
      for (const e of errors) console.error(`  - ${e}`);
    } else {
      console.log(`valid    ${base}`);
    }
  }

  if (invalid) {
    console.error(`\n${invalid}/${files.length} profile${files.length > 1 ? 's' : ''} invalid`);
    process.exit(1);
  }
  console.log(`\n${files.length} profile${files.length > 1 ? 's' : ''} valid`);
  process.exit(0);
}

main();
