## Phase D: Verification

Final checks and summary. Make sure everything generated is valid and the workspace is ready for `/deliver`.

---

### Step 1: Validate workspace config

```bash
node {plugin_dir}/scripts/validate-config.js ~/.claude/workspaces/{slug}/config.json
```

Must exit 0. If warnings, print them. If errors, fix them before continuing.

### Step 2: Verify CLAUDE.md in every repo

For each repo in the config:

```bash
test -f "{repo.path}/CLAUDE.md" && echo "OK: {repo_name}" || echo "MISSING: {repo_name}"
```

If any are missing, report and ask the user to resolve (re-run Phase C Step 2 for that repo, or accept the gap).

### Step 3: Verify domain agents exist

Check that the three domain agents were generated:

```bash
ls ~/.claude/workspaces/{slug}/agents/product-owner.md
ls ~/.claude/workspaces/{slug}/agents/assessor.md
ls ~/.claude/workspaces/{slug}/agents/ux-consultant.md
```

If any are missing, regenerate from the template.

### Step 4: Verify platform context exists

```bash
test -f ~/.claude/workspaces/{slug}/context/platform.md && echo "OK" || echo "MISSING"
```

If missing, Phase B2 failed — ask user whether to re-run the architect discovery or create a minimal stub.

### Step 5: Check git status of repos

