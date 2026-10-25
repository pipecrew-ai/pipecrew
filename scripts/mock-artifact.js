#!/usr/bin/env node
/**
 * mock-artifact.js — FR-8 artifact-validity contract helper.
 *
 * The single authoritative source for the {ws}/mocks/{feature-slug}/ layout
 * and validity rules shared by the /mock-requirements skill (writer) and
 * /deliver --from-mock (reader).
 *
 * CLI:
 *   --list [--workspace=<slug>]            list slugs under {ws}/mocks/; exit 0
 *   --validate=<slug> [--workspace=<slug>] validate one artifact; exit 0 valid,
 *                                          exit 1 invalid, exit 2 missing dir
 *   --mocks-dir=<absolute-path>            override workspace resolution (for
 *                                          testing: pass the mocks dir directly)
 *
 * FR-8 validity rule (exact):
 *   (a) {mocks_dir}/{slug}/MOCKS_INDEX.md  — must be present and non-empty
 *   (b) {mocks_dir}/{slug}/requirements.md — must contain a
 *       <!-- BEGIN REQUIREMENTS_INDEX --> block whose fenced ```json body
 *       parses as valid JSON with a top-level requirements[] of length >= 1
 *   (c) {mocks_dir}/{slug}/implementation-spec.md — must be present and contain
 *       <!-- BEGIN IMPLEMENTATION_SPEC --> / <!-- END IMPLEMENTATION_SPEC --> delimiters
 *       (the reader, /deliver --from-mock Phase 5b, extracts the spec by these markers)
 *   (d) {mocks_dir}/{slug}/screens/ — must exist and contain at least one *.html file
 *
 * Soft drift warnings (reported in result.warnings[]; do NOT fail validity): an
 * implementation-spec.md that references a `*.html` not present in screens/, or a
 * screen file whose name never appears in implementation-spec.md — either direction
 * signals the spec and the screens may have drifted out of sync after a mock change.
 *
 * Zero dependencies — pure Node stdlib.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let listMode     = false;
let validateSlug = null;
let workspaceArg = null;
let mocksDir     = null;  // override for tests

for (const arg of args) {
  if (arg === '--list')                         listMode     = true;
  else if (arg.startsWith('--validate='))       validateSlug = arg.slice('--validate='.length);
  else if (arg.startsWith('--workspace='))      workspaceArg = arg.slice('--workspace='.length);
  else if (arg.startsWith('--mocks-dir='))      mocksDir     = arg.slice('--mocks-dir='.length);
}

if (!listMode && !validateSlug) {
  console.error('usage: mock-artifact.js --list | --validate=<slug> [--workspace=<slug>] [--mocks-dir=<path>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve the mocks directory
// ---------------------------------------------------------------------------
function resolveMocksDir() {
  if (mocksDir) return mocksDir;  // test override — use as-is

  const registryScript = path.join(__dirname, 'workspace-registry.js');
  const registryArgs = ['--resolve', '--json'];
  if (workspaceArg) registryArgs.push(`--workspace=${workspaceArg}`);

  const r = spawnSync('node', [registryScript, ...registryArgs], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`workspace resolution failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
    process.exit(1);
  }

  let wsInfo;
  try { wsInfo = JSON.parse(r.stdout.trim()); }
  catch (e) {
    console.error(`workspace-registry.js returned non-JSON: ${r.stdout.trim()}`);
    process.exit(1);
  }

  // {root} = workspace parent; workspace lives at root/{slug}/
  const wsPath = path.join(wsInfo.root, wsInfo.slug);
  return path.join(wsPath, 'mocks');
}

// ---------------------------------------------------------------------------
// FR-8 validity check
// ---------------------------------------------------------------------------
/**
 * Validate one artifact slug.
 * Returns { valid: bool, defect: string|null, warnings: string[] }
 */
