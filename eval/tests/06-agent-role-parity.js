#!/usr/bin/env node
const LAYER = 1;
/**
 * Layer 1 — every agent that ships in `agents/` and every workspace-agent
 * template in `templates/agents/` resolves to a role character defined in
 * `skills/site-view/server.js` ROLE_PATTERNS.
 *
 * Why this matters: the site-view dashboard groups Agent tool calls under
 * a character ("Pip", "Archie", etc.). An agent with no matching pattern
 * renders as an unknown role — visible drift between what the plugin
 * dispatches and what the site-view shows.
 *
 * KNOWN_UNMAPPED: agents whose role assignment is a pending product
 * decision (covered in a separate change). Listed here explicitly so they
 * are documented and visible; the eval warns on them but does NOT fail.
 * A *new* unmapped agent (not in this list) fails the eval — that's how
 * the gate catches drift.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');
const TEMPLATES_AGENTS_DIR = path.join(PLUGIN_ROOT, 'templates', 'agents');
const SERVER_JS = path.join(PLUGIN_ROOT, 'skills', 'site-view', 'server.js');

// Agents with no current role mapping. Each entry should be either fixed
// (by adding it to ROLE_PATTERNS in server.js) or formally accepted as
// "always unknown" with a rationale. Remove from this list when fixed.
const KNOWN_UNMAPPED = new Set([
  'architecture-mapper',  // code-scan mapping agent; conceptually archie-family but not yet assigned
  'repo-discoverer',      // per-repo Sonnet scout used in /discover Phase B2.0; not yet assigned
  'troubleshooter',       // workspace-template agent; site-view rendering for it is pending product decision
]);

// Templates whose runtime name depends on workspace slug + stack key,
// not the template filename — too generic for static resolution.
const SKIP_TEMPLATES = new Set([
  'generic-implementer',  // produces e.g. {slug}-{stack}-implementer at /discover time
]);

let passed = 0, failed = 0, warnings = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function warn(msg) { console.error(`  warn ${msg}`); warnings++; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// --- Parse ROLE_PATTERNS out of server.js ---
const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');
const blockMatch = serverSrc.match(/const ROLE_PATTERNS\s*=\s*\[([\s\S]*?)\];/);
assert(blockMatch, 'ROLE_PATTERNS block not found in server.js');

// Extract every patterns: [ ... ] array inside the block.
const allPatterns = [];
const patternRe = /patterns:\s*\[([^\]]*)\]/g;
let m;
while ((m = patternRe.exec(blockMatch[1])) !== null) {
  const items = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  allPatterns.push(...items);
}

const patternSet = new Set(allPatterns);

// Replicate server.js agentToRole resolution. server.js matches:
//   - exact name
//   - endsWith('-' + pattern)  — for `dal-product-owner` style
//   - endsWith(':' + pattern)  — for `pipecrew:spring-boot-implementer` style
// For the static eval, the agent's base name IS its filename (no slug prefix
// at rest), so an exact-match-or-substring check is enough.
function hasRole(agentName) {
  if (patternSet.has(agentName)) return true;
  for (const p of patternSet) {
    if (agentName.endsWith('-' + p)) return true;
  }
  return false;
}

// --- Catalog canonical agents ---
const canonicalAgents = fs.existsSync(AGENTS_DIR)
  ? fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
  : [];

// --- Catalog template agents ---
const templateAgents = fs.existsSync(TEMPLATES_AGENTS_DIR)
  ? fs.readdirSync(TEMPLATES_AGENTS_DIR)
      .filter(f => f.endsWith('.md.template'))
      .map(f => f.replace(/\.md\.template$/, ''))
      .filter(name => !SKIP_TEMPLATES.has(name))
  : [];

test('ROLE_PATTERNS block parsed and non-empty', () => {
  assert(patternSet.size > 0, `expected to parse at least one pattern, got ${patternSet.size}`);
});

test('found canonical agents and template agents (sanity)', () => {
  assert(canonicalAgents.length > 0, 'no .md files in agents/');
  assert(templateAgents.length > 0, 'no .md.template files in templates/agents/');
});

const unmappedNew = [];
const unmappedKnown = [];

for (const name of [...canonicalAgents, ...templateAgents]) {
  if (hasRole(name)) continue;
  if (KNOWN_UNMAPPED.has(name)) unmappedKnown.push(name);
  else unmappedNew.push(name);
}

for (const name of unmappedKnown) {
  warn(`'${name}' has no ROLE_PATTERNS entry (known — listed in KNOWN_UNMAPPED)`);
}

test(`no NEW unmapped agents (KNOWN_UNMAPPED has ${KNOWN_UNMAPPED.size} entries)`, () => {
  if (unmappedNew.length > 0) {
    throw new Error(`agent(s) without ROLE_PATTERNS coverage: ${unmappedNew.join(', ')}\n       Either add a pattern in skills/site-view/server.js or add the name to KNOWN_UNMAPPED in this file with a rationale.`);
  }
});

// --- Reverse: warn about KNOWN_UNMAPPED entries that no longer match a real agent ---
// (someone deleted an agent but forgot to remove it from the allowlist)
const allAgentNames = new Set([...canonicalAgents, ...templateAgents]);
const staleKnownUnmapped = [...KNOWN_UNMAPPED].filter(n => !allAgentNames.has(n));
for (const name of staleKnownUnmapped) {
  warn(`KNOWN_UNMAPPED has '${name}' but no agent or template by that name exists — remove from the list`);
}

console.log(`\n${passed} passed, ${failed} failed, ${warnings} warning(s)`);
process.exit(failed === 0 ? 0 : 1);
