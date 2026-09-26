#!/usr/bin/env node
/**
 * sync-root-claude.js — maintains the PipeCrew routing CLAUDE.md at the parent
 * directory(ies) of a workspace's repos.
 *
 * Claude Code loads CLAUDE.md by walking UP from the directory a session is
 * launched in — and sessions run inside repos, not at the workspace dir. So the
 * routing guide ("the PipeCrew toolbox exists; route user asks to these skills
 * and agents") is anchored at each distinct repo parent from config.repos, the
 * same placement rule setup-workspace-permissions.js uses for settings files.
 * Usually all repos share one parent → exactly one file.
 *
 * The file body is static (templates/root-CLAUDE.md.template) and slug-agnostic.
 * The only dynamic content is the per-workspace block between the
 * pipecrew:workspaces container markers — one block per workspace whose repos
 * live under that parent, keyed by slug, carrying that workspace's absolute
 * context paths and concrete agent names. Everything outside the container
 * belongs to the user and is never touched. Absolute paths are fine here: the
 * file is machine-local at a non-repo directory and is never committed.
 *
 * Behavior per target parent:
 *  - no CLAUDE.md                 → copy the template, insert this workspace's block
 *  - CLAUDE.md with container     → upsert this workspace's block; prune blocks
 *                                   whose workspace dir no longer exists
 *  - CLAUDE.md without container  → append a small managed section (the user's
 *                                   file is preserved verbatim)
 *  - malformed container markers  → exit 1, touch nothing
 *
 * A parent that sits INSIDE a git repo (monorepo layout: config "repos" are
 * subdirectories of one checkout) is hoisted to just above that repo's top
 * level, so the routing file never lands in a committed repo CLAUDE.md.
 * Skipped (with a warning): parents that are a filesystem root, the user's home
 * directory itself, or inside ~/.claude (plugin checkouts are not routing turf).
 *
 * Usage:  node sync-root-claude.js --config=<abs-path-to-config.json> [--dry-run]
 *         node sync-root-claude.js --user [--dry-run]
 * Exit 0 = clean, 1 = hard-fail, 2 = completed with warnings.
 *
 * --user mode (OPT-IN — only run after the user explicitly consented, it edits
 * their personal file): maintains a small machine-level breadcrumb between
 * pipecrew:machine markers in ~/.claude/CLAUDE.md, which loads into EVERY
 * session on the machine. Content is deliberately tiny — "PipeCrew runs here,
 * these workspaces are registered (from workspace-registry.js, both roots),
 * prefer /pipecrew:* skills" — never the routing tables; those stay in the
 * repos-parent files. Same marker discipline: user content is never touched.
 *
 * Called from /discover Phase C (Step 5) and /join Step 6. Zero dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTAINER_BEGIN = '<!-- pipecrew:workspaces -->';
const CONTAINER_END = '<!-- /pipecrew:workspaces -->';
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'root-CLAUDE.md.template');
const SOFT_LINE_CEILING = 150; // warn only — content outside the container is user-owned

const fwd = (p) => p.replace(/\\/g, '/');

function blockBegin(slug, dir) { return `<!-- pipecrew:workspace ${slug} dir="${fwd(dir)}" -->`; }
function blockEnd(slug) { return `<!-- /pipecrew:workspace ${slug} -->`; }

/** Render one workspace's block: absolute pointers + concrete agent names. */
function renderBlock(slug, workspaceDir) {
  const d = fwd(workspaceDir);
  return [
    blockBegin(slug, d),
    `### ${slug}`,
    `- Domain context: \`${d}/context/platform.md\` · repo roster: \`${d}/config.json\``,
    `- Workspace agents: \`${slug}-product-owner\` · \`${slug}-assessor\` · \`${slug}-troubleshooter\``,
    `- Runs: \`${d}/runs/\` · institutional memory: \`${d}/history/\``,
    blockEnd(slug),
  ].join('\n');
}

