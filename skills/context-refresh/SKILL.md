---
name: context-refresh
description: "Audit or refresh PipeCrew context docs at three scopes: a single repo (its agent-context/, CLAUDE.md, and DESIGN_SYSTEM.md if frontend), the workspace (platform.md + stacks/{type}.md per tech stack), or everything (workspace + every repo). Audit mode reports staleness only; refresh mode updates docs to match current code."
---

## Usage

```
/context-refresh <repo-key-or-path> [--mode=audit|refresh] [--workspace=<slug>]
/context-refresh --workspace=<slug> [--mode=audit|refresh] [--stacks-only|--skip-stacks]
/context-refresh --all [--workspace=<slug>] [--mode=audit|refresh]
```

### Scopes (pick one)

| Scope | Selector | What's audited / refreshed |
|---|---|---|
| Single repo | `<repo-key-or-path>` | That repo's `agent-context/`, `CLAUDE.md`, and `agent-context/common/DESIGN_SYSTEM.md` (if frontend) |
| Workspace | `--workspace=<slug>` | `{workspace_root}/{slug}/context/platform.md` + every `context/stacks/*.md` |
| Everything | `--all` | Workspace scope + every repo in the config |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `audit` | `audit` = report only. `refresh` = apply updates. |
| `--workspace` | auto-detect | Workspace slug. Auto-detected for single-repo when omitted; required for `--workspace` and `--all`. |
| `--stacks-only` | false | Workspace / all scope: skip `platform.md`, refresh only `stacks/*.md`. |
| `--skip-stacks` | false | Workspace / all scope: skip `stacks/*.md`, refresh only `platform.md`. |
| `--full` | false | Bypass the git-diff fast path; force a full claim-verification audit. Use when you suspect the docs are wrong about claims that pre-date the last refresh. |
| `--since=<sha\|tag\|ref>` | — | Override the comparison point for the fast path. Useful for "audit since last release tag" workflows. Implies `--mode=refresh` is delta-driven from this ref. |

### Examples

```
# Single-repo audit
/context-refresh publisher-service

# Single-repo refresh (also updates DESIGN_SYSTEM.md if frontend)
/context-refresh abvi-pms-frontend --mode=refresh

# Workspace-level audit — all workspace context docs
/context-refresh --workspace=dal

# Workspace-level refresh, stacks only
/context-refresh --workspace=dal --mode=refresh --stacks-only

# Everything — workspace + every repo
/context-refresh --all --workspace=dal --mode=refresh
```

---

## Instructions

### Step 1: Resolve scope + workspace

**Step 1.0 — resolve `{workspace_root}`**: run `node {plugin_dir}/scripts/workspace-root.js --get` to capture the user's configured workspaces root. Use `{workspace_root}` everywhere paths below reference workspace dirs. If the script exits non-zero (root never configured), tell the user to run `/discover` first — context-refresh has nothing to refresh against without an onboarded workspace.

**Step 1.1 — pick scope from args**:
- If first positional arg is present and not a flag → **single-repo scope**. Resolve repo-key-or-path the same way `/review` does. Auto-detect workspace from repo path if `--workspace` omitted.
- If `--workspace=<slug>` is present without a positional arg → **workspace scope**.
- If `--all` is present → **everything scope** (workspace + every repo in the config). `--workspace` required here (cannot be auto-detected without a repo).

**Step 1.2 — load + validate config**: load `{workspace_root}/{slug}/config.json` and validate via `node {plugin_dir}/scripts/validate-config.js {path}`. Halt on errors.

**Step 1.3 — flag conflict checks**: `--stacks-only` and `--skip-stacks` are mutually exclusive. Both apply only to workspace + all scopes — error if used with single-repo.

---

### Step 1.5: Decide fast-path vs full-audit per repo

This skill defaults to a **git-diff fast path** for single-repo and `--all` scopes: only the docs that touch files changed since the last refresh get re-verified. The full claim-verification audit (slow but complete) becomes the safety net.

**State file location**: `{workspace_root}/{slug}/runs/context-refresh/state.json`. Schema:

