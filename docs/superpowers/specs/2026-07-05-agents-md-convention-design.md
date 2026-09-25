# Design — Converge the repo-context file on `AGENTS.md`

**Date:** 2026-07-05
**Status:** approved (proceeding to implementation)
**Related:** dual-target Cursor work (`feat/cursor-dual-target`), memory `cursor-dual-target.md`

## Goal

Make PipeCrew's per-repo agent-context file **tool-agnostic** so the plugin can target
Claude Code, Cursor, Codex, and future AI tools without a per-tool naming matrix.

## Decision

**`AGENTS.md` is the single canonical repo-context file, on every harness.** It is the
Linux-Foundation (AAIF) governed standard read natively by 30+ agents (Codex, Cursor, Copilot,
Gemini CLI, Aider, Zed, Windsurf, Devin, …). Claude Code also reads it (via import), with
`CLAUDE.md` as its *richer* native format.

Rules:

1. **Canonical content lives in `{repo}/AGENTS.md`.** The crew generates it and reads it.
2. **Under Claude Code only, also emit a thin `{repo}/CLAUDE.md` shim** whose entire body is an
   import of the canonical file:
   ```
   @AGENTS.md
   ```
   This preserves Claude Code's richer native loading with **one source of content** (no drift).
   Under Cursor/Codex/others, no `CLAUDE.md` is written — those tools read `AGENTS.md` natively.
3. **No per-tool naming matrix.** New tools cost zero naming work. Only a tool that *demands* its
   own filename ever gets a 1-line import shim, added then.

## Read semantics (back-compat, no forced migration)

Everywhere the crew consumes the repo-context file it uses this order:

> **prefer `{repo}/AGENTS.md`; if absent, fall back to `{repo}/CLAUDE.md`.**

This means **existing Claude-only workspaces keep working untouched** — they have `CLAUDE.md` and
no `AGENTS.md`, so the fallback picks up `CLAUDE.md`. Nothing breaks on upgrade.

## Migration (opt-in, non-destructive)

No forced migration. On the next `/discover --resume` or `/context-refresh` for a repo:

- If `AGENTS.md` is **absent** but `CLAUDE.md` **exists** (legacy): create `AGENTS.md` from the
  current `CLAUDE.md` content (rename/rewrite), and — under Claude Code — replace `CLAUDE.md` with
  the `@AGENTS.md` shim. Show a diff / one-line notice; never silently clobber a hand-edited file.
- If `AGENTS.md` already exists: it's canonical; leave it.

Because reads fall back to `CLAUDE.md`, migration can happen lazily whenever a repo is next
refreshed — there is no big-bang conversion.

## Resolver (single source of truth)

Extend `scripts/workspace-root.js` (already harness-aware) with:

- `--context-filename` → prints `AGENTS.md` (canonical; same on all harnesses).
- `--context-shim` → prints `CLAUDE.md` under Claude Code, empty under others (tells generation
  whether to also write the import shim).

Skills/agents resolve these instead of hardcoding, mirroring the existing `--agents-dir` pattern.

## Blast radius & implementation order

`CLAUDE.md` appears ~127× across ~40 files. Staged, each step keeping `node eval/run.js` green:

1. **Resolver + tests** — `--context-filename` / `--context-shim` in `workspace-root.js`; extend
   `workspace-root.test.js`.
2. **Generation** — `discover/phase-c-generation.md` writes `AGENTS.md` (+ Claude shim); rename
   `templates/repo-CLAUDE*.md.template` → `templates/repo-AGENTS*.md.template`; update references.
   Add the migration step (legacy `CLAUDE.md` → `AGENTS.md` + shim).
3. **Consumption — shared rules first** — `rules/implementer-common.md`, `rules/reviewer-common.md`,
   `rules/incremental-discovery.md`: define "the repo context file (`AGENTS.md`, fallback
   `CLAUDE.md`)" once; most agents inherit from here.
4. **Consumption — agent prompts** — sweep `agents/*.md` (esp. `context-manager.md`, the writer;
   `repo-discoverer.md`; implementers/reviewers) + `templates/agents/*.template` to read the
   resolved context file with fallback.
5. **Validator** — `validate-claude-md.js` accepts/validates `AGENTS.md` (keep validating a
   `CLAUDE.md` shim as a valid import). Update its test. Keep `validate-claude-md.js` filename or
   alias — TBD-minimal.
6. **Docs** — README, plugin `CLAUDE.md` (dev guide) note the convention. (The plugin's own root
   `CLAUDE.md` stays — that's this repo's dev guide, not a generated repo-context file.)

## Non-goals / guardrails

- **The plugin's own root `CLAUDE.md`** (this repo's dev guide) is **out of scope** — it is not a
  generated repo-context file. Leave it.
- Don't fold this into the dual-target PR; it's its own reviewed change with the migration.
- Claude Code behavior for existing workspaces must remain correct via the read-fallback.

## Testing

- `node eval/run.js` green at every step.
- `workspace-root.test.js` covers `--context-filename` (= `AGENTS.md`) and `--context-shim`
  (`CLAUDE.md` under claude, empty under cursor).
- A structural eval check: generation templates exist under the new names; no consumer references
  `CLAUDE.md` without an `AGENTS.md`-first fallback (except the plugin's own dev-guide `CLAUDE.md`).

## Rollback

The read-fallback makes this safe: if `AGENTS.md` generation regresses, workspaces with a
`CLAUDE.md` still resolve. Revert is a normal git revert of the branch.
