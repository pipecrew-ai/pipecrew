---
name: context-refresh
description: "Audit or refresh PipeCrew context docs at three scopes: a single repo (its agent-context/, CLAUDE.md, and DESIGN_SYSTEM.md if frontend), the workspace (platform.md), or everything (workspace + every repo). Audit mode reports staleness only; refresh mode updates docs to match current code."
---

## Usage

```
/context-refresh <repo-key-or-path> [--mode=audit|refresh] [--workspace=<slug>]
/context-refresh --workspace=<slug> [--mode=audit|refresh]
/context-refresh --all [--workspace=<slug>] [--mode=audit|refresh]
```

### Scopes (pick one)

| Scope | Selector | What's audited / refreshed |
|---|---|---|
| Single repo | `<repo-key-or-path>` | That repo's `agent-context/`, `CLAUDE.md`, and the design system file (if frontend — `agent-context/design-system.md` for new bundle, `agent-context/common/DESIGN_SYSTEM.md` for legacy) |
| Workspace | `--workspace=<slug>` | `{workspace_root}/{slug}/context/platform.md` |
| Everything | `--all` | Workspace scope + every repo in the config |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `audit` | `audit` = report only. `refresh` = apply updates. |
| `--workspace` | auto-detect | Workspace slug. Auto-detected for single-repo when omitted; required for `--workspace` and `--all`. |
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
/context-refresh --workspace=dal --mode=refresh

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

**Step 1.3 — flag check**: no scope-narrowing flags exist for the workspace pass — it always refreshes platform.md.

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

**Classify each changed file** to derive a per-doc impact list — pass this to `context-manager` as the `files_changed` input in `refresh` mode. The mapping depends on whether the repo uses the legacy template (single `agent-context/common/` subdir) or one of the new role-specific bundles (backend / frontend, with `domains/` / `features/` / `integrations/` / `api-clients/` plural folders). The agent should read what's present on disk and choose the matching column.

| File pattern | Backend (new bundle) doc impact | Frontend (new bundle) doc impact | Legacy doc impact |
|---|---|---|---|
| `src/.../controller/*` / `views.py` / `routes/*.ts` | `agent-context/api-conventions.md` (Endpoint Catalog row) | n/a | `agent-context/api-conventions.md` |
| `pages/*.tsx` / `app/*/page.tsx` | n/a | `agent-context/features/{feature}.md` (Pages table) + AGENT_INDEX feature catalogue | AGENT_INDEX feature catalogue |
| New top-level directory under `src/` | `agent-context/architecture.md` | `agent-context/architecture.md` + new `agent-context/features/{feature}.md` if it's a feature module | `agent-context/architecture.md` |
| `db/changelog/*` / `migrations/*` | `agent-context/database.md` (Schema + Migrations sections) | n/a | `agent-context/architecture.md` data-model section |
| Files importing `software.amazon.awssdk.*` / `boto3` / `@aws-sdk/*` | `agent-context/integrations/aws.md` (create from `_template.md` if missing and the AWS-multi-resource trigger applies) | n/a | `agent-context/common/AWS_INTEGRATION.md` |
| New external integration (Kafka, Stripe, Datadog, etc.) | `agent-context/integrations/{name}.md` (create from `_template.md`) | n/a (frontend integrations are typically API consumers) | n/a |
| New Spring/Django/etc. service introducing a new bounded context | `agent-context/domains/{name}.md` (create from `_template.md`) + row in `business-context.md` | n/a | per-feature doc under `agent-context/features/` |
| `src/api/services/*` / `src/api/clients/*` (frontend) | n/a | `agent-context/api-clients/{service}.md` (Endpoints Used table) | `agent-context/services/{SERVICE}_API.md` |
| `src/features/*` (frontend) | n/a | `agent-context/features/{feature}.md` | per-feature doc under `agent-context/features/` |
| Component / token changes (frontend) | n/a | `agent-context/ui-components.md` and/or `agent-context/design-system.md` | `agent-context/common/UI_COMPONENTS.md` / `DESIGN_SYSTEM.md` |
| Locale file changes (frontend i18n) | n/a | `agent-context/features/{feature}.md` (Translation Keys table) | `agent-context/common/I18N.md` |
| New exception class | `agent-context/error-handling.md` (Exception Mapping Table) | `agent-context/error-handling.md` (API Error Types) | same paths |
| Test files | `agent-context/testing.md` | `agent-context/testing.md` | `agent-context/common/TESTING.md` |
| `package.json` / `pom.xml` / `pyproject.toml` | platform.md (workspace scope) — flag for next workspace refresh | platform.md (workspace scope) | platform.md |
| Deleted files | every doc that referenced them — full grep across `agent-context/` | same | same |

