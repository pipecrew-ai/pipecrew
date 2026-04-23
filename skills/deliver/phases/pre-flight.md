### Scratchpad Template

The scratchpad lives at `{run_dir}/scratchpad.md` where `{run_dir}` = `~/.claude/workspaces/{slug}/runs/feature/{run_id}/`. Per-run isolation — each feature gets its own directory so two features can run in parallel on the same workspace without token accounting bleeding.

`{run_id}` format: `{YYYY-MM-DD-HHMMSS}-{feature-slug}` (see `{plugin_dir}/docs/observability.md`). The timestamp provides uniqueness; the feature slug provides readability. On same-second collision, append `-2`, `-3`, …

#### Directory Structure
```
~/.claude/workspaces/{slug}/runs/feature/
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

`{run_id}` is the enduring identity of a feature run — used in checkpoints, surfaced in the reporter, and what `--resume` targets. Archival is implicit: old run dirs sort by name (chronological), so listing `runs/feature/` gives history for free. No separate `active/`, `completed/`, or `history/` subdirs.

#### scratchpad.md Template

```markdown
# Run Scratchpad

## Run Info
- **Skill**: feature
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

1. Read the workspace config at `~/.claude/workspaces/{workspace}/config.json`
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

**Step 1: Load and validate workspace config.**

Read `~/.claude/workspaces/{workspace}/config.json`. Run the validator:

```bash
node {plugin_dir}/scripts/validate-config.js ~/.claude/workspaces/{workspace}/config.json
```

If validation fails (exit code 1), print the errors and stop. If warnings exist, print them and continue.

Extract key references from the config into short aliases used throughout the rest of the pipeline:
- `{runs_dir}` = `~/.claude/workspaces/{slug}/runs/feature/` — base for all feature runs (replaces the old `config.workspace.pipeline_dir`)
- `{run_dir}` = `{runs_dir}/{run_id}/` — this specific run (computed once in Step 2)
- `{repos.*}` = `config.repos` — iterate for path validation
- `{services.*}` = `config.services` — iterate for service→repo→spec lookups
- `{domain}` = `config.domain` — passed to the product-owner and architect

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
2. Emit the first `run_start` event to `{run_dir}/checkpoints.jsonl` with `skill: "feature"`, `workspace_slug`, `args`, and ISO8601 `ts`.
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