```json
{
  "abvi-publisher-service": {
    "head_sha": "4a9e8f2c…",
    "branch": "main",
    "ran_at": "2026-04-25T14:30:00Z",
    "mode": "fast",
    "fast_runs_since_full": 3
  }
}
```

**Decision tree per repo**:

| Condition | Path | Why |
|---|---|---|
| `--full` flag passed | full audit | explicit override |
| State file missing OR no entry for this repo | full audit, save state | first run on this repo |
| `git rev-parse --abbrev-ref HEAD` differs from `state.branch` | full audit, update state | branch switch makes prior sha meaningless |
| `git status --porcelain` shows >100 modified files | full audit | working tree too divergent for confident diff |
| `state.fast_runs_since_full >= 5` | full audit, reset counter | periodic safety net catches drift fast-path missed |
| `state.head_sha == HEAD` AND working tree clean | **skip — no changes** | nothing to refresh |
| Otherwise | fast path (Step 1.6) | the common case |

**`--since=<ref>`** overrides `state.head_sha` for the comparison point — used as-is, no state read.

---

### Step 1.6: Compute the file-changed scope (fast path only)

Run from `{repo.path}`:

```bash
git diff <comparison_sha>..HEAD --name-only
git status --short --untracked-files=no | awk '{print $2}'
```

Where `<comparison_sha>` is `state.head_sha` (or the value from `--since=<ref>` resolved via `git rev-parse <ref>`). Concatenate both lists, dedupe.

**Bail-out check**: if the combined list has more than 200 entries, switch this repo to full audit (faster than per-file analysis at that scale).

**Classify each changed file** to derive a per-doc impact list — pass this to `context-manager` as the `files_changed` input in `refresh` mode:

| File pattern | Likely doc impact |
|---|---|
| `src/.../controller/*` / `views.py` / `routes/*.ts` / `pages/*.tsx` | `agent-context/api-conventions.md` (backend) or AGENT_INDEX.md feature catalogue (frontend) |
| New top-level directory under `src/` | `agent-context/architecture.md` |
| `db/changelog/*` / `migrations/*` | `agent-context/architecture.md` data-model section |
| Files importing `software.amazon.awssdk.*` / `boto3` / `@aws-sdk/*` | `agent-context/common/AWS_INTEGRATION.md` (create if missing and the AWS-multi-resource trigger now applies) |
| Test files | `agent-context/common/TESTING.md` |
| Frontend components / pages | AGENT_INDEX.md feature catalogue + possibly DESIGN_SYSTEM.md |
| `package.json` / `pom.xml` / `pyproject.toml` | platform.md (workspace scope) — flag for next workspace refresh |
| Deleted files | every doc that referenced them — full grep across `agent-context/` |

The agent does the actual mapping by reading the changed files; the table above is a hint set, not a hard contract.

**No state file or `--full` selected** → skip Step 1.6 entirely; fall through to full audit in Step 2/3.

---

### Step 2: Workspace-level refresh (when scope = workspace or all)

Checks and updates these files (subject to `--stacks-only` / `--skip-stacks`):

- `{workspace_root}/{slug}/context/platform.md` — architecture, entities, integration patterns, per-service divergences. Must stay in sync with repo reality.
- `{workspace_root}/{slug}/context/stacks/{type}.md` — one per distinct `repos.*.type` in the config. Engineering-conventions docs with §-anchored sections.
- `{workspace_root}/{slug}/context/audit-findings.md` — from onboarding / prior refreshes. Not auto-refreshed; just checked for orphan references.

**Do NOT auto-refresh** `{workspace_root}/{slug}/context/learn-log.md` — that's an append-only learning record owned by `/pipecrew:learn`.

#### Step 2a: Audit pass (always runs, regardless of mode)

For each workspace-level doc above, run concern-specific checks:

**`platform.md`**:
- Entities & Ownership table — does each row's "Owning Service" actually exist in the current config?
- Service Map — does each row's spec path still exist on disk?
- Per-Service Divergences (the subsection produced by Phase B2.5) — are the cited versions / libraries / config formats still accurate per repo `pom.xml` / `package.json` / `application.*` / `pyproject.toml`?
- Known Constraints — any entries explicitly dated > 90 days old?

