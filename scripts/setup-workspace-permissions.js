#!/usr/bin/env node
/**
 * setup-workspace-permissions.js — write a repo-scoped `.claude/settings.local.json`
 * so a pipecrew user stops being prompted for routine, clearly-safe operations when
 * working interactively across the workspace's repos.
 *
 * WHY THIS EXISTS (and how it differs from the other two approval helpers):
 *   - scripts/deliver-autoapprove-hook.js is a PreToolUse hook that auto-approves the
 *     SUBAGENT flood during an active `/deliver --auto-approve` run. It is runtime,
 *     marker-gated, and disappears when the run ends.
 *   - /discover Step 3.5 writes settings to {workspace_root}/{slug}/.claude/. That only
 *     loads when `claude` is launched from the WORKSPACE dir — useless for a user who
 *     launches from a repo (the common case), and it grants no additionalDirectories,
 *     so cross-repo edits still prompt.
 *   - THIS script targets the gap: it writes settings to the repos' common PARENT dir,
 *     which Claude Code discovers by walking up from any repo (or worktree) under it, and
 *     it grants `additionalDirectories` so editing a sibling repo from inside another
 *     repo's cwd no longer prompts. These are persistent, interactive-session settings.
 *
 * SAFETY:
 *   - It only ever ALLOWS clearly-safe, reversible operations (file edits + read-only /
 *     local-only git + build/test/read commands). Outward-facing or destructive commands
 *     (git push / reset --hard / clean, rm, deploys, docker push, …) are deliberately NOT
 *     listed, so they keep prompting.
 *   - It MERGES into any existing settings.local.json (union of arrays, existing entries
 *     preserved and order-stable) — it never clobbers a hand-curated file. An unparseable
 *     existing file is left untouched and reported, not overwritten.
 *   - settings.local.json is personal + git-ignored by Claude Code convention, so writing
 *     it imposes nothing on teammates.
 *
 * Usage:
 *   node setup-workspace-permissions.js --config=<path/to/config.json> [--dry-run]
 *
 * Exit codes: 0 ok (or dry-run) · 1 usage / bad config.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

// ── args ───────────────────────────────────────────────────────────────
function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}
const DRY_RUN = process.argv.includes('--dry-run');
const configPath = arg('config');

if (!configPath) {
  console.error('usage: setup-workspace-permissions.js --config=<path/to/config.json> [--dry-run]');
  process.exit(1);
}

// Normalize a filesystem path to forward slashes (Claude Code accepts these on
// Windows too, and it keeps the emitted JSON consistent across platforms).
function fwd(p) { return p.replace(/\\/g, '/'); }

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`cannot read/parse config: ${configPath}\n  ${e.message}`);
  process.exit(1);
}

const repos = config && config.repos;
if (!repos || typeof repos !== 'object' || Object.keys(repos).length === 0) {
  console.error('config has no repos — nothing to set up.');
  process.exit(1);
}

// ── compute the directory set ──────────────────────────────────────────
const workspaceDir = fwd(path.dirname(path.resolve(configPath)));

const repoPaths = [];
for (const [name, spec] of Object.entries(repos)) {
  if (!spec || typeof spec.path !== 'string' || !spec.path.trim()) {
    console.error(`warning: repo "${name}" has no path — skipping.`);
    continue;
  }
  repoPaths.push(fwd(path.resolve(spec.path)));
}
if (repoPaths.length === 0) {
  console.error('no repo paths resolved from config — nothing to set up.');
  process.exit(1);
}

function unique(arr) { return [...new Set(arr)]; }

// Parent dir of each repo — granting the parent covers the repo, its siblings,
// AND any git worktrees that sit beside it (e.g. <repo>-<feature>). This is the
// single most effective entry for killing cross-repo prompts.
const repoParents = unique(repoPaths.map((p) => fwd(path.dirname(p))));

// additionalDirectories: extend the trusted root beyond cwd to every repo parent
// plus the workspace docs dir, so edits anywhere in the workspace don't prompt.
const additionalDirectories = unique([...repoParents, workspaceDir]);

// Where to write a settings file: one per distinct repo parent. Claude Code walks
// up from the launch cwd, so a file at the parent loads for every repo/worktree
// under it. (Usually all repos share one parent → exactly one file.)
const targetDirs = repoParents;

// ── the safe allow-list (conservative; outward/destructive stay prompted) ──
const SAFE_ALLOW = [
  // File edits — the bulk of the prompt flood in editing-heavy sessions.
  'Edit',
  'Write',
  // Read-only git.
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(git rev-parse:*)',
  'Bash(git rev-list:*)',
  'Bash(git fetch:*)',
  'Bash(git remote -v:*)',
  'Bash(git stash list:*)',
  'Bash(git worktree list:*)',
  // Local-only, reversible git writes (push/reset --hard/clean are NOT here).
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git checkout -b:*)',
  'Bash(git switch -c:*)',
  // Build / test / lint — harmless if a given repo doesn't use the tool.
  'Bash(npm test:*)',
  'Bash(npm run:*)',
  'Bash(npm ci:*)',
  'Bash(npm install:*)',
  'Bash(npx vitest:*)',
  'Bash(npx tsc:*)',
  'Bash(npx eslint:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(./mvnw:*)',
  'Bash(mvn:*)',
  'Bash(./gradlew:*)',
  'Bash(gradle:*)',
  'Bash(pytest:*)',
  'Bash(python -m pytest:*)',
  'Bash(python3 -m pytest:*)',
  'Bash(poetry run:*)',
  'Bash(ruff:*)',
  'Bash(mypy:*)',
  // Build/test for additional stacks — verb-scoped so the dangerous subcommands
  // (go/cargo/dotnet install/publish/nuget push) keep prompting.
  'Bash(go test:*)',
  'Bash(go build:*)',
  'Bash(go vet:*)',
  'Bash(cargo build:*)',
  'Bash(cargo test:*)',
  'Bash(cargo check:*)',
  'Bash(dotnet build:*)',
  'Bash(dotnet test:*)',
  'Bash(npx jest:*)',
  'Bash(npx prettier:*)',
  // The /deliver orchestrator drives worktree lifecycle (add/remove/list) and
  // diffs against the merge-base — worktrees are disposable, merge-base is read-only.
  'Bash(git worktree:*)',
  'Bash(git merge-base:*)',
  // The plugin's own zero-dep scripts (gate.js, extract-block.js, validate-*.js, …).
  'Bash(node *pipecrew/scripts/*)',
  // chrome-devtools MCP — Phase 6 live browser verification (navigate / click /
  // screenshot / read console+network). Server name matches scripts/ensure-mcp.js
  // (`--name=chrome-devtools`); the assessor only drives it against localhost.
  'mcp__chrome-devtools__*',
  // Read / inspect.
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(find:*)',
  'Bash(tree:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(jq:*)',
];

// Union two arrays preserving order: existing entries first, then any new ones.
function union(existing, incoming) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out);
  for (const item of incoming) {
    if (!seen.has(item)) { out.push(item); seen.add(item); }
  }
  return out;
}

// ── apply ──────────────────────────────────────────────────────────────
const results = [];
for (const dir of targetDirs) {
  const claudeDir = path.join(dir, '.claude');
  const file = path.join(claudeDir, 'settings.local.json');
  const rel = fwd(file);

  let existing = {};
  let parseFailed = false;
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
    catch { parseFailed = true; }
  }

  if (parseFailed) {
    results.push({ file: rel, action: 'skipped (existing file is not valid JSON — left untouched)' });
    continue;
  }

  const perms = (existing.permissions && typeof existing.permissions === 'object')
    ? existing.permissions : {};
  const beforeAllow = Array.isArray(perms.allow) ? perms.allow.length : 0;
  const beforeDirs = Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories.length : 0;

  const merged = {
    ...existing,
    permissions: {
      ...perms,
      additionalDirectories: union(perms.additionalDirectories, additionalDirectories),
      allow: union(perms.allow, SAFE_ALLOW),
    },
  };

  const addedAllow = merged.permissions.allow.length - beforeAllow;
  const addedDirs = merged.permissions.additionalDirectories.length - beforeDirs;
  const verb = fs.existsSync(file) ? 'merged' : 'created';

  if (DRY_RUN) {
    results.push({ file: rel, action: `would ${verb} (+${addedDirs} dirs, +${addedAllow} allow rules)` });
    continue;
  }

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  results.push({ file: rel, action: `${verb} (+${addedDirs} dirs, +${addedAllow} allow rules)` });
}

// ── report ─────────────────────────────────────────────────────────────
console.log(`${DRY_RUN ? '[dry-run] ' : ''}workspace permissions for ${Object.keys(repos).length} repos`);
console.log(`  additionalDirectories granted: ${additionalDirectories.join(', ')}`);
for (const r of results) console.log(`  ${r.action}  ->  ${r.file}`);
if (!DRY_RUN) {
  console.log('Restart claude (or run /permissions) in an affected directory to load the new rules.');
}
process.exit(0);
