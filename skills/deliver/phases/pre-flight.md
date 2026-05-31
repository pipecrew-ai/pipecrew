### Scratchpad Template

The scratchpad lives at `{run_dir}/scratchpad.md` where `{run_dir}` = `{workspace_root}/{slug}/runs/deliver/{run_id}/`. Per-run isolation — each feature gets its own directory so two features can run in parallel on the same workspace without token accounting bleeding.

`{run_id}` format: `{YYYY-MM-DD-HHMMSS}-{feature-slug}` (see `{plugin_dir}/rules/observability.md`). The timestamp provides uniqueness; the feature slug provides readability. On same-second collision, append `-2`, `-3`, …

#### Directory Structure
```
{workspace_root}/{slug}/runs/deliver/
└── {run_id}/                          <- THIS run's {run_dir}
    ├── scratchpad.md                  <- lean phase index
    ├── checkpoints.jsonl              <- unified event log (see observability.md)
    ├── outputs/
    │   ├── phase-1-requirements.md
    │   ├── phase-2-architecture.md
    │   ├── phase-3-diffs.md
    │   ├── phase-5-5-code-review.md
    │   └── phase-7-execution-report.md
    ├── tasks/                         <- implementation tasks + review findings
    │   └── *.md
    ├── review/                        <- per-repo code-review reports (Phase 5.5)
    ├── security-review.md             <- optional (--force-security-review)
    ├── assessment.md                  <- Phase 6 output
    ├── fix-rounds/                    <- optional (per fix-round artifacts)
    └── report.md                      <- Phase 7 final report (from reporter)
```

`{run_id}` is the enduring identity of a feature run — used in checkpoints, surfaced in the reporter, and what `--resume` targets. Archival is implicit: old run dirs sort by name (chronological), so listing `runs/deliver/` gives history for free. No separate `active/`, `completed/`, or `history/` subdirs.

#### scratchpad.md Template

```markdown
# Run Scratchpad

## Run Info
- **Skill**: deliver
- **Run ID**: {run_id}
- **Feature**: {feature description}
- **Workspace**: {workspace.name} ({slug})
- **Flags**: {flags used}
- **Started**: {date}
- **Current Phase**: {phase name}
- **Status**: IN_PROGRESS | INTERRUPTED | COMPLETED | FAILED

---

## Phase Status

| Phase | Status | Duration | Tokens | Output File |
|-------|--------|----------|--------|-------------|
| 1. Requirements | PENDING/COMPLETED/SKIPPED | — | — | outputs/phase-1-requirements.md |
| 2. Architecture | PENDING/COMPLETED/SKIPPED | — | — | outputs/phase-2-architecture.md |
| 3. Spec Edit | PENDING/COMPLETED/SKIPPED | — | — | outputs/phase-3-diffs.md |
| 4. Spec Sync | PENDING/COMPLETED/SKIPPED | — | — | — |
| 5. Implementation | PENDING/COMPLETED/SKIPPED | — | — | — |
| 5.5. Code Review | PENDING/COMPLETED/SKIPPED | — | — | outputs/phase-5-5-code-review.md |
| 6. Assessment | PENDING/COMPLETED/SKIPPED | — | — | — |
| 7. Summary | PENDING/COMPLETED | — | — | outputs/phase-7-execution-report.md |

## Architecture Flags
- **Affected Services**: {list}
- **Auto-detected phases**: {from rule #2}
- **Skipped phases**: {list with reasons}
- **Frontend Required**: Yes/No
- **Mock Required**: Yes/No
- **Infra Required**: Yes/No

---

## Implementation Tasks

| # | Task ID | Repo | Agent | Status | Duration | Tokens | Worktree | Files Changed |
|---|---------|------|-------|--------|----------|--------|----------|---------------|

---

## Agent Dispatch Log

| # | Phase | Agent | Task ID | Duration | Tokens | Outcome |
|---|-------|-------|---------|----------|--------|---------|

---

## Context Budget
- Avg task file: ~{N} tokens | Max: ~{N} tokens
- Total tasks: {N}
- Per-dispatch input estimate: ~{N} tokens

## Resume Instructions
To resume: `/deliver --resume --workspace={slug}`
```

---

### Resume Flow (`--resume`)

When `--resume` is passed:

1. Read the workspace config at `{workspace_root}/{workspace}/config.json`
2. List `{workspace_pipeline_dir}/active/` — get all in-flight pipeline slugs
3. If none → "No active pipeline found. Start a new one with `/deliver <description>`"
4. If exactly one → use it
5. If multiple AND `--feature=<slug>` passed → use that slug
6. If multiple AND no `--feature` → list them and ask user:
   ```
   Multiple pipelines in-flight:
     1. book-upload-a1f2 — Phase 5a — started 2h ago
     2. contract-types-c3d4 — Phase 2 — started 12m ago
   Which to resume? (1/2)
   ```
7. Read `{pipeline_dir}/scratchpad.md` (where `{pipeline_dir}` = `active/{chosen-slug}/`)
8. Parse the lean index to determine:
   - Which phases are COMPLETED (skip them)
   - What the current phase is (resume from here)
   - Implementation task statuses (which parallel tasks are done)
   - Do NOT read output files yet — load them lazily when needed for the current phase
9. Present a summary to the user:
   ```
   Resuming pipeline: {feature name}
   Workspace: {workspace.name} ({workspace.slug})
   Feature slug: {slug}

   Completed phases: {list}
   Resuming from: {current phase}

   Implementation tasks:
   - [x] Backend: {service} — 3 endpoints (COMPLETED)
   - [ ] Frontend — UX + implement (IN_PROGRESS — will restart)
   - [x] Mock — 3 endpoints (COMPLETED)

   Continue?
   ```
10. **IN_PROGRESS tasks** restart from the beginning — implementers are idempotent (read existing code before writing).
11. On approval, continue.

---

### Pre-flight: Validate Repos + Create Scratchpad

**Step 0: Resolve the workspace root directory.**

Workspaces live under `{workspace_root}/<slug>/`. The root is resolved by `node {plugin_dir}/scripts/workspace-root.js` with this precedence: `$PIPECREW_WORKSPACE_ROOT` env var → `~/.claude/pipecrew/config.json` → default `~/.claude/pipecrew/workspaces/`.

1. Run `node {plugin_dir}/scripts/workspace-root.js --check`. Exit 0 = already configured (or env var set), skip to step 3. Exit 2 = never configured — prompt the user once:

   ```
   Where should PipeCrew store workspaces?
   Default: ~/.claude/pipecrew/workspaces
   (Press Enter to accept the default, or paste an absolute/~-prefixed path.)
   ```

2. Save the answer (or the default if the user pressed Enter) with `node {plugin_dir}/scripts/workspace-root.js --set="<path>"`. This writes `~/.claude/pipecrew/config.json` so future runs don't re-prompt.

3. Capture the resolved path: `{workspace_root} = $(node {plugin_dir}/scripts/workspace-root.js --get)`. Use this alias everywhere in the remaining steps — wherever a phase file shows the literal `~/.claude/pipecrew/workspaces/`, substitute `{workspace_root}/`.

**Step 1: Load and validate workspace config.**

Read `{workspace_root}/{workspace}/config.json`. Run the validator:

```bash
node {plugin_dir}/scripts/validate-config.js {workspace_root}/{workspace}/config.json
```

If validation fails (exit code 1), print the errors and stop. If warnings exist, print them and continue.

Extract key references from the config into short aliases used throughout the rest of the pipeline:
- `{runs_dir}` = `{workspace_root}/{slug}/runs/deliver/` — base for all feature runs (replaces the old `config.workspace.pipeline_dir`)
- `{run_dir}` = `{runs_dir}/{run_id}/` — this specific run (computed once in Step 2)
- `{repos.*}` = `config.repos` — iterate for path validation
- `{services.*}` = `config.services` — iterate for service→repo→spec lookups
- `{domain}` = `config.domain` — passed to the product-owner and architect

**Step 1.5: Verify discovery artifacts — hard stop if platform.md missing.**

Phase 2 (Architecture) dispatches the solution-architect with `{workspace_root}/{slug}/context/platform.md` as a required input. Check for its existence BEFORE running any phase — a missing `platform.md` produces an ugly Phase 2 failure otherwise.

```bash
test -f {workspace_root}/{slug}/context/platform.md
```

If the file exists, continue. If missing, print the detailed "missing platform.md" block below and stop.

**Missing-platform.md stop message:**