**`stacks/{type}.md`** (for each existing file):
- Verify every section's "Reference files" still exist at the cited paths.
- Verify "Detected pattern" still matches what the code shows — if `stacks/spring-boot.md §2` says `Specification<>` but no service in the workspace uses `Specification<>` anymore (all migrated to `@Query`), the doc is stale.
- Check for stack types that exist in the config but have NO `stacks/{type}.md` yet — these are missing docs, propose bootstrap via Phase B2.5.
- Check for orphaned `stacks/*.md` files where no repo of that type exists in the config — these are stale, propose deletion or archive.

**`design_system_path` config field drift** (every frontend repo in the config):
- If `config.repos[repo-name].design_system_path` is set, verify the file exists at `{repo.path}/{design_system_path}`. Missing file → flag as `design-system path drift` with the suggested fix (move the file, update the config, or run `/discover --resume` to re-bootstrap).
- If the field is absent on a frontend repo, probe the canonical path `{repo.path}/agent-context/common/DESIGN_SYSTEM.md`. If found, flag as `design-system path not explicit — run /discover --resume to persist the path to config`. If not found, flag as `design-system missing — run /discover --resume to bootstrap (Phase B3)`.

Emit a staleness report grouped by file with specific findings:

```
## Workspace audit — {slug}

### platform.md
- ⚠ "Entities & Ownership" row for `BulkUploadRequest` cites `publisher-service` but the entity no longer exists in code (was removed in commit 4a9e8f)
- ✓ All other entity mappings verified

### stacks/spring-boot.md
- ✓ §1 Auth pattern (SecurityConfig + @PreAuthorize) matches code
- ⚠ §2 Persistence references `src/main/java/.../ContractReviewService.java` which was deleted in PR #29 — update reference
- ⚠ §4 Migrations says "Liquibase, YAML changesets" but 3/5 services have migrated to Flyway (publisher-service, backoffice-service retain Liquibase)

### stacks/react.md
- ✓ All §-sections current

### Frontend design-system paths
- ✓ abvi-pms-frontend: `agent-context/common/DESIGN_SYSTEM.md` exists, config field set
- ⚠ admin-portal: config.design_system_path missing — run `/discover --resume` to persist
```

If `--mode=audit`, stop here and present the report. Done.

#### Step 2b: Refresh pass (if `--mode=refresh`)

For each finding in the audit, dispatch a scanning agent per affected file. Use the same shape as `/discover` Phase B2.5's bootstrap agent, but in **refresh semantics — never overwrite hand-curated content; only update stale sections**.

**Tool**: `Agent`
**subagent_type**: `general-purpose`
**description**: `"Refresh stacks/{type}.md — {slug}"` (or `"Refresh platform.md — {slug}"`)

**Prompt** (for a `stacks/{type}.md` refresh):

```
You are refreshing the workspace's {type} engineering-conventions document at
{workspace_root}/{slug}/context/stacks/{type}.md.

The PipeCrew template (for reference only — do not overwrite file structure) is at:
  {plugin_dir}/templates/stacks/{type}.md.template

Current file: {workspace_root}/{slug}/context/stacks/{type}.md

Repos of type `{type}` in this workspace:
  {for each repo in config where repo.type == this.type:}
  - {repo.name} at {repo.path}

## Staleness findings from the audit

{paste the finding entries for this file verbatim}

## Your job

For each finding, update the specific §-section named, based on what the current code actually shows:

1. Read the current file — note which sections exist and their current content.
2. For each stale section: re-scan the relevant repo code (grep, read), determine the current convention, and update the §-section in place.
3. **Never delete or rewrite sections that are not stale** — the audit lists what to update; leave the rest alone. Hand-curated text in a non-stale section stays verbatim.
4. Update the `Last Updated` date at the top of the file.
5. If the audit identified a "reference file that no longer exists", replace it with the nearest still-existing file that exemplifies the pattern — don't leave a broken reference.
6. If a §-section's detected pattern fundamentally changed across all repos (e.g., everyone migrated to Flyway from Liquibase), rewrite the pattern section. If only SOME repos changed, keep the dominant pattern and add a divergence note pointing at `platform.md § Per-Service Divergences`.

Output: write the updated file using the Edit tool — surgical edits, not whole-file rewrites. Report which sections you updated.
```

