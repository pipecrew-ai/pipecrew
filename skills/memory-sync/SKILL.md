---
name: memory-sync
description: "Manage a workspace's GitHub-backed shared memory directly — without running a full pipeline. Subcommands: status (freshness / ahead-behind / unpushed), pull (fetch the team's latest now), sync (redact + commit + publish any pending durable-doc changes / retry a failed push), enable (turn memory on for an already-onboarded workspace and bootstrap its private repo). The automatic syncs in /discover, /learn, /context-refresh, and /deliver still run on their own; this skill is the manual + operational control surface over scripts/sync-memory.js. Named memory-sync (not memory) to avoid Claude Code's built-in /memory command."
---

## Usage

```
/pipecrew:memory-sync status  [--workspace=<slug>] [--json]
/pipecrew:memory-sync pull    [--workspace=<slug>]
/pipecrew:memory-sync sync    [--workspace=<slug>] [--message="<msg>"] [--sync-mode=commit|pr|hybrid]
/pipecrew:memory-sync enable  [--workspace=<slug>] [--remote=<url>] [--sync-mode=commit|pr|hybrid]
```

The first positional token is the **subcommand** (defaults to `status` if omitted). Everything operates on the workspace's memory repo at `{workspace_root}/{slug}/` — the *shared, team* tier (`context/`, `agents/`, `history/`, `config.portable.json`). Per-repo docs (`CLAUDE.md`, `agent-context/`) live in the code repos' own git and are NOT touched here.

| Subcommand | What it does | Mutates? |
|---|---|---|
| `status` (default) | Freshness (last change + who), behind/ahead of origin, unpushed commits, dirty tree, sync mode | no |
| `pull` | `fetch` + `pull --rebase` to the team's latest; refuses over a dirty tree | local only (fast-forwards) |
| `sync` | redact → regenerate `config.portable.json` → commit → rebase → publish per `sync_mode`; retries a previously-failed push | yes |
| `enable` | Turn memory on for an existing workspace: bootstrap the private repo (or attach a remote), set `config.workspace.memory`, do the first sync | yes |

---

## Instructions

### CRITICAL RULES
- This skill is a thin wrapper over `node {plugin_dir}/scripts/sync-memory.js`. The script is the engine — do not reimplement redaction, rebase, or PR routing here.
- **Never weaken privacy.** A memory remote MUST be private (`visibility: private`). If a user passes a remote that resolves to a public repo, STOP and ask — never push.
- **Never fail loudly on network.** `status` and `pull` are warn-only; a fetch failure reports "remote not reachable" and uses the local copy. Match the script's behavior — do not treat an offline machine as an error.
- **Redaction is mandatory and lives in the script.** Every `sync`/`enable` path runs through `sync-memory.js`, which redacts before committing. Do not bypass it with a raw `git commit`.

### Step 1: Resolve workspace + subcommand

1. **Subcommand**: first non-flag positional token → one of `status` / `pull` / `sync` / `enable`. If absent, default to `status`.
2. **Resolve the workspace** from the registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json` (add `--workspace=<slug>` if given) → `{slug, path, root}`. Set `{slug}` = `.slug` and `{workspace_root}` = `.root`. If it exits 3, it lists candidates: one → use it, many → ask which slug, none → tell the user to run `/discover` or `/join`.
4. Validate config: `node {plugin_dir}/scripts/validate-config.js {workspace_root}/{slug}/config.json`. Halt on errors.
5. Read `config.workspace.memory`. For `status` / `pull` / `sync`: if memory is **absent or `enabled:false`**, tell the user it's off and point them at `enable` (don't error). For `enable`: proceed even when off — that's the point.

### Step 2 — `status` (read-only)

```bash
node {plugin_dir}/scripts/sync-memory.js status {workspace_root}/{slug}
```
Relay the one-line result. If `--json` was passed, add `--json` and surface the structured fields (the reporter / site-view can consume this). Interpret for the user when useful:
- `behind origin` → suggest `/pipecrew:memory-sync pull`.
- `unpushed local commits` → suggest `/pipecrew:memory-sync sync` (a prior push likely failed).
- `not bootstrapped` → suggest `/pipecrew:memory-sync enable`.
- If `status` or `sync` shows no `domain.id` in `config.json`, mention the back-fill command: `node {plugin_dir}/scripts/mint-domain-id.js --config={workspace_root}/{slug}/config.json`.

### Step 3 — `pull` (get the team's latest)

```bash
node {plugin_dir}/scripts/sync-memory.js pull {workspace_root}/{slug}
```
Relay the freshness line. If the tree is dirty the script skips the pull (it won't clobber local edits) and says so — tell the user to `sync` their pending changes first, then pull.

### Step 4 — `sync` (publish pending changes / retry a failed push)

Use this when `status` shows unpushed commits or a dirty tree (e.g. an earlier automatic sync committed locally but the push failed offline), or when the user hand-edited a durable doc and wants it shared.

```bash
node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} \
  --message "{message}" --checkpoint=manual \
  [--sync-mode={mode if --sync-mode passed}]
