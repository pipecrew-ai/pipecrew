# Workspace registry — let workspaces live anywhere, stop orphaning them

Status: **implemented** in v1.10.0 (`scripts/workspace-registry.js` + a compat shim in
`scripts/workspace-root.js`; skills resolve via the registry). Auto-migration is on by
default and idempotent. This doc is the design of record.

## Problem

PipeCrew resolves a **single** `workspace_root` (`scripts/workspace-root.js`), and all
workspaces must be siblings under it:

```
1. $PIPECREW_WORKSPACE_ROOT env var (escape hatch, never persisted)
2. ~/.claude/pipecrew/config.json → workspace_root
3. default ~/.claude/pipecrew/workspaces/
```

Two consequences fall out of "one mutable root":

1. **Repointing the root silently orphans existing workspaces.** Change `workspace_root`
   and every workspace under the *old* root disappears from view — no warning, no record
   they existed. Observed in the wild: a user onboarded `dal-platform` (ABVI) under
   `C:/ABVI/pipecrew-workspaces/`, later repointed the root to
   `C:/AI/pipecrew project/pipecrew/` for unrelated work, and the ABVI workspace became
   invisible. Nothing was deleted — it just fell outside the active root. It read as
   "where did my workspace go?"

2. **Workspaces can't live where their code lives.** A workspace naturally belongs next
   to its repos (the ABVI workspace near `C:/ABVI/repos`, the pipecrew workspace near
   `C:/AI/...`). A single parent forces all of them into one arbitrary directory, so a
   user with two unrelated projects **cannot** keep both reachable at once — they repoint,
   and split (the exact failure above). It also produces duplicate onboardings of the same
   project under different roots.

The root is nearly vestigial: each workspace is already a **self-contained folder**
(`config.json` + `context/` + `agents/` + `history/` + `runs/`) and independently
shareable via its own memory repo. The root's only real job is "the directory I scan for
slugs." That is a weak reason to force one location and let it be mutated destructively.

## Design

Replace the single root with a **registry of workspaces, each addressable by its own
absolute path**. The plugin config records the set of known workspaces plus which one is
current; a workspace may live anywhere on disk.

```jsonc
// ~/.claude/pipecrew/config.json
{
  "workspaces": [
    { "slug": "dal-platform",       "path": "C:/ABVI/pipecrew-workspaces/dal-platform" },
    { "slug": "pipecrew-workspace", "path": "C:/AI/pipecrew project/pipecrew/pipecrew-workspace" }
  ],
  "current": "pipecrew-workspace"
}
```

- **`/discover` registers.** On onboarding, the new workspace's `{slug, path}` is appended
  and set `current`. The workspace folder is created wherever the user points it (default
  can stay `~/.claude/pipecrew/workspaces/{slug}` for users who don't care).
- **Selection by slug, from the registry.** `--workspace=<slug>` looks the path up in the
  registry (no directory scan). Absent flag → use `current`; if `current` is unset and
  more than one is registered, ask.
- **Switching is explicit.** `current` changes only via `--workspace` or an explicit set —
  never as a side effect. Nothing is ever orphaned: every workspace you've onboarded stays
  listed, wherever it lives.
- **`/join` registers too.** A teammate who joins an existing workspace adds it to their
  own registry — same mechanism, so joined and discovered workspaces are peers.

### Resolution precedence (new)

```
1. $PIPECREW_WORKSPACE_ROOT / $PIPECREW_WORKSPACE  env override (unchanged escape hatch)
2. --workspace=<slug>  → registry lookup → its .path
3. config.current      → registry lookup → its .path
4. exactly one registered → that one
5. none registered     → prompt (discover/onboard flow), as today
```

### Backward compatibility (mandatory — users already have workspaces)

No existing install should break or lose a workspace:

- **Auto-migrate on first read.** If the config still has the old `workspace_root` string
  and no `workspaces[]`, scan `{workspace_root}/*/config.json` once, register each found
  workspace by its real path, set `current` to the last-used (or the sole) one, and keep
  `workspace_root` in place as a deprecated hint. Idempotent; never deletes anything.
- **Adopt orphaned roots.** Offer a `discover`/registry command that scans a *given*
  directory (e.g. the old ABVI root) and registers any workspaces it finds — the one-shot
  fix for a user who already split across two roots.
- **Env var still wins.** `$PIPECREW_WORKSPACE_ROOT` continues to override everything, so
  scripted/CI usage is unaffected. (Add `$PIPECREW_WORKSPACE` as a slug-or-path alias.)
- **`workspace-root.js --get` keeps working.** It returns the *parent of the current
  workspace* so legacy callers that still join `{root}/{slug}` resolve correctly during
  the transition. New code should call a `--get-workspace[=slug]` that returns the
  workspace path directly.

## Components / blast radius

`workspace-root.js` is referenced by **14 files across 9 skills** (`brainstorm`,
`context-refresh`, `deliver`, `discover`, `join`, `learn`, `memory-sync`, `patch`,
`site-view`). The migration is designed to keep them working unchanged, then modernize
incrementally.

| File | Change |
|---|---|
| `scripts/workspace-root.js` | Becomes (or is joined by) `workspace-registry.js`: registry read/write, `--list`, `--current`, `--get-workspace[=slug]`, `--register=<path>`, `--set-current=<slug>`, `--adopt=<dir>`. Keep `--get`/`--set`/`--check` as compatibility shims (auto-migrating). |
| `scripts/workspace-registry.test.js` | New: migration idempotency, slug lookup, adopt-scan, precedence order, "path anywhere" round-trip. |
| Skills' pre-flight (the 9 above) | Replace the `{workspace_root}/*/config.json` scan (5 sites) with a registry lookup; unchanged behavior when only one workspace is registered. |
| `/discover`, `/join` | Register the workspace (+ set `current`) at the end of onboarding. |
| `templates/workspace-config.schema.json` / docs | Note that a workspace path is registry-tracked, not root-relative. |
| `CLAUDE.md`, `README` | Document the registry + `--list`/switch commands. |

## Non-goals

- Not moving anyone's files. Registration records a path; it never relocates a workspace.
- Not a multi-root scan-everything mode. Discovery is explicit (`--adopt=<dir>`), so we
  never crawl the whole disk guessing where workspaces might be.
- Not changing the per-workspace memory design — each workspace stays self-contained and
  independently shareable regardless of where it sits in the registry.

## Open questions

- **Prune semantics.** When a registered path no longer exists (deleted/moved), do we
  warn-and-keep, or offer to unregister? Lean warn-and-keep (a moved drive shouldn't drop
  history); add an explicit `--forget=<slug>`.
- **Per-workspace vs. global default location.** Keep `~/.claude/pipecrew/workspaces/` as
  the default *creation* dir for users who don't specify, while allowing any path? (Yes,
  recommended — zero-config still works.)