Run in parallel if multiple files are being refreshed.

After agents return, verify:
- Every affected file still parses as markdown.
- No section numbering changed (§-anchors are stable and cited by downstream agents).
- `Last Updated` bumped on every touched file.
- No `{{placeholders}}` introduced (only a fresh bootstrap should contain those; a refresh should not).

---

### Step 3: Single-repo refresh (when scope = repo)

**Fast-path notice**: if Step 1.5 selected the fast path for this repo, you have a `files_changed` list from Step 1.6. Pass it to the agent. Otherwise, the agent does a full audit.

Verify `{repo_path}/agent-context/` exists. If not:

- `audit` mode: report "No agent-context directory found. Run `/discover` first or generate with `/context-refresh --mode=refresh`."
- `refresh` mode: ask "No agent-context exists. Generate from scratch? (yes / no)". If yes, dispatch context-manager in `full` mode (writes agent-context AND rewrites CLAUDE.md as an index). If the repo is claude-only by design, keep it that way and stop.

**Frontend repos — additional check**:

- Verify `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` exists.
- If present: audit its §-anchor structure against `{plugin_dir}/templates/DESIGN_SYSTEM.md.template`. Stale sections / missing required anchors / reference files that no longer exist → findings.
- If missing: propose bootstrap via `/discover --resume` Phase B3 (not auto-fixed by context-refresh — B3 is the canonical bootstrap path).

Dispatch the `context-manager` agent for the repo's agent-context + CLAUDE.md, plus — for frontend — an additional pass that refreshes DESIGN_SYSTEM.md against current feature code:

**Tool**: `Agent`
**subagent_type**: `context-manager`
**description**: `"Context {mode} — {repo-name}"`

**Prompt**:

```
Mode: {mode}
Repo: {repo_path}
Repo type: {type}
Repo role: {role}
{if fast_path:}
Scope: fast (delta from {comparison_sha} since {state.ran_at})
Files changed:
  {newline-separated list from Step 1.6}
Doc-impact hints (advisory):
  {pre-classified hint list from Step 1.6 mapping table}

Constrain your scan to these files and the docs they could plausibly affect.
You may follow imports/refs out from these files when needed, but do NOT
re-verify the entire codebase — that's the periodic full audit's job.
{else:}
Scope: full (no prior state OR --full was passed OR branch changed)

{if mode == "audit":}
Read the agent-context docs at {repo_path}/agent-context/.
Scan the codebase for stale references, missing coverage, and contradictions.
{if role == "frontend":}
Additionally audit {repo_path}/agent-context/common/DESIGN_SYSTEM.md against the PipeCrew template at {plugin_dir}/templates/DESIGN_SYSTEM.md.template:
- Required §-anchors present?
- Reference files for each §-subsection still exist?
- Known Inconsistencies: any entries that should be removed because the inconsistency was fixed?
Produce the staleness report. Do NOT modify any files.

{if mode == "refresh":}
Read the agent-context docs at {repo_path}/agent-context/.
Compare against current code reality. Update any stale references.
Add coverage for new modules, endpoints, or features that aren't documented.

If any agent-context/common/ topic files were added or removed, update CLAUDE.md's `## Deep context` table to match (this is the only routine touch CLAUDE.md gets — see implementer-common-rules.md Rule 5), then run:
  node {plugin_dir}/scripts/validate-claude-md.js {repo_path}/CLAUDE.md
Fix any validator errors before finishing. Do not touch CLAUDE.md's stable sections.

