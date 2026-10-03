#!/usr/bin/env node
/**
 * sync-root-claude.js — maintains the PipeCrew routing context file at the
 * parent directory(ies) of a workspace's repos.
 *
 * Agent harnesses load context files by walking UP from the directory a
 * session is launched in — and sessions run inside repos, not at the workspace
 * dir. So the routing guide ("the PipeCrew toolbox exists; route user asks to
 * these skills and agents") is anchored at each distinct repo parent from
 * config.repos, the same placement rule setup-workspace-permissions.js uses.
 * Usually all repos share one parent → exactly one file.
 *
 * Context-file convention (same as per-repo docs since v1.13.0): content lives
 * in AGENTS.md (the tool-agnostic standard read natively by Cursor, Codex, and
 * 30+ agents); a one-line CLAUDE.md shim (`@AGENTS.md`) beside it imports it
 * into Claude Code. Both are written on every harness. A pre-parity CLAUDE.md
 * that is fully plugin-owned (carries the pipecrew:root-dispatcher sentinel)
 * is migrated lazily: content moves to AGENTS.md, CLAUDE.md becomes the shim.
 * A hand-authored CLAUDE.md that carries our managed container (pre-parity
 * append mode) is maintained in place — never force-migrate a user's file.
 *
 * The file body is static (templates/root-AGENTS.md.template) and
 * slug-agnostic. The only dynamic content is the per-workspace block between
 * the pipecrew:workspaces container markers — one block per workspace whose
 * repos live under that parent, keyed by slug, carrying that workspace's
 * absolute context paths and concrete agent names. Everything outside the
 * container belongs to the user and is never touched. Absolute paths are fine
 * here: the file is machine-local at a non-repo directory, never committed.
 *
 * Behavior per target parent:
 *  - nothing there                → AGENTS.md from template + CLAUDE.md shim
 *  - AGENTS.md with container     → upsert this workspace's block; prune blocks
 *                                   whose workspace dir no longer exists
 *  - AGENTS.md without container  → append a small managed section
 *  - plugin-owned CLAUDE.md       → migrate: content → AGENTS.md, CLAUDE.md → shim
 *  - hand-authored CLAUDE.md with our container → legacy: maintain in place
 *  - hand-authored CLAUDE.md, no container → AGENTS.md created; a one-line
 *                                   `@AGENTS.md` import is appended to CLAUDE.md
 *  - malformed container markers  → exit 1, touch nothing
 *
 * A parent that sits INSIDE a git repo (monorepo layout: config "repos" are
 * subdirectories of one checkout) is hoisted to just above that repo's top
 * level, so the routing file never lands in a committed repo context file.
 * Skipped (with a warning): parents that are a filesystem root, the user's home
 * directory itself, or inside ~/.claude (plugin checkouts are not routing turf).
 *
 * Usage:  node sync-root-claude.js --config=<abs-path-to-config.json> [--dry-run]
 *         node sync-root-claude.js --config=<abs-path-to-config.json> --remove [--dry-run]
 *         node sync-root-claude.js --user [--dry-run]
 * Exit 0 = clean, 1 = hard-fail, 2 = completed with warnings.
 *
 * Opt-out: `config.workspace.root_context: false` disables generation for that
 * workspace — the CLI exits 0 with a note and writes nothing (persisted in
 * config.json, so /discover re-runs, /join, and refreshes all honor it).
 * --remove uninstalls this workspace's footprint at each target parent: its
 * block is dropped from the container; a plugin-owned file whose container is
 * then empty is deleted (plus the shim, if it is exactly the one-liner); a
 * hand-authored file keeps everything else and just loses the block. --remove
 * works even when root_context is false — that's how you clean up after
 * disabling.
 *
 * --user mode (OPT-IN — only run after the user explicitly consented, it edits
 * their personal file): maintains a small machine-level breadcrumb between
 * pipecrew:machine markers in ~/.claude/CLAUDE.md, which loads into EVERY
 * Claude Code session on the machine. Content is deliberately tiny — "PipeCrew
 * runs here, these workspaces are registered (from workspace-registry.js, both
 * roots), prefer /pipecrew:* skills" — never the routing tables; those stay in
 * the repos-parent files. Same marker discipline: user content is never touched.
 *
 * Called from /discover Phase C (Step 5) and /join Step 6. Zero dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTAINER_BEGIN = '<!-- pipecrew:workspaces -->';
const CONTAINER_END = '<!-- /pipecrew:workspaces -->';
const DISPATCHER_SENTINEL = 'pipecrew:root-dispatcher';
// Canonical context filename + shim — single source of truth is workspace-root.js
// (same values on every harness: AGENTS.md carries content, CLAUDE.md imports it).
const { CONTEXT_FILENAME, CONTEXT_SHIM } = require('./workspace-root');
const SHIM_LINE = `@${CONTEXT_FILENAME}`;
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'root-AGENTS.md.template');
const SOFT_LINE_CEILING = 150; // warn only — content outside the markers is user-owned

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

/** Render a container from a final block list (no upsert). Empty → placeholder line. */
function renderContainerBare(blocks) {
  const sorted = [...blocks].sort((a, b) => a.slug.localeCompare(b.slug));
  const inner = sorted.length
    ? sorted.map(b => b.raw).join('\n')
    : '- (no workspaces served from this directory — run /pipecrew:discover or /pipecrew:join)';
  return `${CONTAINER_BEGIN}\n${inner}\n${CONTAINER_END}`;
}

