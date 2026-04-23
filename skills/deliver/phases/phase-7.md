### Phase 7: Summary + Archive

Phase 7 has four sub-steps that run sequentially.

---

#### Step 7.1: Reporter agent — execution report

Dispatch the `reporter` agent (Haiku) to compile the execution report. The reporter reads the scratchpad, checkpoints.jsonl, stats-cache.json, and historical runs to produce a detailed report with waterfall timeline, token breakdown, daily budget status, trend comparison, and narrative insights.

**Tool**: `Agent`
**subagent_type**: `reporter`
**model**: `haiku`
**description**: `"Run report — {run_id}"`
**prompt**:

```
Generate the execution report for this run.

Run dir:     {run_dir}
Scratchpad:  {run_dir}/scratchpad.md
Checkpoints: {run_dir}/checkpoints.jsonl
Stats cache: ~/.claude/stats-cache.json
Prior runs:  ~/.claude/workspaces/{slug}/runs/feature/         (sibling run_id dirs — use for trend comparison)

Validate the checkpoints log first:
  node {plugin_dir}/scripts/validate-checkpoints.js {run_dir}/checkpoints.jsonl
On exit 1, surface the schema violation in the report header. On exit 2, note warnings but continue.

Write the report to: {run_dir}/report.md
```

After the reporter returns, also write the manual execution table below as a fallback (the reporter's output is richer, but the template ensures a baseline if the reporter fails).

---

#### Step 7.2: Context-manager refresh (unless `--no-context-update`)

If `--no-context-update` was NOT passed, dispatch the `context-manager` in refresh mode for each repo that had files changed during this pipeline run.

**Tool**: `Agent` (one per repo, dispatched in parallel)
**subagent_type**: `context-manager`
**description**: `"Context refresh — {repo-name}"`
**prompt**:

```
Mode: refresh
Repo: {repo_worktree_path}
Files changed: {list of files from scratchpad Implementation Tasks}
Feature name: {feature name}

Update agent-context docs to reflect the new feature per your refresh-mode instructions. Only modify docs if the feature genuinely changed the architecture or conventions.

If the feature added or removed any file under agent-context/common/ (topic files), you MUST also update CLAUDE.md's `## Deep context` table to stay in sync, then run:
  node {plugin_dir}/scripts/validate-claude-md.js {repo_worktree_path}/CLAUDE.md

On validator exit 1 (hard-fail), fix the flagged issues and re-validate. Do not touch CLAUDE.md's stable sections (Agent guidelines, Quick facts, Build & run, Must-know guidelines) — those are repo-level invariants that features should not mutate.
```

If a repo has no agent-context directory, skip it silently (this repo was onboarded in `claude-only` mode; there is nothing to refresh).

---

#### Step 7.3: Execution report template (fallback)

Read the scratchpad Phase Status table to compile durations and token counts.

```markdown
# DAL Feature Pipeline — Execution Report

## Feature: {name}
## Service(s): {affected services}
## Date: {date}

---

## Phase Execution Report

| Phase | Status | Duration | Tokens | Notes |
|-------|--------|----------|--------|-------|
| Pre-flight | Done | {Xs} | — | All repos verified |
| Requirements | Done | {Xm Xs} | {N}K | {revision count, key decisions} |
| Architecture | Done | {Xm Xs} | {N}K | {revision count, key decisions} |
| Spec Edit | Done/Skipped | {Xm Xs} | — | {endpoints added/modified} |
| Spec Sync | Done | {Xs} | — | Synced to frontend + mock |
| Implementation Plan | Done | {Xm Xs} | — | {N} tasks, {N} sub-tasks |
| UX Consultant | Done | {Xm Xs} | {N}K | {key UX decisions} |
| Backend: {service} | Done/Skipped | {Xm Xs} | {N}K | {files changed} |
| Frontend | Done/Skipped | {Xm Xs} | {N}K | {files changed} |
| Mock Server | Done/Skipped | {Xm Xs} | {N}K | {handlers updated} |
| Infra | Done/Skipped | {Xm Xs} | {N}K | {resources added} |
| Code Review (per repo) | Done/Skipped | {Xm Xs} | {N}K | {critical/non-critical/suggestions counts, fix round yes/no} |
| Assessment | Done | {Xm Xs} | {N}K | Score: {PASS/PARTIAL/FAIL} |
| Fix Round(s) | Done/N/A | {Xm Xs} | {N}K | {N} rounds, {summary} |
| **Total** | — | **{Xm Xs}** | **{N}K** | — |

---

## Per-Task Breakdown

Compiled from each task file's cumulative frontmatter metrics. Lists every task created during this pipeline run.

| Task ID | Repo | Phase | Status | Invocations | Duration | Tokens | Last Agent |
|---------|------|-------|--------|-------------|----------|--------|------------|
| {id} | {repo} | 4.5 | done | 1 | {Xm Xs} | {N}K | spring-boot-api-implementer |
| {id} | {repo} | 4.5 | done | 2 | {Xm Xs} | {N}K | react-feature-implementer (fix round) |
| {id} | {repo} | 5.5 | done | 1 | {Xm Xs} | {N}K | spring-boot-code-reviewer |
| ... | ... | ... | ... | ... | ... | ... | ... |
| **Total** | — | — | — | **{N}** | **{Xm Xs}** | **{N}K** | — |

## Per-Agent Breakdown

Compiled from the Agent Dispatch Log. Shows how much each subagent type spent in total across the run, useful for identifying which agent is the most expensive and for tuning prompts.

| Agent | Dispatches | Total Duration | Total Tokens | Avg Duration | Avg Tokens |
|-------|------------|----------------|--------------|--------------|------------|
| dal-product-owner | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| solution-architect | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| openapi-spec-editor | {N} | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| ux-consultant | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| spring-boot-api-implementer | {N} | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| react-feature-implementer | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| mock-endpoint-implementer | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| cdk-stack-implementer | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| spring-boot-code-reviewer | {N} | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| react-code-reviewer | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| dal-assessor | 1 | {Xm Xs} | {N}K | {Xm Xs} | {N}K |
| **Total** | **{N}** | **{Xm Xs}** | **{N}K** | — | — |

**Conditional rows:**
- **`--skip-spec-edit`** was passed → omit the `openapi-spec-editor` row entirely. The spec editor was never dispatched this run, so a "0 dispatches" row is misleading clutter.
- **`--no-review`** was passed → omit the `spring-boot-code-reviewer` and `react-code-reviewer` rows.
- **`--no-mock`** was passed → omit the `mock-endpoint-implementer` row.
- **`--backend-only`** → omit frontend + mock + ux-consultant + react-code-reviewer rows.
- **`--frontend-only`** → omit backend + mock + infra + spring-boot-code-reviewer rows.

---

## Repos Modified

### {repo-name}
- {summary of changes per repo — files, migrations, endpoints, tests}
- **Worktree**: {worktree path} on branch `feature/{feature-slug}`

---

## Next Steps
- [ ] {run tests}
- [ ] {register roles}
- [ ] {deploy order}
- [ ] {create PRs from worktrees}
```

**If `--with-pr` was passed**, create pull requests automatically before presenting the report. For each worktree with commits ahead of main:

```bash
cd {worktree_path}
gh pr create \
  --title "feat({repo-short}): {feature name}" \
  --body "$(cat <<'EOF'
## Summary
{one-paragraph feature summary}

## Changes
{bullet list of key changes in this repo}

## Assessment Result
{PASS/PARTIAL/FAIL} — see {link to phase-7-execution-report.md in gist or commit}

🤖 Generated by /deliver
EOF
)"
```

Record each PR URL in the execution report under a new **Pull Requests** section (one row per repo). If `gh pr create` fails for a worktree (e.g., no commits, branch not pushed, auth issue), log the error but do not abort — continue with the next worktree and note the failure in the report.

**Present the report to the user** (show the full table + repos + next steps + PR URLs if any).

#### Step 7.4: Archive scratchpad + history

Set Status to COMPLETED. Archive the run to history for trend comparison by future reporter runs:

**Pre-check**: verify the feature branch was merged to main in each worktree. If not, remind the user:
```
⚠ Worktrees still exist and may not be merged:
  - {repo}: feature/{slug} on worktree at {path}
  Run `git log main..feature/{slug}` to check unmerged commits.