{if role == "frontend":}
Additionally refresh {repo_path}/agent-context/common/DESIGN_SYSTEM.md:
- For each §-subsection, verify reference files still exist; if not, replace with the nearest still-existing exemplar.
- If Known Inconsistencies lists an entry that the current code no longer exhibits, remove the row.
- If a new anti-pattern is visible in the code that the doc doesn't list, add a row.
- Leave hand-curated sections (canonical code blocks, DON'T examples) untouched unless they reference code that no longer exists.

Report what you changed.
```

---

### Step 4: `--all` scope

Workflow:

1. Run the **workspace-level** pass (Step 2) first — it's the broader context, and per-repo refreshes may reference what's in `stacks/{type}.md`.
2. Then run the **single-repo** pass (Step 3) for every repo in the config, in parallel (batched if many — say 5 at a time). Each repo independently consults Step 1.5 — some may take the fast path while others go full.
3. Consolidate all reports into a single summary.

---

### Step 4.5: Update state file (after `--mode=refresh` succeeds)

After every successful refresh on a per-repo basis, write back to `{workspace_root}/{slug}/runs/context-refresh/state.json`:

```json
{
  "<repo-key>": {
    "head_sha": "<git rev-parse HEAD output>",
    "branch": "<git rev-parse --abbrev-ref HEAD output>",
    "ran_at": "<ISO 8601 UTC>",
    "mode": "fast" | "full",
    "fast_runs_since_full": <number — 0 after a full run; +1 after each fast run>
  }
}
```

Rules:
- Update only the entry for the repo(s) that were just refreshed. Other entries stay untouched.
- If `mode` was full → reset `fast_runs_since_full` to 0.
- If `mode` was fast → increment `fast_runs_since_full`.
- If a refresh failed for a repo → do NOT update its entry (preserves the old comparison point so the next run retries the same delta).
- For `--mode=audit`, do NOT write state. Audits are read-only operations.

This file is part of the workspace's run history. It's created on first refresh and grows as new repos are touched. It's small (one entry per repo, ~150 bytes each) and human-editable — if a user wants to force a full audit on next run, they delete the relevant entry.

---

### Step 5: Present results + one-line status

Emit the standard one-line phase-done status per scope. Include fast/full path counts so users can see when the safety net (full audit) ran:

```
# Audit mode
[context-refresh ✔] workspace: 4 findings, repos: 12 findings across 7 repos (audit only, no changes)

# Refresh mode (mostly fast path)
[context-refresh ✔] workspace: 3 files updated, repos: 5 files updated across 4 repos
  Path: 3 fast, 1 full (publisher-service — periodic safety net; reset counter)
  Tokens: 24k, duration 3:42

# Refresh mode (no changes since last refresh)
[context-refresh ✔] No code changes detected since last refresh — skipped 4 repos.
  Last refresh: 2026-04-25T14:30:00Z. Use --full to re-verify anyway.

# Partial — some refreshes failed
[context-refresh ✔⚠] workspace: 2 updated, 1 deferred; repos: 4 updated, 1 deferred (backoffice-service agent failed after retry)
  Deferred: stacks/nestjs.md (529 after retry), abvi-backoffice-service (agent non-response) — re-run /context-refresh --resume --workspace={slug}
```

For `--mode=audit`: print the full staleness report grouped by file, no modifications.

For `--mode=refresh`: print a concise summary — files modified, sections touched, `Last Updated` bumped. Offer to diff before/after if the user wants.

---

## Interruption handling

- If a scanner agent fails on a single file, record it in the report, continue with the others.
- `--all` with many files: dispatch in batches (~5) to avoid token-flood; sequential batches, parallel within.
- Always emit observability events (`run_start`, `phase_start/end`, `agent_end`) per `{plugin_dir}/docs/observability.md`. Run directory: `{workspace_root}/{slug}/runs/context-refresh/{run_id}/`.

---

## Do NOT touch

These files are owned by other skills and have their own refresh/update paths:

| File | Owned by | Refresh path |
|---|---|---|
| `{workspace_root}/{slug}/config.json` | `/discover` | `/discover --resume` |
| `{workspace_root}/{slug}/agents/*.md` | `/discover` Phase C | `/discover --resume` + manual edit |
| `{workspace_root}/{slug}/context/learn-log.md` | `/pipecrew:learn` | Append-only; no refresh |
| `{workspace_root}/{slug}/context/audit-findings.md` | `/discover` Phase C | `/discover --resume` |
| `{workspace_root}/{slug}/runs/context-refresh/state.json` | this skill (Step 4.5) | Auto-managed; delete an entry to force full audit on next run for that repo |
| Repo `package.json` / `pom.xml` / `pyproject.toml` | Repo owner | Manual |

If the audit reveals that any of these are stale, surface it as a finding with a pointer to the correct refresh path — but do not auto-update.