function validateArtifact(mDir, slug) {
  const artifactDir = path.join(mDir, slug);
  const warnings = [];

  // (a) MOCKS_INDEX.md must be present and non-empty
  const indexPath = path.join(artifactDir, 'MOCKS_INDEX.md');
  if (!fs.existsSync(indexPath)) {
    return { valid: false, defect: 'MOCKS_INDEX.md is missing', warnings };
  }
  const indexStat = fs.statSync(indexPath);
  if (indexStat.size === 0) {
    return { valid: false, defect: 'MOCKS_INDEX.md is empty', warnings };
  }

  // (b) requirements.md must contain a <!-- BEGIN REQUIREMENTS_INDEX --> block
  //     with a fenced ```json body that parses as valid JSON with requirements[].length >= 1
  const reqPath = path.join(artifactDir, 'requirements.md');
  if (!fs.existsSync(reqPath)) {
    return { valid: false, defect: 'requirements.md is missing', warnings };
  }

  const reqContent = fs.readFileSync(reqPath, 'utf8');

  // Find the block delimiters
  const beginMarker = '<!-- BEGIN REQUIREMENTS_INDEX -->';
  const endMarker   = '<!-- END REQUIREMENTS_INDEX -->';
  const beginIdx = reqContent.indexOf(beginMarker);
  const endIdx   = reqContent.indexOf(endMarker);

  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { valid: false, defect: 'requirements.md missing <!-- BEGIN REQUIREMENTS_INDEX --> / <!-- END REQUIREMENTS_INDEX --> delimiters', warnings };
  }

  const blockBody = reqContent.slice(beginIdx + beginMarker.length, endIdx);

  // Extract fenced ```json body
  const fenceStart = blockBody.indexOf('```json');
  const fenceEnd   = blockBody.lastIndexOf('```');
  if (fenceStart === -1 || fenceEnd <= fenceStart) {
    return { valid: false, defect: 'REQUIREMENTS_INDEX block has no valid ```json fence', warnings };
  }

  const jsonSrc = blockBody.slice(fenceStart + '```json'.length, fenceEnd).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonSrc);
  } catch (e) {
    return { valid: false, defect: `REQUIREMENTS_INDEX JSON is malformed: ${e.message}`, warnings };
  }

  if (!Array.isArray(parsed.requirements) || parsed.requirements.length < 1) {
    return { valid: false, defect: 'REQUIREMENTS_INDEX requirements[] is absent or empty', warnings };
  }

  // (c) implementation-spec.md must be present with IMPLEMENTATION_SPEC delimiters
  const specPath = path.join(artifactDir, 'implementation-spec.md');
  if (!fs.existsSync(specPath)) {
    return { valid: false, defect: 'implementation-spec.md is missing', warnings };
  }
  const specContent = fs.readFileSync(specPath, 'utf8');
  if (!specContent.includes('<!-- BEGIN IMPLEMENTATION_SPEC -->') ||
      !specContent.includes('<!-- END IMPLEMENTATION_SPEC -->')) {
    return { valid: false, defect: 'implementation-spec.md missing <!-- BEGIN IMPLEMENTATION_SPEC --> / <!-- END IMPLEMENTATION_SPEC --> delimiters', warnings };
  }

  // (d) screens/ must exist and contain at least one *.html file
  const screensDir = path.join(artifactDir, 'screens');
  const screenFiles = fs.existsSync(screensDir)
    ? fs.readdirSync(screensDir).filter(f => f.toLowerCase().endsWith('.html'))
    : [];
  if (screenFiles.length < 1) {
    return { valid: false, defect: 'screens/ is missing or contains no .html files', warnings };
  }

  // (e) soft drift warnings — spec <-> screens agreement, both directions (heuristic)
  const screenSet = new Set(screenFiles.map(f => f.toLowerCase()));
  const specHtmlRefs = (specContent.match(/[\w./-]+\.html/gi) || [])
    .map(s => s.split('/').pop().toLowerCase());
  for (const ref of new Set(specHtmlRefs)) {
    if (!screenSet.has(ref)) {
      warnings.push(`implementation-spec.md references "${ref}" which is not a file in screens/`);
    }
  }
  const specLower = specContent.toLowerCase();
  for (const f of screenFiles) {
    const base   = f.replace(/\.html$/i, '').toLowerCase();
    const spaced = base.replace(/[-_]+/g, ' ');
    if (!specLower.includes(base) && !specLower.includes(spaced)) {
      warnings.push(`screen "${f}" is not referenced in implementation-spec.md (possible drift between spec and screens)`);
    }
  }

  return { valid: true, defect: null, warnings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const resolvedMocksDir = resolveMocksDir();

if (listMode) {
  // Print one line per slug; exit 0 when dir absent
  if (!fs.existsSync(resolvedMocksDir)) {
    process.exit(0);
  }
  const entries = fs.readdirSync(resolvedMocksDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  for (const slug of entries) {
    console.log(slug);
  }
  process.exit(0);
}

if (validateSlug) {
  const artifactDir = path.join(resolvedMocksDir, validateSlug);

  // Exit 2 when the directory is absent (typo'd slug — hard stop for EC-2)
  if (!fs.existsSync(artifactDir)) {
    const result = { valid: false, defect: `artifact directory not found: ${artifactDir}`, warnings: [], exit_code: 2 };
    console.log(JSON.stringify(result));
    process.exit(2);
  }

  const { valid, defect, warnings } = validateArtifact(resolvedMocksDir, validateSlug);
  const result = { valid, defect: defect || null, warnings: warnings || [], path: artifactDir };
  console.log(JSON.stringify(result));
  process.exit(valid ? 0 : 1);
}