```
✗ Workspace missing context/platform.md — cannot run /deliver.

/deliver Phase 2 (Architecture) requires platform.md to ground the
architect's design. Without it, the architect has no model of your
domain, services, entities, or integration patterns — design-mode
output would be generic and unusable.

The file is generated by /discover Phase B2 when it dispatches the
solution-architect in discovery mode to read your codebase.

Recommended: run /discover (or resume it if onboarding was partial)

  /discover --resume --workspace={slug}

This will pick up from wherever /discover left off. If Phase B2 was
already completed, the file may have been hand-deleted or moved — check
{workspace_root}/{slug}/context/ for any .md files and restore it, then
re-run /deliver.

Alternative (not recommended): hand-write a minimal platform.md with at
least these sections filled:
  ## Domain
  ## Service Map (table: Service | Repo | Type | Spec | Description)
  ## Integration Patterns
  ## Entities & Ownership

Quality caveat: a hand-written platform.md captures only what you
remember, not what /discover's architect synthesizes from actual code.
Expect the architect in Phase 2 to miss cross-service coupling, implicit
contracts, and tech-stack divergences. For production features, running
/discover is cheaper long-term than repeated /deliver fix rounds.
```

**Step 1.6: Warn on missing soft artifacts (do not stop).**

Check and warn — each one degrades quality in a specific way, but none blocks the run:

| Artifact | Check | Warning if missing |
|---|---|---|
| Repo CLAUDE.md (one per repo in `config.repos`) | `test -f {repo.path}/CLAUDE.md` | "⚠ {repo} missing CLAUDE.md — Phase 5 implementer will re-derive conventions from code (3-5× more tokens per dispatch). Run `/discover --resume --workspace={slug}` to generate it." |
| Workspace product-owner agent | `test -f ~/.claude/agents/{slug}-product-owner.md` | "⚠ Workspace product-owner agent not published — Phase 1 will fall back to `general-purpose` with a preamble. Quality degrades. Run `/discover --resume --workspace={slug}` to publish." |
| Workspace assessor agent | `test -f ~/.claude/agents/{slug}-assessor.md` | "⚠ Workspace assessor agent not published — Phase 6 will fall back to `general-purpose`. Run `/discover --resume --workspace={slug}` to publish." |
| `context/audit-findings.md` | `test -f {workspace_root}/{slug}/context/audit-findings.md` | "ℹ audit-findings.md not present — Phase 4.5 `## Known Pitfalls` will use plugin stack catalog only. If this workspace was onboarded before audit findings existed, run `/discover --resume` to generate." |

Print all warnings at once as a grouped block so the user sees the full health check, then continue:

```
Pre-flight health check:
  ✓ config.json
  ✓ context/platform.md
  ⚠ abvi-publisher-service/CLAUDE.md — missing (implementer will re-derive conventions)
  ⚠ Workspace product-owner agent — not published (fallback: general-purpose)
  ℹ context/audit-findings.md — not present

{N} soft warnings. /deliver will proceed with degraded quality on those points.
Run `/discover --resume --workspace={slug}` to fix at any time.
```

Only stop if a HARD artifact (config.json, platform.md) is missing. Soft artifacts produce warnings and proceed.

**Step 1.7: Check for deferred follow-up items.**

Phase 4.5 may have written deferred sub-tasks to `{workspace_root}/{slug}/deferred/<feature-slug>.md` if a previous run's user picked "Minimum only" at the plan gate (see `phases/phase-4-plan.md` — section "When user picks 'Minimum only'"). This step decides whether to load one of those deferred files as the feature input for THIS run.

Scan: `ls {workspace_root}/{slug}/deferred/*.md 2>/dev/null` and parse each file's frontmatter for `status`. Pending files have `status: pending`; consumed files have `status: consumed` and are ignored here.

Branch on the CLI:

| Condition | Action |
|---|---|
| `--from-deferred=<feature-slug>` was passed with a value | **Direct resume.** Read `{workspace_root}/{slug}/deferred/<feature-slug>.md`. If the file is missing or has `status: consumed`, error and stop with the exact path that was checked. If `status: pending`, use the file's body as the feature input — substitute it for any `<feature description>` argument the user typed. Record `deferred_source_file: {path}` in the scratchpad Run Info so Phase 7 can mark it consumed. Log: `"Resuming deferred slice from {path} (source run: {source_run_id})."` |
| `--from-deferred` was passed without a value AND ≥1 pending file exists | **Interactive resume.** List the pending files (slug, source run age, deferred-task count), prompt: `"Pick one to resume (1..N) or `c` to cancel."` On a number: same as direct-resume above using that file. On `c`: stop the run. |
| `--from-deferred` was passed without a value AND zero pending files exist | Error and stop: `"--from-deferred passed but no pending deferred files in {workspace_root}/{slug}/deferred/."` |
| No `--from-deferred` flag AND ≥1 pending file exists | **Heads-up only — do NOT prompt.** Print `"ℹ {N} deferred follow-up items in {workspace_root}/{slug}/deferred/. Use \`/deliver --from-deferred=<feature-slug>\` to resume one."` Continue with the user's typed feature description. |
| No `--from-deferred` flag AND zero pending files | Silent. Continue. |

When a deferred file is loaded (either branch), the new `run_id` is still computed in Step 2 from the deferred file's `feature` field (not a new slug from the user's typed description, which may have been ignored). The new run is a fresh run dir; the source deferred file's `source_run_id` is just a back-reference, not the run identity.

**Step 2: Compute `run_id`.**

Derive a kebab-cased feature slug from the feature description: lowercase, replace any run of non-alphanumeric characters with a single `-`, strip leading/trailing dashes, truncate to 24 chars. Prepend the current UTC timestamp in `YYYY-MM-DD-HHMMSS` format:

```
run_id = "{YYYY-MM-DD-HHMMSS}-{feature-slug}"
```

If `{runs_dir}/{run_id}/` already exists (same-second collision), append `-2`, `-3`, … until unique.

On `--resume`, read the existing `run_id` from the scratchpad — do not generate a new one.

**Step 3: Detect other in-flight runs (parallel run safety).**

Scan `{runs_dir}/*/scratchpad.md` for files with `Status: IN_PROGRESS`. If any exist:
```
{N} run(s) already in-flight on this workspace:
  - 2026-04-15-091234-book-upload (Phase 5a, started 2h ago)
  - 2026-04-15-104502-contract-types (Phase 2, started 12m ago)

Starting a new run for: "{feature description}"
Continue? (yes / no)
```

Proceed on "yes" — multiple runs can execute simultaneously. Each has isolated state (own tasks, outputs, checkpoints) since `{run_dir}` is unique.

**Warn** (don't block) if any in-flight run touches the same service spec this feature will edit — explain merge conflicts may happen at branch merge time.

**Step 4: Create the per-run directory.**

1. `mkdir -p {run_dir}/outputs {run_dir}/tasks {run_dir}/review {run_dir}/fix-rounds`
2. Emit the first `run_start` event to `{run_dir}/checkpoints.jsonl` with `skill: "deliver"`, `workspace_slug`, `args`, and ISO8601 `ts`.
3. Write `{run_dir}/scratchpad.md` from the template in this phase file.
4. Set: Feature, Run ID, Workspace, Flags, Started date, Current Phase: "Phase 1: Requirements", Status: IN_PROGRESS.

If `{run_dir}/` somehow already exists after the collision-suffix step, abort with a clear error — it indicates a clock or filesystem anomaly, not a user mistake.

**Step 5: Pre-flight usage gate.**

Read `~/.claude/stats-cache.json`. Find today's date in `dailyModelTokens`. Sum tokens per model. Compare against the observed daily ceiling (the max daily value for each model in the history).

If any model exceeds 80% of its observed ceiling:

```
⚠️ Today's {model} usage is at {N}% of your observed daily budget.
This pipeline typically consumes {estimate}. You may hit rate limits mid-run.
Continue anyway? (yes / no)
```

**Behavior: warn and continue.** Do not hard-block. The user decides.

If `stats-cache.json` doesn't exist or has no data for today, skip the gate silently.

**Step 6: Auto-start the live pipeline view.**

Launch the `pipeline-view` server in the background so the user can watch the crew queue in real time. Use `Bash` with `run_in_background: true`:

```bash
node {plugin_dir}/skills/site-view/server.js --workspace={workspace_slug} --run-id={run_id}
```

The server auto-opens the browser at `http://127.0.0.1:5173`, watches `{pipeline_dir}/active.md`, and stays running until the user closes the terminal.

Do not wait for the server process to finish. Continue immediately to Phase 1.

---