/** Parse existing blocks inside a container body → [{slug, dir, raw}]. Throws on unbalanced markers. */
function parseBlocks(containerBody) {
  const beginRe = /<!-- pipecrew:workspace (\S+) dir="([^"]+)" -->/g;
  const blocks = [];
  let m;
  while ((m = beginRe.exec(containerBody)) !== null) {
    const [, slug, dir] = m;
    const end = containerBody.indexOf(blockEnd(slug), m.index);
    if (end === -1) throw new Error(`workspace block "${slug}" has no end marker`);
    blocks.push({ slug, dir, raw: containerBody.slice(m.index, end + blockEnd(slug).length) });
  }
  return blocks;
}

function workspaceAlive(dir) {
  return fs.existsSync(path.join(dir, 'config.json')) ||
         fs.existsSync(path.join(dir, 'config.portable.json'));
}

/** Rebuild the full container: upsert this workspace, keep other live ones, prune dead ones, sort. */
function renderContainer(existingBlocks, slug, workspaceDir) {
  const kept = existingBlocks.filter(b => b.slug !== slug && workspaceAlive(b.dir));
  const all = [...kept, { slug, dir: fwd(workspaceDir), raw: renderBlock(slug, workspaceDir) }]
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return `${CONTAINER_BEGIN}\n${all.map(b => b.raw).join('\n')}\n${CONTAINER_END}`;
}