For each repo, check if CLAUDE.md or agent-context files were generated (meaning they're untracked):

```bash
cd {repo.path} && git status --short CLAUDE.md agent-context/ 2>/dev/null
```

Report new files:
```
## New files to commit

These files were generated during onboarding. Commit them so your team gets the benefit:

| Repo | New files |
|------|-----------|
| publisher-service | CLAUDE.md |
| pms-frontend | CLAUDE.md, agent-context/ (4 files) |
| backends-mock | CLAUDE.md |
```

Do NOT commit them automatically. The user decides when and how to commit.

### Step 6: Present onboarding summary

```
## ✅ Onboarding Complete: {workspace.name}

### Workspace Config
  ~/.claude/workspaces/{slug}/config.json
  {N} repos · {N} services · {N} user roles

### Platform Context
  ~/.claude/workspaces/{slug}/context/platform.md
  {N} entities · {N} integration patterns · {N} established patterns

### Domain Agents
  ~/.claude/workspaces/{slug}/agents/
  ├── product-owner.md
  ├── assessor.md
  └── ux-consultant.md

### Per-Repo Status
| Repo | CLAUDE.md | Agent-Context | Notes |
|------|-----------|---------------|-------|
| {name} | ✅ generated | ✅ generated | — |
| {name} | ✅ existed | ⏭ skipped | — |
| {name} | ✅ manual | ⏭ skipped (simple) | — |

### Audit Findings (include ONLY if audit-findings.md exists)
  ~/.claude/workspaces/{slug}/context/audit-findings.md
  {N} critical · {N} high · {N} medium · {N} low

  ⚠ CRITICAL findings (list every critical bullet verbatim — these will bite at runtime if unaddressed):
  - [critical] {repo}: {file:line} — {description}
  - ...

  Review the full file before touching the affected code paths.

### What to do next
1. Review generated CLAUDE.md files — edit anything the agent missed
2. Review ~/.claude/workspaces/{slug}/context/platform.md — correct any entity or pattern errors
3. Triage audit-findings.md (if present) — decide which findings to fix now vs. track
4. Commit CLAUDE.md and agent-context/ files to your repos
5. Run your first feature:
   /deliver "your feature description" --workspace={slug}
```

**Audit findings surfacing rule:** read `audit-findings.md` if it exists. In the summary output:
- Always include the file path + severity counts.
- List every `critical` finding verbatim — these are worth interrupting the user for.
- Mention `high` count only; do not enumerate them (would bury the criticals).
- If no critical or high findings, just show the counts line; skip the warning block.

---

### Step 7: Execution summary (per-phase + per-agent token accounting)

Read `~/.claude/workspaces/{slug}/runs/onboard/{run_id}/checkpoints.jsonl` and produce a two-table execution summary. This reads the event log emitted during the run (see the **OBSERVABILITY** section in `SKILL.md` and `{plugin_dir}/docs/observability.md` for the full schema).

Run `node {plugin_dir}/scripts/validate-checkpoints.js {run_dir}/checkpoints.jsonl` first — on exit 1, surface the schema violation before building the summary; on exit 2, note the warnings in the summary but continue.

If the JSONL file does not exist (e.g., an older run predating observability, or a corrupted log), emit a single line `⏱ Execution summary unavailable — no checkpoints.jsonl found` and move on. Do not halt.

**Table 1 — per-phase roll-up:**

For each phase that has a matched `phase_start` / `phase_end` pair, compute:
- `duration` = `phase_end.ts` − `phase_start.ts` (formatted `M:SS`)
- `agents` = count of `agent_end` events with this `phase` (append `(Nr)` if any were retries, e.g., `2 (1r)`)
- `tokens` = sum of `total_tokens` across all `agent_end` events with this `phase`

Emit:

```
## ⏱ Execution Summary

| Phase | Stage                    | Duration | Agents | Tokens  |
|-------|--------------------------|----------|--------|---------|
| A     | Repo Discovery           | 0:42     | 0      | —       |
| B1    | Domain Questions         | 2:10     | 0      | —       |
| B2    | Architect Discovery      | 4:03     | 1      | 77,922  |
| B2.5  | Divergence Harvest       | 0:58     | 3      | 41,205  |
| B3    | Design System            | 2:16     | 1      | 46,687  |
| C1    | Workspace Config         | 0:08     | 0      | —       |
| C2    | Docs Generation (CLAUDE.md + agent-context) | 4:12 | 4 (1r) | 186,350 |
| C3    | Domain Agents            | 0:45     | 0      | —       |
| C4    | Audit Findings Collation | 0:04     | 0      | —       |
| D     | Verification             | 0:12     | 0      | —       |
|       | **Total**                | **14:30**| **9**  | **352,164** |
```

Format rules:
- `Tokens` column shows `—` (em-dash) for phases with zero agent calls, not `0`.
- `Agents` column shows `N` for clean runs; `N (Rr)` when `R` retries happened; `N (Rr Dd)` when `D` were deferred.
- Total row sums duration (sum of phase durations, not wall-clock end-to-end — they may overlap on parallel dispatch) and tokens.

**Table 2 — per-agent detail:**

One row per `agent_end` event, sorted by `phase` ascending then `ts` ascending:

```
Per-agent detail:
| Agent                       | Phase | Tokens   | Duration | Status   | Findings |
|-----------------------------|-------|----------|----------|----------|----------|
| solution-architect          | B2    |  77,922  | 4:03     | ok       | —        |
| general-purpose (divergence) | B2.5 |  13,402  | 0:54     | ok       | —        |
| general-purpose (divergence) | B2.5 |  14,120  | 0:56     | ok       | —        |
| general-purpose (divergence) | B2.5 |  13,683  | 0:58     | ok       | —        |
| general-purpose (design-sys)| B3    |  46,687  | 2:16     | ok       | —        |
| context-manager:full (auth)      | C2 |  48,702  | 3:12     | ok       | 2        |
| context-manager:full (publisher) | C2 |  71,521  | 4:05     | ok       | 5        |
| context-manager:full (backoffice) | C2 | 38,400  | 2:45     | retry→ok | 1        |
| context-manager:claude-only (ops-platform) | C2 | 27,727 | 1:38 | ok | —        |
```

Format rules:
- `Status`: `ok` for a clean run, `retry→ok` if a retry preceded success, `deferred` if both attempts failed.
- `Findings`: audit-findings count from `audit_findings_count` if present; `—` otherwise.
- `Duration`: formatted `M:SS`; if the event has no `duration_ms`, show `—`.

**Cost note (optional):** if `workspaces/{slug}/config.json` has `"track_cost": true`, append a one-line estimate under Table 2:

```
Est. API cost at current Opus rates: $X.XX (total_tokens × $0.000015 / 1k + output adjustment)
```

Omit the line if the flag is absent. Do not invent a rate card.

**Slow-bash detail (conditional):** if the JSONL has any `bash_slow` events, emit a third small table listing them (truncated at 10 rows). Skip entirely if none.

**Partial-failure block (conditional):** if any `agent_end` has `status: "deferred"`, emit before Table 1:

```
⚠ Partial run — N agents deferred after retry:
- {agent_type} ({description}) — {retry_reason}
- ...
Re-run `/discover --resume --workspace={slug}` to fill the gaps.
```

---

**Update scratchpad**: Set Phase D status to COMPLETED. Set top-level Status to COMPLETED. Emit a `run_end` event to `checkpoints.jsonl` with `status: "completed"` and `duration_ms` computed from the initial `run_start`. The entire `runs/onboard/{run_id}/` directory stays as the permanent record — scratchpad for humans, checkpoints.jsonl for the reporter and cross-workspace trending.

---
