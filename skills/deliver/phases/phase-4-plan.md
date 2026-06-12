### Phase 4: Sync Specs

**Default: OFF.** Phase 4 only runs when the user explicitly opted in at the Phase 3 approval gate. Read `spec_sync_opt_in` from the scratchpad's Architecture Flags section.

**Skip conditions** (any of these → skip the phase):
- `spec_sync_opt_in` is `no` or unset → log `"Phase 4 skipped — user did not opt in at the Phase 3 gate."`
- No repo has `spec_copies` entries referencing any affected service → log `"Phase 4 skipped — no sync targets exist."` (this case should already have been caught at the Phase 3 gate, which suppresses the follow-up question; the skip-check here is defensive.)

When NOT skipped, for each affected service, find all repos that have `spec_copies` entries referencing that service, and copy the updated spec:

```bash
# For each repo that has spec_copies:
{for each repo in config.repos where repo.spec_copies exists:}
  {for each [service_key, relative_path] in repo.spec_copies:}
    {if service_key is in the affected services list:}
      cp {config.repos[config.services[service_key].repo].path}/{config.services[service_key].spec_file} {repo.path}/{relative_path}
```

Report which repos received which spec copies.

**Update scratchpad**: Set Phase 4 Status to COMPLETED (or SKIPPED with the specific reason from the skip-conditions above). Set Current Phase to "Phase 4.5: Implementation Plan".

---

### Phase 4.5: Implementation Plan + Context Budget

Phase 4.5 dispatches the **`task-planner`** sub-agent to hydrate the architect's TASK_SKELETON into per-task markdown files for Phase 5 implementers. The orchestrator no longer synthesizes the plan in-context — it routes between the planner, the user gate, and the scratchpad.

The planner is documented at `{plugin_dir}/agents/task-planner.md`. It runs in three modes — `draft` (produce the plan summary the user reviews), `adjust` (re-issue with natural-language pushback), `persist` (write all task files after final approval). Each mode is one Agent dispatch.