The agent does the actual mapping by reading the changed files; the table above is a hint set, not a hard contract. **HARD RULE**: a refresh that would touch a `<!-- human-owned -->` section must surface the change as a finding (with file:line evidence and proposed wording) — the agent does not edit human-owned sections. Only `<!-- agent-updatable -->` sections are edited automatically.

**No state file or `--full` selected** → skip Step 1.6 entirely; fall through to full audit in Step 2/3.

---

### Step 2: Workspace-level refresh (when scope = workspace or all)

Checks and updates these files:

- `{workspace_root}/{slug}/context/platform.md` — architecture, entities, integration patterns, established workspace-wide patterns. Must stay in sync with repo reality.
- `{workspace_root}/{slug}/context/audit-findings.md` — from onboarding / prior refreshes. Not auto-refreshed; just checked for orphan references.

**Do NOT auto-refresh** `{workspace_root}/{slug}/context/learn-log.md` — that's an append-only learning record owned by `/pipecrew:learn`.

#### Step 2a: Audit pass (always runs, regardless of mode)

Run concern-specific checks against `platform.md`:

- **Entities & Ownership table** — does each row's "Owning Service" actually exist in the current config?
- **Service Map** — does each row's spec path still exist on disk?
- **Established Patterns** — are the cited versions / libraries / config formats still accurate per repo `pom.xml` / `package.json` / `application.*` / `pyproject.toml`? (Cross-cutting workspace patterns live here, not in a separate per-stack doc.)
- **Known Constraints** — any entries explicitly dated > 90 days old?

**`design_system_path` config field drift** (every frontend repo in the config):
- If `config.repos[repo-name].design_system_path` is set, verify the file exists at `{repo.path}/{design_system_path}`. Missing file → flag as `design-system path drift` with the suggested fix (move the file, update the config, or run `/discover --resume` to re-bootstrap).
- If the field is absent on a frontend repo, probe the canonical path `{repo.path}/agent-context/common/DESIGN_SYSTEM.md`. If found, flag as `design-system path not explicit — run /discover --resume to persist the path to config`. If not found, flag as `design-system missing — run /discover --resume to bootstrap (Phase B3)`.

Emit a staleness report:

```
## Workspace audit — {slug}

### platform.md
- ⚠ "Entities & Ownership" row for `BulkUploadRequest` cites `publisher-service` but the entity no longer exists in code (was removed in commit 4a9e8f)
- ⚠ "Established Patterns" still says "Liquibase YAML changesets" but 3/5 services migrated to Flyway
- ✓ Service Map current

### Frontend design-system paths
- ✓ abvi-pms-frontend: `agent-context/common/DESIGN_SYSTEM.md` exists, config field set
- ⚠ admin-portal: config.design_system_path missing — run `/discover --resume` to persist
```

If `--mode=audit`, stop here and present the report. Done.

#### Step 2b: Refresh pass (if `--mode=refresh`)

Dispatch a scanning agent for `platform.md` in **refresh semantics — never overwrite hand-curated content; only update stale sections**.

**Tool**: `Agent`
**subagent_type**: `general-purpose`
**description**: `"Refresh platform.md — {slug}"`

**Prompt**:

```
You are refreshing the workspace's platform context document at
{workspace_root}/{slug}/context/platform.md.

## Staleness findings from the audit

{paste the finding entries verbatim}

## Your job

For each finding, update the specific section named, based on what the current code actually shows:

1. Read the current file — note which sections exist and their current content.
2. For each stale section: re-scan the relevant repos (grep, read configs, parse package manifests), determine the current state, and update the section in place.
3. **Never delete or rewrite sections that are not stale** — the audit lists what to update; leave the rest alone. Hand-curated text in a non-stale section stays verbatim.
4. Update the `Last Updated` date at the top of the file.
5. If the audit identified a "reference file that no longer exists" (e.g., in the Service Map), replace it with the nearest still-existing analog — don't leave a broken reference.

Output: write the updated file using the Edit tool — surgical edits, not whole-file rewrites. Report which sections you updated.
```

After the agent returns, verify:
- platform.md still parses as markdown.
- `Last Updated` bumped.
- No `{{placeholders}}` introduced.

---

### Step 3: Single-repo refresh (when scope = repo)

**Fast-path notice**: if Step 1.5 selected the fast path for this repo, you have a `files_changed` list from Step 1.6. Pass it to the agent. Otherwise, the agent does a full audit.

Verify `{repo_path}/agent-context/` exists. If not:

- `audit` mode: report "No agent-context directory found. Run `/discover` first or generate with `/context-refresh --mode=refresh`."
- `refresh` mode: ask "No agent-context exists. Generate from scratch? (yes / no)". If yes, dispatch context-manager in `full` mode (writes agent-context AND rewrites CLAUDE.md as an index). If the repo is claude-only by design, keep it that way and stop.

**Frontend repos — additional check**:

Design system can live at one of two paths depending on which template
generated this repo:
- **New bundle**: `{repo_path}/agent-context/design-system.md` (top-level)
- **Legacy**: `{repo_path}/agent-context/common/DESIGN_SYSTEM.md`

Probe both, in that order, and use whichever is present.

- If present: audit its §-anchor structure against `{plugin_dir}/templates/agent-context-frontend/design-system.md.template` (new) or `{plugin_dir}/templates/DESIGN_SYSTEM.md.template` (legacy fallback). Stale sections / missing required anchors / reference files that no longer exist → findings.
- If missing on BOTH paths: propose bootstrap via `/discover --resume` Phase B3 (not auto-fixed by context-refresh — B3 is the canonical bootstrap path).

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
Additionally audit the repo's design system file. Probe in this order and use the first one that exists:
  1. {repo_path}/agent-context/design-system.md (new frontend bundle)
  2. {repo_path}/agent-context/common/DESIGN_SYSTEM.md (legacy)

Audit it against the matching PipeCrew template:
  - For path #1: {plugin_dir}/templates/agent-context-frontend/design-system.md.template
  - For path #2: {plugin_dir}/templates/DESIGN_SYSTEM.md.template (legacy)

Checks:
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
Additionally refresh the design system file at whichever of these exists:
  1. {repo_path}/agent-context/design-system.md (new frontend bundle)
  2. {repo_path}/agent-context/common/DESIGN_SYSTEM.md (legacy)

For the chosen file:
- For each §-subsection, verify reference files still exist; if not, replace with the nearest still-existing exemplar.
- The Known Inconsistencies table is `<!-- agent-updatable -->` (in the new template) — if an entry that the current code no longer exhibits, remove the row; if a new inconsistency is visible, add a row.
- All other sections are `<!-- human-owned -->` (in the new template) — leave them untouched. If you observe drift, surface it as a finding instead of editing.

Report what you changed.
```

---

### Step 4: `--all` scope

Workflow:

1. Run the **workspace-level** pass (Step 2) first — it's the broader context, and per-repo refreshes may reference what's in `platform.md § Established Patterns`.
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
  Deferred: abvi-backoffice-service (agent non-response after retry) — re-run /context-refresh --resume --workspace={slug}
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
