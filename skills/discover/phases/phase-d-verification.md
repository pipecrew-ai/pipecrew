## Phase D: Verification

Final checks and summary. Make sure everything generated is valid and the workspace is ready for `/deliver`.

---

### Step 1: Validate workspace config

```bash
node {plugin_dir}/scripts/validate-config.js {workspace_root}/{slug}/config.json
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
ls {workspace_root}/{slug}/agents/product-owner.md
ls {workspace_root}/{slug}/agents/assessor.md
ls {workspace_root}/{slug}/agents/troubleshooter.md
```

If any are missing, regenerate from the template. (There is no workspace `ux-consultant.md` — the UX consultant uses the base `pipecrew:ux-consultant`.)

### Step 4: Verify platform context exists

```bash
test -f {workspace_root}/{slug}/context/platform.md && echo "OK" || echo "MISSING"
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
  {workspace_root}/{slug}/config.json
  {N} repos · {N} services · {N} user roles

### Platform Context
  {workspace_root}/{slug}/context/platform.md
  {N} entities · {N} integration patterns · {N} established patterns

### Domain Agents
  {workspace_root}/{slug}/agents/
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
  {workspace_root}/{slug}/context/audit-findings.md
  {N} critical · {N} high · {N} medium · {N} low

  ⚠ CRITICAL findings (list every critical bullet verbatim — these will bite at runtime if unaddressed):
  - [critical] {repo}: {file:line} — {description}
  - ...

  Review the full file before touching the affected code paths.

### What to do next
1. Review generated CLAUDE.md files — edit anything the agent missed
2. Review {workspace_root}/{slug}/context/platform.md — correct any entity or pattern errors
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

### Step 7: Execution report (reporter agent → `report.md`)

The end-of-run report is a **saved output** at `{run_dir}/report.md`, produced by the `reporter` agent — the same way `/deliver` Phase 7 does it. This is where the **orchestrator's token usage** lands: the reporter's "Token Breakdown (orchestrator + agents)" section has an **Orchestrator row** that sums the `orch_checkpoint` deltas emitted at every phase boundary (see SKILL.md → Orchestrator overhead tracking). So "tokens used by the orchestrator" is captured here, persisted, and comparable across runs.

Run `node {plugin_dir}/scripts/validate-checkpoints.js {run_dir}/checkpoints.jsonl` first — on exit 1, surface the schema violation; on exit 2, note the warnings and continue. If the JSONL file does not exist (older run predating observability, or a corrupted log), skip straight to a one-line `⏱ Execution summary unavailable — no checkpoints.jsonl found` and proceed to `run_end`. Do not halt.

**Step 7.1 — Dispatch the reporter.** The reporter is skill-agnostic (it reads the unified checkpoint schema regardless of skill). Dispatch it to compile and write the report so the orchestrator's own context isn't spent building tables.

**Tool**: `Agent`
**subagent_type**: `reporter`
**description**: `"Discover execution report — {slug}"`
**prompt**: instruct it to read `{run_dir}/checkpoints.jsonl` + `{run_dir}/scratchpad.md` + `~/.claude/stats-cache.json` + sibling `runs/discover/*/` for trend comparison, and **write `{run_dir}/report.md`** with: waterfall timeline, Token Breakdown (orchestrator + agents), daily budget status, and trend vs prior discover runs. Pass `skill = discover`, `run_id = {run_id}`, `run_dir = {run_dir}`.

**The reporter owns `report.md`. The orchestrator does NOT write it on success.** After it returns, verify the file landed and is non-trivial (`node -e "process.exit(require('fs').statSync('{run_dir}/report.md').size > 400 ? 0 : 1)"`):
- **Reporter succeeded** → present a short summary to the user (and the path to `report.md`). Done — do NOT also author the fallback tables.
- **Reporter failed** (errored / returned empty / `report.md` missing or near-empty) → only then author the two-table summary inline per **Step 7.2** below, and note in its header that it was orchestrator-generated because the reporter failed.

### Step 7.2: Inline execution summary (FALLBACK ONLY — reporter failed)

Read `{run_dir}/checkpoints.jsonl` and produce the two-table summary below.

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
| B3    | Design System            | 2:16     | 1      | 46,687  |
| C1    | Workspace Config         | 0:08     | 0      | —       |
| C2    | Docs Generation (CLAUDE.md + agent-context) | 4:12 | 4 (1r) | 186,350 |
| C3    | Domain Agents            | 0:45     | 0      | —       |
| C4    | Audit Findings Collation | 0:04     | 0      | —       |
| D     | Verification             | 0:12     | 0      | —       |
|       | Orchestrator (overhead)  | —        | —      | 84,210  |
|       | **Total**                | **13:32**| **6**  | **395,169** |
```

Format rules:
- `Tokens` column shows `—` (em-dash) for phases with zero agent calls, not `0`.
- `Agents` column shows `N` for clean runs; `N (Rr)` when `R` retries happened; `N (Rr Dd)` when `D` were deferred.
- `Orchestrator (overhead)` row = sum of all `orch_checkpoint.orch_since_last` token deltas (input + output + cache_read) — the orchestrator's own usage (loading skills, reading repo code, approval gates), not attributable to any agent. Its Duration/Agents cells are `—`.
- Total row sums duration (sum of phase durations, not wall-clock end-to-end — they may overlap on parallel dispatch) and tokens **including the Orchestrator row**.

**Table 2 — per-agent detail:**

One row per `agent_end` event, sorted by `phase` ascending then `ts` ascending:

```
Per-agent detail:
| Agent                       | Phase | Tokens   | Duration | Status   | Findings |
|-----------------------------|-------|----------|----------|----------|----------|
| solution-architect          | B2    |  77,922  | 4:03     | ok       | —        |
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

### Step 8: Sync workspace memory to GitHub

Workspace memory publishes the durable onboarding output — `context/` (incl. `platform.md`), `agents/`, `history/` — to a **private** GitHub repo so the team shares one source of truth. Full design: `docs/design/github-memory.md`.

There are three entry states. Resolve which one you're in, then proceed:

1. **Already enabled** (`config.workspace.memory.enabled === true`, e.g. via `--memory-remote`): skip the prompt below and go straight to **Bootstrap + Sync**.
2. **Not enabled — offer it now** (`config.workspace.memory` absent or `enabled !== true`): present the opt-in prompt below. This is the common path, so a user who didn't know the flag still gets the chance to publish.
3. **Explicitly declined earlier this run**: skip silently.

**Opt-in prompt (state 2 only — default is NO, preserving off-by-default):**

> "Publish this workspace's context (`platform.md`, agent files, history) to a **private** GitHub memory repo so your team shares it? Future `/discover`, `/deliver`, `/learn`, and `/context-refresh` runs would then pull at pre-flight and sync automatically. Secrets are redacted before every push. (yes / no — default no)"

- On **no** (or no answer): skip the rest of Step 8. Note in the Phase D summary: "Workspace memory not enabled — context stays local. Run `/memory-sync enable` anytime to turn it on." Then jump to **Update scratchpad** below.
- On **yes**: write `config.workspace.memory` into `{workspace_root}/{slug}/config.json` (mirrors the `/memory-sync enable` path), then continue to **Bootstrap + Sync**:
  ```jsonc
  "workspace": { "memory": {
    "enabled": true,
    "remote": "",                 // filled in after gh repo create, below
    "visibility": "private",
    "sync_mode": "hybrid"         // shared-team default; PR for platform.md/ADR changes, commit for bookkeeping
  }}
  ```
  If the user names a remote URL when answering, use it as `remote` and skip the `gh repo create` step. If the URL resolves to a public repo, STOP and ask — never push memory to a public repo.

**Bootstrap (first time — when `{workspace_root}/{slug}/` is not yet a git repo):**
```bash
cd {workspace_root}/{slug}
git init -q && git branch -M main
cp {plugin_dir}/templates/workspace-memory.gitignore .gitignore
```
Then establish the **private** remote (refuse anything non-private):
- If `config.workspace.memory.remote` is set → `git remote add origin <remote>`.
- Else create one: `gh repo create {config.workspace.memory.repo_name || "{slug}-memory"} --private --source=. --remote=origin` and write the resulting URL back into `config.workspace.memory.remote`.
- If `memory.visibility` is anything other than `private`, STOP and ask the user — never push workspace memory to a public repo.

**Sync (every time):**
```bash
node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} --message "discover: onboard {slug}" --checkpoint=discover
```
This **redacts secrets first** (mandatory), regenerates the machine-independent `config.portable.json`, commits the durable docs (`context/`, `agents/`, `history/`, `config.portable.json`) per the `.gitignore`, rebases onto the team's latest, and publishes per `config.workspace.memory.sync_mode` (the first-ever bootstrap is always a direct push since it creates `main`; later re-onboards in `hybrid`/`pr` open a `memory/*` PR when `platform.md`/ADRs change). `config.json` and `runs/` are gitignored. If push/PR fails (no auth / diverged), it warns and leaves the commit local — do NOT fail the run; surface the warning.

**Update scratchpad**: Record the memory outcome in `## Generation Status` — `Memory: ENABLED+SYNCED` (state 1 or accepted opt-in), `Memory: SYNCED` (was already enabled), `Memory: DECLINED` (user said no / no answer), or `Memory: SYNC FAILED (<reason>)` (commit left local). Set Phase D status to COMPLETED. Set top-level Status to COMPLETED. Emit a `run_end` event to `checkpoints.jsonl` with `status: "completed"` and `duration_ms` computed from the initial `run_start`. The entire `runs/discover/{run_id}/` directory stays as the permanent record — scratchpad for humans, checkpoints.jsonl for the reporter and cross-workspace trending.

---