```
- Default `--message` to `"memory-sync: manual update"` if the user didn't supply one.
- `--checkpoint=manual` labels any PR branch (`memory/manual-<sha>`).
- The script picks commit-vs-PR from `sync_mode` + what changed (see `docs/design/github-memory.md` §3); relay whether it pushed to `main` or opened a PR. If it reports a `gh pr create` failure, the branch is still pushed — tell the user to open the PR manually (give them the branch name).

### Step 5 — `enable` (turn memory on for an existing workspace)

This is the standalone path so the user does **not** have to re-run `/discover` just to switch memory on. Mirrors `/discover` Phase D Step 8 bootstrap.

1. **Confirm intent + privacy.** Memory will commit the workspace's durable docs (redacted) to a **private** GitHub repo shared with the team. Confirm before creating anything.
2. **Write config.** Set in `{workspace_root}/{slug}/config.json`:
   ```jsonc
   "workspace": { "memory": {
     "enabled": true,
     "remote": "<--remote=… if given, else filled in after gh repo create>",
     "visibility": "private",
     "sync_mode": "<--sync-mode=… else 'hybrid'>"   // hybrid is the shared-team default
   }}
   ```
3. **Bootstrap the repo** (only if `{workspace_root}/{slug}/` is not yet a git repo):
   ```bash
   cd {workspace_root}/{slug}
   git init -q && git branch -M main
   cp {plugin_dir}/templates/workspace-memory.gitignore .gitignore
   ```
4. **Establish the PRIVATE remote** (refuse anything non-private):
   - `--remote=<url>` given → `git remote add origin <url>`.
   - else → `gh repo create {config.workspace.memory.repo_name || "{slug}-memory"} --private --source=. --remote=origin`, then write the resulting URL back into `config.workspace.memory.remote`.
   - If the resolved remote is public, STOP and ask.
5. **First sync:**
   ```bash
   node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} \
     --message "memory-sync: enable + first sync ({slug})" --checkpoint=enable
   ```
   The first commit creates `main`, so it's a direct push regardless of `sync_mode`. Relay the result; on push failure, the commit is local — surface the warning and the fix (auth / create the remote), don't fail.

### Step 6: Report

One concise line per the subcommand outcome. For `enable`, also tell the user the feature is now on and that future `/discover` / `/learn` / `/context-refresh` / `/deliver` runs will pull at pre-flight and sync at their checkpoints automatically.

---

## Notes

- **Relationship to the automatic syncs.** `/discover`, `/learn`, `/context-refresh`, and `/deliver` already pull at pre-flight and sync at their checkpoints. This skill does not replace that — it's for the off-cycle cases: checking health, pulling on demand, retrying a failed push, and enabling memory after onboarding.
- **Sync modes** (`config.workspace.memory.sync_mode`): `commit` (push to `main`), `pr` (always a `memory/*` PR), `hybrid` (PR for `platform.md`/ADR changes, commit for bookkeeping). See `docs/design/github-memory.md`.
- **Why not named `/memory`?** Claude Code ships a built-in `/memory` command for editing `CLAUDE.md` files. This skill is namespaced `pipecrew:memory-sync` to stay unambiguous.