/** Rebuild the full container: upsert this workspace, keep other live ones, prune dead ones, sort. */
function renderContainer(existingBlocks, slug, workspaceDir) {
  const kept = existingBlocks.filter(b => b.slug !== slug && workspaceAlive(b.dir));
  return renderContainerBare([...kept, { slug, dir: fwd(workspaceDir), raw: renderBlock(slug, workspaceDir) }]);
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

/** The appended managed section for a hand-authored file (no template body). */
function appendedSection(container) {
  return [
    '',
    '## PipeCrew workspaces served from this directory',
    '',
    'Repos under this directory belong to the PipeCrew workspace(s) below. Prefer the `/pipecrew:*` skills for work on them — each workspace carries its domain context at the `context/platform.md` path listed here.',
    '',
    container,
    '',
  ].join('\n');
}

/**
 * Container state of a file body: 'ok' (exactly one well-ordered pair),
 * 'none', or throws on malformed markers.
 */
function containerState(body, filePath) {
  const begins = countOccurrences(body, CONTAINER_BEGIN);
  const ends = countOccurrences(body, CONTAINER_END);
  if (begins === 1 && ends === 1 && body.indexOf(CONTAINER_BEGIN) < body.indexOf(CONTAINER_END)) return 'ok';
  if (begins === 0 && ends === 0) return 'none';
  throw new Error(
    `${filePath} has malformed pipecrew:workspaces markers (${begins} begin / ${ends} end, or reversed). ` +
    `Fix the markers by hand (exactly one ${CONTAINER_BEGIN} … ${CONTAINER_END} pair), then re-run.`);
}

function blocksOf(body) {
  const start = body.indexOf(CONTAINER_BEGIN) + CONTAINER_BEGIN.length;
  const end = body.indexOf(CONTAINER_END);
  return parseBlocks(body.slice(start, end));
}

/**
 * Compute the new body for a routing file (filePath may not exist).
 * `seedBlocks` are carried over from a migrating legacy file (deduped by slug;
 * blocks already in the target win). Returns { action, body }.
 */
function upsertRoutingBody(filePath, seedBlocks, slug, workspaceDir) {
  if (!fs.existsSync(filePath)) {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    if (countOccurrences(template, CONTAINER_BEGIN) !== 1 || countOccurrences(template, CONTAINER_END) !== 1) {
      throw new Error(`template at ${TEMPLATE_PATH} must contain exactly one ${CONTAINER_BEGIN} … ${CONTAINER_END} pair`);
    }
    return { action: 'created', body: spliceContainer(template, renderContainer(seedBlocks, slug, workspaceDir)) };
  }
  const existing = fs.readFileSync(filePath, 'utf8');
  if (containerState(existing, filePath) === 'ok') {
    const own = blocksOf(existing);
    const ownSlugs = new Set(own.map(b => b.slug));
    const merged = [...own, ...seedBlocks.filter(b => !ownSlugs.has(b.slug))];
    const body = spliceContainer(existing, renderContainer(merged, slug, workspaceDir));
    return { action: body === existing ? 'unchanged' : 'updated', body };
  }
  // Hand-authored file — preserve verbatim, add only the managed section.
  const body = existing.replace(/\s*$/, '\n') + appendedSection(renderContainer(seedBlocks, slug, workspaceDir));
  return { action: 'appended', body };
}

/**
 * Ensure the routing context at parentDir is current: AGENTS.md carries the
 * content, CLAUDE.md is the one-line import shim, legacy files migrate lazily.
 * Returns { action, target, migrated, legacy, warnings }.
 * Throws on malformed markers or unreadable template — nothing is written then.
 */
function ensure(parentDir, slug, workspaceDir, opts = {}) {
  const agentsPath = path.join(parentDir, CONTEXT_FILENAME);
  const shimPath = path.join(parentDir, CONTEXT_SHIM);
  const warnings = [];

  // Inspect a pre-existing CLAUDE.md for migration / legacy handling.
  let migrateLegacy = false, legacyInPlace = false, seedBlocks = [];
  if (fs.existsSync(shimPath)) {
    const claude = fs.readFileSync(shimPath, 'utf8');
    if (containerState(claude, shimPath) === 'ok') {
      if (claude.includes(DISPATCHER_SENTINEL)) {
        migrateLegacy = true;               // fully plugin-owned pre-parity file
        seedBlocks = blocksOf(claude);
      } else if (!fs.existsSync(agentsPath)) {
        legacyInPlace = true;               // user's own file carrying our container
      } else {
        warnings.push(`${shimPath} still carries a pipecrew:workspaces container alongside ${CONTEXT_FILENAME} — consider removing the stale section by hand`);
      }
    }
  }

  // Legacy mode: a hand-authored CLAUDE.md with our container and no AGENTS.md —
  // never force-migrate a user's file; keep maintaining the block where it is.
  if (legacyInPlace) {
    const { action, body } = upsertRoutingBody(shimPath, [], slug, workspaceDir);
    sizeWarn(body, shimPath, parentDir, warnings);
    if (!opts.dryRun && action !== 'unchanged') fs.writeFileSync(shimPath, body);
    return { action, target: shimPath, migrated: false, legacy: true, warnings };
  }

  // Canonical path: maintain AGENTS.md (seeded with any migrating blocks).
  const { action, body } = upsertRoutingBody(agentsPath, seedBlocks, slug, workspaceDir);
  sizeWarn(body, agentsPath, parentDir, warnings);
  if (!opts.dryRun && action !== 'unchanged') fs.writeFileSync(agentsPath, body);

  // Shim handling.
  if (!opts.dryRun) {
    if (migrateLegacy) {
      fs.writeFileSync(shimPath, `${SHIM_LINE}\n`);                 // content moved — shim replaces it
    } else if (!fs.existsSync(shimPath)) {
      fs.writeFileSync(shimPath, `${SHIM_LINE}\n`);
    } else {
      const claude = fs.readFileSync(shimPath, 'utf8');
      if (!claude.split(/\r?\n/).some(l => l.trim() === SHIM_LINE)) {
        // Hand-authored CLAUDE.md without the import — append the one-liner so
        // Claude Code loads AGENTS.md too. Smallest possible touch.
        fs.writeFileSync(shimPath, claude.replace(/\s*$/, '\n') + `\n${SHIM_LINE}\n`);
      }
    }
  }

  return { action, target: agentsPath, migrated: migrateLegacy, legacy: false, warnings };
}

/**
 * Remove this workspace's footprint at parentDir (the inverse of ensure()).
 * Drops the slug's block from whichever file carries the container (AGENTS.md,
 * or a legacy CLAUDE.md). A plugin-owned file whose container is then empty is
 * deleted outright — plus the shim when it is exactly the one-liner. A
 * hand-authored file keeps all other content and just loses the block.
 * Returns { action: 'removed'|'updated'|'absent', target, warnings }.
 */
function remove(parentDir, slug, opts = {}) {
  const agentsPath = path.join(parentDir, CONTEXT_FILENAME);
  const shimPath = path.join(parentDir, CONTEXT_SHIM);
  const warnings = [];

  // Find the file that carries the container: canonical AGENTS.md, else legacy CLAUDE.md.
  const carrier = [agentsPath, shimPath].find(p =>
    fs.existsSync(p) && containerState(fs.readFileSync(p, 'utf8'), p) === 'ok');
  if (!carrier) return { action: 'absent', target: agentsPath, warnings };

  const body = fs.readFileSync(carrier, 'utf8');
  const remaining = blocksOf(body).filter(b => b.slug !== slug);

  if (remaining.length === 0 && body.includes(DISPATCHER_SENTINEL)) {
    // Fully plugin-owned and now empty — delete the file, and the shim if it's ours.
    if (!opts.dryRun) {
      fs.unlinkSync(carrier);
      if (carrier !== shimPath && fs.existsSync(shimPath)) {
        if (fs.readFileSync(shimPath, 'utf8').trim() === SHIM_LINE) fs.unlinkSync(shimPath);
        else warnings.push(`${shimPath} has content beyond the ${SHIM_LINE} import — left in place; remove the import line by hand if unwanted`);
      }
    }
    return { action: 'removed', target: carrier, warnings };
  }

  const next = spliceContainer(body, renderContainerBare(remaining));
  if (!opts.dryRun && next !== body) fs.writeFileSync(carrier, next);
  if (remaining.length === 0) {
    warnings.push(`${carrier} is hand-authored — only the ${slug} block was removed; delete the PipeCrew section by hand if unwanted`);
  }
  return { action: next === body ? 'absent' : 'updated', target: carrier, warnings };
}

function sizeWarn(body, filePath, parentDir, warnings) {
  const lineCount = body.split(/\r?\n/).length;
  if (lineCount > SOFT_LINE_CEILING) {
    warnings.push(`size: ${filePath} is ${lineCount} lines, above the soft ceiling of ${SOFT_LINE_CEILING} — a fat context file taxes every session launched under ${parentDir}`);
  }
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
    'For work touching these workspaces\' repos or domains, prefer the `/pipecrew:*` skills; the full routing guide lives in the AGENTS.md at each workspace\'s repos parent.',
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
 * the file stays machine-local instead of landing in a committed repo context file.
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

  // Opt-out: persisted per-workspace in config.json. --remove still works when
  // disabled — that's the cleanup path after flipping the flag.
  if (!args.remove && config.workspace && config.workspace.root_context === false) {
    console.log(`root_context is disabled for workspace "${slug}" (config.workspace.root_context: false) — skipping routing context generation.`);
    process.exit(0);
  }

  const { targets, skipped, hoisted } = resolveTargets(config);
  let warned = skipped.length > 0;
  for (const h of hoisted) console.log(`note: ${h.from} is inside a git repo — placing the routing context above it at ${h.to}`);
  for (const s of skipped) console.warn(`WARN:  skipping ${s.dir} — ${s.reason}`);
  if (targets.length === 0) {
    console.error('no eligible repo parent directories resolved from config — nothing to write.');
    process.exit(1);
  }

  let failed = false;
  for (const parent of targets) {
    try {
      if (args.remove) {
        const { action, target, warnings } = remove(parent, slug, { dryRun: !!args['dry-run'] });
        for (const w of warnings) console.warn(`WARN:  ${w}`);
        if (warnings.length > 0) warned = true;
        console.log(`${args['dry-run'] ? '[dry-run] ' : ''}${target}: ${action} (workspace: ${slug})`);
        continue;
      }
      const { action, target, migrated, legacy, warnings } = ensure(parent, slug, workspaceDir, { dryRun: !!args['dry-run'] });
      for (const w of warnings) console.warn(`WARN:  ${w}`);
      if (warnings.length > 0) warned = true;
      const extras = [
        migrated && `migrated legacy ${CONTEXT_SHIM} → ${CONTEXT_FILENAME} + shim`,
        legacy && `legacy mode: container maintained in hand-authored ${CONTEXT_SHIM}`,
      ].filter(Boolean);
      console.log(`${args['dry-run'] ? '[dry-run] ' : ''}${target}: ${action} (workspace: ${slug})${extras.length ? ' — ' + extras.join('; ') : ''}`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : warned ? 2 : 0);
}

module.exports = { ensure, remove, resolveTargets, renderBlock, renderContainer, parseBlocks, ensureUserBreadcrumb, renderMachineBlock };
