#!/usr/bin/env node
/**
 * verify-sa-output.js — deterministic gate for the solution-architect's
 * /discover Phase B2 output: the platform.md "Architecture Diagram" pointer
 * stub plus the two extracted Mermaid diagram files.
 *
 * Replaces the old "run a lightweight syntax check (or defer to the site-view
 * render error)" hand-step with a real, repeatable check — the same
 * deterministic-gate pattern used by validate-config / validate-observability /
 * validate-repo-profile. Read-only: it inspects already-written files, never
 * writes or extracts.
 *
 * Usage:
 *   node verify-sa-output.js <context-dir>
 *     <context-dir> = {workspace_root}/{slug}/context   (holds platform.md + diagrams/)
 *
 * Exit codes: 0 clean · 1 hard-fail · 2 warnings only.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

// Mermaid diagram headers we accept as the first meaningful line of a .mmd file.
const MERMAID_HEADERS = [
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap',
  'timeline', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic',
];

const DIAGRAMS = ['architecture-overview.mmd', 'architecture.mmd'];

function firstMeaningfulLine(body) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue; // mermaid comment
    return line;
  }
  return '';
}

function verify(contextDir) {
  const errors = [];
  const warnings = [];

  // --- the two .mmd files ------------------------------------------------
  for (const name of DIAGRAMS) {
    const p = path.join(contextDir, 'diagrams', name);
    let body;
    try { body = fs.readFileSync(p, 'utf8'); }
    catch { errors.push(`missing diagram: diagrams/${name} (architect output not extracted, or extraction wrote it elsewhere)`); continue; }

    if (body.trim() === '') { errors.push(`empty diagram: diagrams/${name}`); continue; }

    // A leftover markdown code fence means the ```mermaid wrapper was not
    // stripped during extraction — the file won't render.
    if (/^\s*```/m.test(body)) {
      errors.push(`diagrams/${name} still contains a markdown code fence (\`\`\`) — strip the \`\`\`mermaid wrapper (e.g. extract-block.js --unfence)`);
    }

    const head = firstMeaningfulLine(body);
    const ok = MERMAID_HEADERS.some(h => head === h || head.startsWith(h + ' ') || head.startsWith(h + '\t') || head.startsWith(h + 'TB') || head.startsWith(h + 'LR') || head.startsWith(h + 'TD') || head.startsWith(h + 'RL') || head.startsWith(h + 'BT'));
    if (!ok && !/^\s*```/m.test(body)) {
      errors.push(`diagrams/${name}: first line "${head.slice(0, 40)}" is not a recognized Mermaid diagram header (${MERMAID_HEADERS.slice(0, 4).join('/')}/…)`);
    }

    // Footgun: a period inside a dotted-edge label is swallowed by the parser.
    if (/-\.[^.\n]*\.[^.\n]*\.->/.test(body)) {
      warnings.push(`diagrams/${name}: a dotted-edge label appears to contain a period (\`-.X.Y.->\`) — Mermaid drops it; rephrase the label without the dot`);
    }
  }

  // --- platform.md pointer stub -----------------------------------------
  const platformPath = path.join(contextDir, 'platform.md');
  let platform;
  try { platform = fs.readFileSync(platformPath, 'utf8'); }
  catch { errors.push('missing platform.md in the context dir'); return { errors, warnings }; }

  // Inline mermaid must NOT live in platform.md — it points at the .mmd files.
  if (/```mermaid/.test(platform)) {
    errors.push('platform.md contains an inline ```mermaid block — the architecture diagrams must be pointer links to diagrams/*.mmd, not embedded source');
  }
  // Both pointer links must be present.
  for (const name of DIAGRAMS) {
    if (!platform.includes(`diagrams/${name}`)) {
      errors.push(`platform.md does not reference diagrams/${name} — the "## Architecture Diagram" pointer stub is incomplete`);
    }
  }

  return { errors, warnings };
}

// ── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const contextDir = process.argv[2];
  if (!contextDir) {
    console.error('Usage: node verify-sa-output.js <context-dir>  (the {workspace_root}/{slug}/context dir)');
    process.exit(1);
  }
  const { errors, warnings } = verify(contextDir);
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
  console.log(`Clean: SA output under ${contextDir}`);
  process.exit(0);
}

module.exports = { verify };