**Auto-detected phase plan** (read from the scratchpad's Architecture Flags section, set during Phase 2):
- Phase 5a runs if: architect listed affected services AND `--frontend-only` not passed
- Phase 5b runs if: `frontend_required = Yes` AND `--backend-only` not passed
- Phase 5c runs if: `mock_required = Yes` AND `--no-mock` not passed AND `--backend-only` not passed
- Phase 5d runs if: architect flagged infrastructure impact OR `--with-infra` was passed

The planner reads the same flags out of the scratchpad — they are the source of truth for which slices to include.

#### Step 1 — Pre-flight: verify TASK_SKELETON exists

Before dispatching, confirm the architect emitted the skeleton:

```bash
test -s {run_dir}/outputs/blocks/task-skeleton.json
```

If the file is missing or empty, halt — re-dispatch the architect via Phase 2 SendMessage as documented in `phase-2-architecture.md` § "Verify TASK_SKELETON exists". Do NOT attempt Phase 4.5 without it; the planner will refuse.

#### Step 2 — Dispatch task-planner in `draft` mode

**Tool**: `Agent`
**subagent_type**: `task-planner`
**description**: `"Implementation plan — {feature-slug} (draft)"`
**prompt**:

```
Mode: draft

run_dir:        {run_dir}
workspace_root: {workspace_root}
slug:           {slug}

Read your system prompt's "draft" section. Produce the plan summary using the structure documented there.
Do NOT write any files in this mode.
```

Capture the planner's full response — it is the plan summary the user will review at the gate. Per critical rule #13, parse the agent's `<usage>` block and append a Dispatch Log row with phase `4.5-draft`, agent `task-planner`, duration + tokens reported, outcome `success`.

#### Step 3 — Open the user gate

Open the gate via `gate.js`:

```bash
node {plugin_dir}/scripts/gate.js open --run-dir={run_dir} --phase=4.5 --gate=approval --question="Approve the implementation plan?"
```

Paste the planner's summary verbatim into chat, then ask:

```
How do you want to proceed?
  1. Approve all   — run Minimum + Deferrable in this pipeline
  2. Minimum only  — run Minimum now; write Deferrable to a follow-up file the next /deliver can pick up
  3. Adjust        — push back on specific sub-tasks before approving
```

If the planner's summary contains zero `D` sub-tasks, collapse the gate to the **two-option form** (`Approve / Adjust`) — option 2 is irrelevant when there is nothing to defer.

#### Step 4 — Handle the user response

**On `Approve all`** → close the gate (Step 6), then jump to Step 5 with `approved_slice = "all"`, `adjustments = []`.

**On `Minimum only`** → close the gate, then jump to Step 5 with `approved_slice = "minimum-only"`, `adjustments = []`.

**On `Adjust`** → DO NOT close the gate yet. Capture the user's natural-language pushback verbatim (e.g., `"move 1.D.1 to minimum and drop 2.D.2 entirely"`). Append it to the running `adjustments` list (start a new list on the first adjust round). Then re-dispatch:

  **Tool**: `Agent`
  **subagent_type**: `task-planner`
  **description**: `"Implementation plan — {feature-slug} (adjust round N)"`
  **prompt**:

  ```
  Mode: adjust

  run_dir:        {run_dir}
  workspace_root: {workspace_root}
  slug:           {slug}
  adjustments:
    - {accumulated adjustment 1}
    - {accumulated adjustment 2}
    - ...

  Read your system prompt's "adjust" section. Re-derive from the original TASK_SKELETON, apply ALL adjustments in the list (in order), produce the revised plan summary + a "Changes since draft" changelog.
  Do NOT write any files in this mode.
  ```

  Append a Dispatch Log row with phase `4.5-adjust-r{N}` (e.g., `4.5-adjust-r1`, `4.5-adjust-r2`) — the round number is the count of adjust dispatches issued so far. Render the planner's revised summary + changelog, repeat the gate prompt (still on the same open gate). Loop until the user picks Approve-all or Minimum-only.

  If the planner returns `unparseable adjustment: '{text}'`, surface that exact message to the user and ask them to rephrase. Do not try to interpret the original text yourself — the planner is the only thing allowed to map natural language to skeleton diff ops.

#### Step 5 — Dispatch task-planner in `persist` mode

Once the user approves (Approve all OR Minimum only):

**Tool**: `Agent`
**subagent_type**: `task-planner`
**description**: `"Implementation plan — {feature-slug} (persist)"`
**prompt**:

```
Mode: persist

run_dir:           {run_dir}
workspace_root:    {workspace_root}
slug:              {slug}
approved_slice:    {"all" | "minimum-only"}
adjustments:
  - {accumulated adjustment 1}
  - ...   (omit this block if no adjust rounds ran)
phase_3_worktrees: {JSON map of repo_key → worktree_path from scratchpad's Architecture Flags — combine `contract_worktrees` + `spec_worktrees` if both exist}

Read your system prompt's "persist" section. Apply adjustments deterministically, generate task IDs, write per-task markdown files under {run_dir}/tasks/, write the deferred follow-up file if approved_slice is "minimum-only", and return the PLANNER_RESULT JSON block.
```

Append a Dispatch Log row with phase `4.5-persist`, outcome `success`. Capture the planner's response.

#### Step 6 — Parse PLANNER_RESULT and update scratchpad

Extract the `<!-- BEGIN PLANNER_RESULT -->` ... `<!-- END PLANNER_RESULT -->` block from the planner's response (use `extract-block.js` for consistency, or parse the JSON block directly). The shape:

```json
{
  "tasks": [
    { "task_id": "...", "repo_key": "...", "tier": "M", "title": "...", "file_path": "{run_dir}/tasks/{task-id}.md" },
    ...
  ],
  "deferred_file": "{path or null}",
  "deferred_count": 0,
  "warnings": []
}
```

Use `tasks[]` to populate the scratchpad's Implementation Tasks table with **IDs and repo names only** — no descriptions, no checklists. The full body lives in each task file; the orchestrator's context never needs it:

```markdown
## Implementation Tasks

| # | Task ID | Repo | Agent | Status | Worktree | Files Changed |
|---|---------|------|-------|--------|----------|---------------|
| 1 | {task_id} | {repo_key} | {resolved implementer} | PENDING | | |
...
```

Fill the `Agent` column from the `TYPE_TO_AGENT` table in `phases/dispatch-rules.md`, keyed by `config.repos[repo_key].type`. For `type: other`, write `— (skip — no implementer)` and mark status `SKIPPED`.

If `deferred_file` is non-null, log to the user: `"Deferred slice written to {path} — {deferred_count} sub-tasks. Resume with /deliver --from-deferred={feature-slug}."` The deferred-file format is canonical and lives entirely in the planner's output — the orchestrator does not write it directly.

If `warnings[]` is non-empty, surface each warning before continuing.

Close the gate:

```bash
node {plugin_dir}/scripts/gate.js close --run-dir={run_dir}
```

#### Step 7 — Phase-done status + scratchpad update

Emit the standard one-line phase-done status (per critical rule #16):

```
[phase 4.5 ✔] {N} task files written across {M} repos ({D} deferred to follow-up file) ({tokens}, {duration})
```

If adjust rounds ran, append: `(R adjust rounds before approval)`.

**Update scratchpad**: Set Phase 4.5 Status to COMPLETED. Set Current Phase to "Phase 5: Implementation".

---

#### Phase 4.5 — Dispatch Phase 5 implementers with task IDs

When Phase 5 dispatch happens, every implementer agent is launched with a prompt that contains **only its task ID** plus a handful of pipeline-level context fields (worktree path, repo path, branch name). The implementer's first action is to load its task via the Read tool:

```
You are implementing a feature in the {repo-type} worktree at {worktree_path}.

TASK FILE: ~/.claude/dal-pipeline/tasks/{task-id}.md

Your first action: use the Read tool to load the task file at the path above.
The file's YAML frontmatter identifies the task (id, phase, repo, requirement refs). The body below the frontmatter is the full sub-task specification — feature summary, the numbered sub-task checklist, functional requirements (FR-X) and edge cases (EC-X) to enforce, the relevant data model and API design sections, endpoint list with exact spec field names, worktree path, and the expected report format.

Read it once, internalize it, and do not re-quote it in your output or in any intermediate scratchpad update — the orchestrator already knows what the task says, and you are expected to operate from your own loaded copy without forwarding it anywhere.

When you finish implementing and testing, update the task file's status before returning. Use the Edit tool to change the two frontmatter fields:
- `status: todo` → `status: done`
- `updated_at: <old timestamp>` → `updated_at: <current UTC ISO-8601 timestamp>`

Leave the body verbatim. Then produce your report to the orchestrator in the format the task body specified.

CRITICAL FOR THIS DISPATCH (do not skip — these are the HARD RULES from `{plugin_dir}/rules/implementer-common.md` most often forgotten):
- **R9 — COVERAGE block.** Emit BOTH the human-readable `## Requirement coverage` table AND the `<!-- BEGIN COVERAGE -->` JSON block. Count the `FR-X` and `EC-X` lines in your task file body before reporting done — your COVERAGE block must contain one entry per ID, each with a `file:line` enforcement point.
- **R6 — Scope discipline.** Every line in your diff must trace to an FR-X, EC-X, or sub-task line in the task file. If it doesn't, do not write it.
- **R7 — Stop on load-bearing ambiguity.** Do not guess. If a field name, type, status code, or contract shape is ambiguous, return an `## Assumptions` block at the top of your report instead of coding.
- **R8 — Stay in your launched worktree.** Never `git checkout` another branch, never `git worktree add`, never edit outside `{worktree_path}`.

Now: load the task file at the path above and implement the feature within `{worktree_path}`.

