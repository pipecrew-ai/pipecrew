#!/usr/bin/env node
/**
 * Extract a structured JSON block from inside a markdown file's
 * HTML-comment delimited section.
 *
 * Phase outputs (e.g. `outputs/phase-2-architecture.md`) wrap structured
 * data inside `<!-- BEGIN {name} -->` ... `<!-- END {name} -->` markers
 * and embed a ```json fenced code block at the top of each. This script
 * pulls that fenced block out and emits the parsed JSON to stdout — so
 * downstream phases can consume structured data without an LLM
 * re-parsing the prose.
 *
 * Usage:  node extract-block.js <file-path> <block-name>
 *   e.g.  node extract-block.js outputs/phase-2-architecture.md AFFECTED_SERVICES
 *
 * Exit codes:
 *   0 — block found, JSON parsed, output emitted to stdout
 *   1 — file not found / unreadable
 *   2 — usage error or block delimiters not found
 *   3 — no ```json fenced code block inside the named section
 *   4 — JSON parse error
 *
 * Schema documentation lives in `docs/file-formats.md`.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');

const [, , filePath, blockName] = process.argv;

if (!filePath || !blockName) {
  console.error('Usage: extract-block.js <file-path> <block-name>');
  process.exit(2);
}

let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch (e) {
  console.error(`Cannot read file: ${filePath} (${e.message})`);
  process.exit(1);
}

const beginMarker = `<!-- BEGIN ${blockName} -->`;
const endMarker = `<!-- END ${blockName} -->`;
const begin = content.indexOf(beginMarker);
const end = content.indexOf(endMarker);

if (begin === -1 || end === -1 || end < begin) {
  console.error(`Block '${blockName}' not found in ${filePath}`);
  process.exit(2);
}

const blockBody = content.slice(begin + beginMarker.length, end);

const fenceMatch = blockBody.match(/```json\s*\n([\s\S]*?)\n```/);
if (!fenceMatch) {
  console.error(`No \`\`\`json fenced code block inside '${blockName}' in ${filePath}`);
  process.exit(3);
}

let parsed;
try {
  parsed = JSON.parse(fenceMatch[1]);
} catch (e) {
  console.error(`JSON parse error in '${blockName}' (${filePath}): ${e.message}`);
  process.exit(4);
}

process.stdout.write(JSON.stringify(parsed));