function countOccurrences(haystack, needle) {
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

/** Replace the container (markers included) in `body` with `container`. */
function spliceContainer(body, container) {
  const start = body.indexOf(CONTAINER_BEGIN);
  const end = body.indexOf(CONTAINER_END) + CONTAINER_END.length;
  return body.slice(0, start) + container + body.slice(end);
}

/**
 * Ensure {parentDir}/CLAUDE.md exists and this workspace's block is current.
 * Returns { action: 'created'|'updated'|'appended'|'unchanged', warnings }.
 * Throws on malformed markers or unreadable template — nothing is written then.
 */
function ensure(parentDir, slug, workspaceDir, opts = {}) {
  const target = path.join(parentDir, 'CLAUDE.md');
  const warnings = [];

  let body, action;
  if (!fs.existsSync(target)) {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    if (countOccurrences(template, CONTAINER_BEGIN) !== 1 || countOccurrences(template, CONTAINER_END) !== 1) {
      throw new Error(`template at ${TEMPLATE_PATH} must contain exactly one ${CONTAINER_BEGIN} … ${CONTAINER_END} pair`);
    }
    body = spliceContainer(template, renderContainer([], slug, workspaceDir));
    action = 'created';
  } else {
    const existing = fs.readFileSync(target, 'utf8');
    const begins = countOccurrences(existing, CONTAINER_BEGIN);
    const ends = countOccurrences(existing, CONTAINER_END);
    if (begins === 1 && ends === 1 && existing.indexOf(CONTAINER_BEGIN) < existing.indexOf(CONTAINER_END)) {
      const start = existing.indexOf(CONTAINER_BEGIN) + CONTAINER_BEGIN.length;
      const end = existing.indexOf(CONTAINER_END);
      const blocks = parseBlocks(existing.slice(start, end));
      body = spliceContainer(existing, renderContainer(blocks, slug, workspaceDir));
      action = body === existing ? 'unchanged' : 'updated';
    } else if (begins === 0 && ends === 0) {
      // A hand-authored CLAUDE.md — preserve it verbatim, add only the managed section.
      body = existing.replace(/\s*$/, '\n') + [
        '',
        '## PipeCrew workspaces served from this directory',
        '',
        'Repos under this directory belong to the PipeCrew workspace(s) below. Prefer the `/pipecrew:*` skills for work on them — each workspace carries its domain context at the `context/platform.md` path listed here.',
        '',
        renderContainer([], slug, workspaceDir),
        '',
      ].join('\n');
      action = 'appended';
    } else {
      throw new Error(
        `${target} has malformed pipecrew:workspaces markers (${begins} begin / ${ends} end, or reversed). ` +
        `Fix the markers by hand (exactly one ${CONTAINER_BEGIN} … ${CONTAINER_END} pair), then re-run.`);
    }
  }

  const lineCount = body.split(/\r?\n/).length;
  if (lineCount > SOFT_LINE_CEILING) {
    warnings.push(`size: ${target} is ${lineCount} lines, above the soft ceiling of ${SOFT_LINE_CEILING} — a fat CLAUDE.md taxes every session launched under ${parentDir}`);
  }

  if (!opts.dryRun && action !== 'unchanged') fs.writeFileSync(target, body);
  return { action, warnings };
}

// ── user-level breadcrumb (--user mode) ───────────────────
const MACHINE_BEGIN = '<!-- pipecrew:machine -->';
const MACHINE_END = '<!-- /pipecrew:machine -->';

/** Render the machine-level breadcrumb block from registry entries [{slug, path}]. */
function renderMachineBlock(workspaces) {
  const alive = workspaces.filter(w => w && w.slug && w.path && workspaceAlive(w.path))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const lines = alive.length
    ? alive.map(w => `- \`${w.slug}\` — domain context: \`${fwd(w.path)}/context/platform.md\``)
    : ['- (none registered yet — run /pipecrew:discover or /pipecrew:join)'];
  return [
    MACHINE_BEGIN,
    'This machine runs PipeCrew (a Claude Code plugin for multi-repo feature delivery). Registered workspaces:',
    ...lines,
    'For work touching these workspaces\' repos or domains, prefer the `/pipecrew:*` skills; the full routing guide lives in the CLAUDE.md at each workspace\'s repos parent.',
    MACHINE_END,
  ].join('\n');
}

/**
 * Ensure the user-level CLAUDE.md carries a current machine breadcrumb.
 * Same contract as ensure(): only the marker block is owned; user content is
 * preserved verbatim; malformed markers throw without writing.
 */
function ensureUserBreadcrumb(claudeMdPath, workspaces, opts = {}) {
  const block = renderMachineBlock(workspaces);
  const warnings = [];

  let body, action;
  if (!fs.existsSync(claudeMdPath)) {
    body = `${block}\n`;
    action = 'created';
  } else {
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    const begins = countOccurrences(existing, MACHINE_BEGIN);
    const ends = countOccurrences(existing, MACHINE_END);
    if (begins === 1 && ends === 1 && existing.indexOf(MACHINE_BEGIN) < existing.indexOf(MACHINE_END)) {
      const start = existing.indexOf(MACHINE_BEGIN);
      const end = existing.indexOf(MACHINE_END) + MACHINE_END.length;
      body = existing.slice(0, start) + block + existing.slice(end);
      action = body === existing ? 'unchanged' : 'updated';
    } else if (begins === 0 && ends === 0) {
      body = existing.replace(/\s*$/, '\n') + `\n${block}\n`;
      action = 'appended';
    } else {
      throw new Error(
        `${claudeMdPath} has malformed pipecrew:machine markers (${begins} begin / ${ends} end, or reversed). ` +
        `Fix the markers by hand (exactly one ${MACHINE_BEGIN} … ${MACHINE_END} pair), then re-run.`);
    }
  }

  if (!opts.dryRun && action !== 'unchanged') fs.writeFileSync(claudeMdPath, body);
  return { action, warnings };
}

/** Nearest ancestor of dir (inclusive) containing .git (dir or file — worktrees), or null. */
function gitTopLevel(dir) {
  let cur = dir;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * Distinct repo parents from a parsed config, split into targets, skipped
 * [{dir, reason}], and hoisted [{from, to}]. A parent that sits INSIDE a git
 * repo (monorepo: config "repos" are subdirectories of one checkout) is hoisted
 * to just above that repo's top level — still an ancestor of every session, but
 * the file stays machine-local instead of landing in a committed repo CLAUDE.md.
 */
function resolveTargets(config) {
  const parents = new Set();
  for (const [, spec] of Object.entries(config.repos || {})) {
    if (spec && spec.path) parents.add(fwd(path.dirname(path.resolve(spec.path))));
  }
  const home = fwd(os.homedir());
  const claudeDir = `${home}/.claude`;
  const targets = new Set(), skipped = [], hoisted = [];
  for (const original of [...parents].sort()) {
    let p = original, top, atRoot = false;
    while ((top = gitTopLevel(p)) !== null) {
      const up = fwd(path.dirname(top));
      if (up === fwd(top)) { atRoot = true; break; } // repo at a filesystem root
      p = up;
    }
    if (p !== original) hoisted.push({ from: original, to: p });
    if (atRoot || fwd(path.dirname(p)) === p) skipped.push({ dir: p, reason: 'filesystem root' });
    else if (p === home) skipped.push({ dir: p, reason: 'home directory' });
    else if (p === claudeDir || p.startsWith(`${claudeDir}/`)) skipped.push({ dir: p, reason: 'inside ~/.claude (plugin/tool checkout, not routing turf)' });
    else targets.add(p);
  }
  return { targets: [...targets].sort(), skipped, hoisted };
}

// ── CLI entry ─────────────────────────────────────────────
if (require.main === module) {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  if (!args.config && !args.user) {
    console.error('Usage: node sync-root-claude.js --config=<abs-path-to-config.json> [--dry-run]');
    console.error('       node sync-root-claude.js --user [--dry-run]   (opt-in: edits ~/.claude/CLAUDE.md)');
    process.exit(1);
  }

  if (args.user) {
    const target = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    let workspaces;
    try {
      workspaces = require('./workspace-registry').load().cfg.workspaces || [];
    } catch (e) {
      console.error(`failed to read the workspace registry: ${e.message}`);
      process.exit(1);
    }
    try {
      const { action } = ensureUserBreadcrumb(target, workspaces, { dryRun: !!args['dry-run'] });
      console.log(`${args['dry-run'] ? '[dry-run] ' : ''}${target}: ${action} (${workspaces.length} registered workspace(s))`);
      process.exit(0);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    }
  }

  let config;
  try {
    // Strip a UTF-8 BOM — Windows editors add one and JSON.parse rejects it.
    config = JSON.parse(fs.readFileSync(args.config, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.error(`failed to read config ${args.config}: ${e.message}`);
    process.exit(1);
  }
  const slug = config.workspace && config.workspace.slug;
  if (!slug) {
    console.error(`config ${args.config} has no workspace.slug`);
    process.exit(1);
  }
  const workspaceDir = path.dirname(path.resolve(args.config));

  const { targets, skipped, hoisted } = resolveTargets(config);
  let warned = skipped.length > 0;
  for (const h of hoisted) console.log(`note: ${h.from} is inside a git repo — placing the routing CLAUDE.md above it at ${h.to}`);
  for (const s of skipped) console.warn(`WARN:  skipping ${s.dir} — ${s.reason}`);
  if (targets.length === 0) {
    console.error('no eligible repo parent directories resolved from config — nothing to write.');
    process.exit(1);
  }

  let failed = false;
  for (const parent of targets) {
    try {
      const { action, warnings } = ensure(parent, slug, workspaceDir, { dryRun: !!args['dry-run'] });
      for (const w of warnings) console.warn(`WARN:  ${w}`);
      if (warnings.length > 0) warned = true;
      console.log(`${args['dry-run'] ? '[dry-run] ' : ''}${path.join(parent, 'CLAUDE.md')}: ${action} (workspace: ${slug})`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : warned ? 2 : 0);
}

module.exports = { ensure, resolveTargets, renderBlock, renderContainer, parseBlocks, ensureUserBreadcrumb, renderMachineBlock };
