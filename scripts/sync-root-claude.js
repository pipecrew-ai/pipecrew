#!/usr/bin/env node
/**
 * sync-root-claude.js — maintains the root dispatcher CLAUDE.md at a workspace root.
 *
 * The workspace ROOT (the directory users launch `claude` from, hosting one or
 * more workspace slugs side by side) gets a CLAUDE.md that routes user asks to
 * PipeCrew skills/agents. The body is static (templates/root-CLAUDE.md.template);
 * the only dynamic content is the slug index between the pipecrew:slugs markers,
 * which this script owns. Everything outside the markers belongs to the user and
 * is never touched.
 *
 * Behavior:
 *  - no CLAUDE.md at root      → copy the template, fill the slug index
 *  - CLAUDE.md with markers    → regenerate ONLY the block between the markers
 *  - CLAUDE.md without markers → append a small managed section (user file is
 *                                preserved verbatim; only the block is added)
 *  - malformed markers (dup / unpaired / reversed) → exit 1, touch nothing
 *
 * The slug index is rebuilt from the filesystem on every run: subdirectories of
 * the root containing config.json or config.portable.json are workspaces. That
 * makes the script idempotent and self-pruning (a removed workspace dir drops
 * out on the next run). `--slug` force-includes one slug in case its config is
 * written later in the calling phase.
 *
 * Usage:  node sync-root-claude.js --root=<abs-root> [--slug=<slug>] [--dry-run]
 * Exit 0 = clean, 1 = hard-fail (nothing written), 2 = written with warnings.
 *
 * Called from /discover Phase C (Step 5) and /join Step 6. Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

const BEGIN = '<!-- pipecrew:slugs -->';
const END = '<!-- /pipecrew:slugs -->';
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'root-CLAUDE.md.template');
const SOFT_LINE_CEILING = 150; // warn only — the body outside the markers is user-owned

/** Subdirectories of root that look like onboarded workspaces. */
function discoverSlugs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name =>
      fs.existsSync(path.join(root, name, 'config.json')) ||
      fs.existsSync(path.join(root, name, 'config.portable.json')))
    .sort();
}

function slugLine(slug) {
  return `- \`${slug}\` — domain context: \`${slug}/context/platform.md\` · repo roster: \`${slug}/config.json\``;
}

function renderBlock(slugs) {
  const lines = slugs.length
    ? slugs.map(slugLine)
    : ['- (no workspaces onboarded yet — run /pipecrew:discover or /pipecrew:join)'];
  return `${BEGIN}\n${lines.join('\n')}\n${END}`;
}

function countOccurrences(haystack, needle) {
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

/** Replace the marker block in `body` with `block`. Assumes exactly one well-ordered pair. */
function spliceBlock(body, block) {
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END) + END.length;
  return body.slice(0, start) + block + body.slice(end);
}

/**
 * Ensure {root}/CLAUDE.md exists and its slug index is current.
 * Returns { action: 'created'|'updated'|'appended'|'unchanged', slugs, warnings }.
 * Throws on malformed markers or unreadable template — nothing is written then.
 */
function ensure(root, slug, opts = {}) {
  const target = path.join(root, 'CLAUDE.md');
  const slugs = new Set(discoverSlugs(root));
  if (slug) slugs.add(slug);
  const block = renderBlock([...slugs].sort());
  const warnings = [];

  let body, action;
  if (!fs.existsSync(target)) {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    if (countOccurrences(template, BEGIN) !== 1 || countOccurrences(template, END) !== 1) {
      throw new Error(`template at ${TEMPLATE_PATH} must contain exactly one ${BEGIN} … ${END} pair`);
    }
    body = spliceBlock(template, block);
    action = 'created';
  } else {
    const existing = fs.readFileSync(target, 'utf8');
    const begins = countOccurrences(existing, BEGIN);
    const ends = countOccurrences(existing, END);
    if (begins === 1 && ends === 1 && existing.indexOf(BEGIN) < existing.indexOf(END)) {
      body = spliceBlock(existing, block);
      action = body === existing ? 'unchanged' : 'updated';
    } else if (begins === 0 && ends === 0) {
      // A hand-authored root CLAUDE.md — preserve it verbatim, add only the managed section.
      body = existing.replace(/\s*$/, '\n') + [
        '',
        '## PipeCrew workspaces in this root',
        '',
        'This directory is also a PipeCrew workspace root. Prefer the `/pipecrew:*` skills for work on these workspaces — each carries its domain context at `<slug>/context/platform.md`.',
        '',
        block,
        '',
      ].join('\n');
      action = 'appended';
    } else {
      throw new Error(
        `${target} has malformed pipecrew:slugs markers (${begins} begin / ${ends} end, or reversed). ` +
        `Fix the markers by hand (exactly one ${BEGIN} … ${END} pair), then re-run.`);
    }
  }

  const lineCount = body.split(/\r?\n/).length;
  if (lineCount > SOFT_LINE_CEILING) {
    warnings.push(`size: ${lineCount} lines exceeds soft ceiling of ${SOFT_LINE_CEILING} — a fat root CLAUDE.md taxes every session launched from ${root}`);
  }

  if (!opts.dryRun && action !== 'unchanged') fs.writeFileSync(target, body);
  return { action, slugs: [...slugs].sort(), warnings };
}

// ── CLI entry ─────────────────────────────────────────────
if (require.main === module) {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  if (!args.root) {
    console.error('Usage: node sync-root-claude.js --root=<abs-root> [--slug=<slug>] [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(args.root)) {
    console.error(`root not found: ${args.root}`);
    process.exit(1);
  }

  try {
    const { action, slugs, warnings } = ensure(args.root, args.slug, { dryRun: !!args['dry-run'] });
    for (const w of warnings) console.warn(`WARN:  ${w}`);
    console.log(`${args['dry-run'] ? '[dry-run] ' : ''}${path.join(args.root, 'CLAUDE.md')}: ${action} (slugs: ${slugs.join(', ') || 'none'})`);
    process.exit(warnings.length > 0 ? 2 : 0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { ensure, discoverSlugs, renderBlock };