Archive anyway? (yes / no)
```

No move, no copy — archival is implicit.

`{run_dir}` = `~/.claude/workspaces/{slug}/runs/feature/{run_id}/` already sits in the permanent location. The timestamp prefix of `{run_id}` makes it chronologically sortable. Listing `runs/feature/` in reverse-sort gives the history view for free. The `scratchpad.md` in the dir carries `Status: COMPLETED`, and checkpoints.jsonl has a final `run_end` event with `status: "completed"` and `duration_ms` — the reporter and any cross-run analysis tool can distinguish finished from in-flight by either signal.

To finalize the run, emit the `run_end` event:

```jsonc
{
  "ts": "2026-04-15T17:42:10Z",
  "event": "run_end",
  "skill": "feature",
  "run_id": "2026-04-15-142744-book-upload",
  "status": "completed",             // "completed" | "failed" | "aborted"
  "duration_ms": 10766000
}
```

That's the archival step. Cleanup (e.g., deleting old runs after N months) is a separate user-initiated maintenance action — not this skill's job.

---

### INTERRUPTION HANDLING

Apply the shared rules at `{plugin_dir}/docs/interruption-and-resume.md` — the user commands (`skip`, `stop`, `restart from phase X`), automatic interruption triggers (parallel fail, context limit, non-retryable error), scratchpad `Status` vocabulary (IN_PROGRESS / INTERRUPTED / COMPLETED / FAILED), and the required `checkpoints.jsonl` events (`run_end` / `phase_end`) are all defined there.

`/deliver` specifics: if a parallel Phase 5 agent defers after retry, the pipeline blocks on advancing to Phase 5.5 until the user resumes or explicitly approves continuing without the deferred agent.

---

### FLAG BEHAVIOR SUMMARY

| Flag | Skips | Starts From |
|------|-------|-------------|
| (none) | — | Phase 1 — architect decides frontend/mock |
| `--skip-spec-edit` | Phase 3 | Phase 1 → 2 → 4 → 5 |
| `--skip-backend` | Phase 3 + 5a | Phase 1 → 2 → 4 → 5b,5c,5d |
| `--frontend-only` | Phase 3 + 5a + 5c + 5d | Phase 1 → 2 → 4 → 5b |
| `--backend-only` | Phase 5b + 5c + 5d | Phase 1 → 2 → 3 → 4 → 5a |
| `--with-infra` | — | Forces Phase 5d even if architect didn't flag it |
| `--no-mock` | Phase 5c | — |
| `--no-review` | Phase 5.5 | Phase 5 → 6 directly |
| `--with-pr` | — | Phase 7 creates one PR per worktree |
| `--resume` | Completed phases | Reads scratchpad, continues from current phase |

**Architect auto-detection** (when no conflicting flag is set):
- `Frontend Changes Required: No` → Phase 5b skipped automatically
- `Mock Server Update Required: No` → Phase 5c skipped automatically
- Affected Services list → Phase 5a loops only for listed services
