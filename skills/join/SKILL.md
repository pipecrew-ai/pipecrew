---
name: join
description: "Onboard a teammate onto an EXISTING pipecrew workspace from its shared GitHub memory repo — no /discover, no re-analysis. Clones the private memory repo (context/platform.md, agents/, history/, config.portable.json), then rebuilds the machine-specific config.json locally: for each repo it either clones from the repo's repo_url into {slug}-repos/ or points at a copy the teammate already has. The inverse of what the workspace owner published via memory-sync. Use when a colleague has set up a workspace with GitHub-backed memory and you want to run /deliver, /review, etc. against the same shared platform context."
---

## Usage

```
/pipecrew:join <memory-repo-url>            [--workspace=<slug>] [--repos-root=<dir>] [--mode=clone|local]
```

`<memory-repo-url>` is the **private** memory repo the workspace owner created
(default name `{slug}-memory`, e.g. `git@github.com:acme/acme-saas-memory.git`).
It is the same URL that shows up as `config.workspace.memory.remote` on their machine.

This skill is the teammate counterpart to `/pipecrew:memory-sync`: memory-sync
*operates on* memory you already have (status / pull / sync / enable); `join`
*gets you the memory in the first place* and wires up a working local workspace.

---

## Instructions

### CRITICAL RULES
- **The memory remote MUST be private.** After cloning, verify visibility (`gh repo view <url> --json visibility`). If it is public, STOP and warn the user — a public memory repo is a privacy defect on the owner's side; do not continue wiring it up as if trusted.
- **Never clone code repos without confirmation.** Cloning is a network fetch. List every repo + its `repo_url` and get a single explicit yes before cloning (Step 4). Repos with no `repo_url` can only be pointed-to-local — never guess a URL.
- **Do not run redaction or push anything.** `join` is read-mostly on the memory side: it clones and reads. It writes only local, gitignored files (`config.json`, `config.local.json`). It never commits to or pushes the memory repo — the owner's syncs and the teammate's later runs do that.
- **This is not `/discover`.** Never re-analyze the code or regenerate `platform.md`/agents — the shared memory is authoritative. If the teammate wants a fresh analysis, that's `/discover`, not `join`.

### Step 1: Resolve workspace_root + slug

1. **`{workspace_root}`**: `node {plugin_dir}/scripts/workspace-root.js --check`. If it exits non-zero, prompt for a root and set it: `node {plugin_dir}/scripts/workspace-root.js --set=<path>`. Then `--get` the resolved absolute path.
2. **`{slug}`**: from `--workspace=<slug>` if given; else derive from the remote URL's repo name with any trailing `-memory` stripped (e.g. `acme-saas-memory.git` → `acme-saas`). Confirm the derived slug with the user before creating anything.
3. If `{workspace_root}/{slug}/` already exists:
   - If it's already this memory repo (same `origin`) → skip Step 2, go to Step 3 (re-join / repair).
   - If it exists but is something else → STOP and ask; do not clobber.

### Step 2: Clone the memory repo

```bash
git clone <memory-repo-url> {workspace_root}/{slug}
```
Then enforce privacy (CRITICAL RULE 1). On success you now have `context/`, `agents/`,
`history/`, and `config.portable.json` locally. You do **not** have the code repos or a
`config.json` yet — that's the rest of this skill.

### Step 3: Read the repo roster

Read `{workspace_root}/{slug}/config.portable.json`. Each `repos.{key}` entry carries:
- `dir` — the owner's subpath (informational; not used to place the teammate's clones),
- `repo_url` — the clone URL if the owner captured one (**absent ⇒ point-to-local only**),
- `type` / `role` / `description`.

Present the roster to the user: which repos have a `repo_url` (cloneable) and which don't.

### Step 4: Resolve each repo to a local path

Ask the user once: **clone the repos, or point at copies you already have?** (`--mode` skips the ask.)

**Clone mode** (`--mode=clone`):
- Default clone root is `{workspace_root}/{slug}-repos/` — a **sibling** of the memory repo, never inside it (the memory repo is itself a git repo). Override with `--repos-root=<dir>`; confirm the target with the user.
- List every repo with a `repo_url` + its destination `{clone_root}/{key}`, then — after one explicit confirmation — clone each:
  ```bash
  git clone <repo_url> {clone_root}/{key}
  ```
- Any repo **without** a `repo_url` cannot be cloned — fall back to asking the user for a local path for it, or `--skip` it.

**Local mode** (`--mode=local`):
- Ask for the `repos_root` the teammate already uses. For each repo, the local path is `{repos_root}/{key}` by default; if their layout differs, collect an explicit path per repo.

Either way you end up with, per repo, one of: an absolute local path, or a decision to skip. Build a `--map=key=path,...` for explicit paths and a `--skip=key,...` for any the teammate opts out of. Use a single `--repos-root` when every path is just `{root}/{key}`.

### Step 5: Rebuild config.json

```bash
node {plugin_dir}/scripts/rehydrate-config.js \
  --portable={workspace_root}/{slug}/config.portable.json \
  --out={workspace_root}/{slug}/config.json \
  [--repos-root={clone_root or teammate repos_root}] \
  [--map=key=abs,...] [--skip=key,...]
```
This strips the portable markers (`_portable`, `repos_root`, per-repo `dir`), sets each
repo's local `path`, keeps `repo_url`, and preserves the `workspace.memory` block so
auto-sync stays on. It refuses (exit 2) if any repo has neither a mapped path nor a
`--repos-root` — resolve or `--skip` those and re-run.

Then record the teammate's root so future `config.portable.json` regens stay stable:
```bash
# {workspace_root}/{slug}/config.local.json  (gitignored)
{ "repos_root": "{clone_root or teammate repos_root}" }
```

### Step 6: Validate + report

```bash
node {plugin_dir}/scripts/validate-config.js {workspace_root}/{slug}/config.json
node {plugin_dir}/scripts/sync-memory.js status {workspace_root}/{slug}
```
- The validator confirms every resolved `path` exists on disk (so it catches a clone that
  didn't land or a wrong local path) — fix and re-run Step 5 on any error.
- `status` confirms the memory repo is wired and reports how fresh it is.

Report one concise summary: workspace joined, N repos wired (cloned / local / skipped),
memory sync mode, and the next step — e.g. `Run /deliver --workspace={slug}`. Note that
future runs pull the team's latest memory at pre-flight and sync back automatically.

---

## Notes
- **Relationship to `/discover`:** `discover` builds a workspace by *analyzing code*; `join` reconstructs one by *reading shared memory*. A teammate who joins never pays for re-analysis and gets exactly the owner's curated `platform.md`, agents, and history.
- **Relationship to `/memory-sync`:** after `join`, the daily surface is `/pipecrew:memory-sync status | pull | sync`. `join` is a one-time (or repair) action.
- **Skipped repos:** if a teammate only works part of the platform, `--skip` leaves those repos out of their local `config.json` (and drops any service that referenced them, so the config still validates). They can re-run `join` later to add them.
- **No `repo_url` anywhere?** Older workspaces onboarded before `repo_url` capture won't have clone URLs — that's fine, `join` runs fully in point-to-local mode. The owner can re-run `/discover` (or add `repo_url` by hand) to enable cloning for the next teammate.
