## Phase: Fix loop — round N

Emit `phase_start` (`phase: "fix-r{N}"`). Inputs: `{run_dir}/rounds/r{N}/failures.json`.

### Step 1: Plan

`node {plugin_dir}/scripts/plan-fix-groups.js --input={run_dir}/rounds/r{N}/failures.json > {run_dir}/rounds/r{N}/plan.json`

Each group carries `id`, `repo`, `locus`, `path` (`direct | diagnose`), `case_ids`, `repos_touched`, `bounce`, `failures`. A group with a non-null `bounce` starts as dropped (Bounce rules in SKILL.md).

### Step 2: Fix-plan gate

`gate.js open --run-dir={run_dir} --phase=fix-r{N} --gate=approval --question="Fix plan round {N}"`:
```
Fix plan — round {N} of {max}
  G1  {repo}  {case ids}  path: direct    — {observed, 1 line} @ {file_line}
  G2  {repo}  {case ids}  path: diagnose  — {http / screenshot / observed summary}
  G3  {repos} {case ids}  DROPPED — touches >2 repos → /deliver "<restated>"
Reply: approve | drop G2 | diagnose G1 | direct G2 | adjust G1: <text> | undrop G3 | stop
```
Apply replies until `approve` or `stop`; `close` the gate. `stop` → `phase-review-report.md` Step 4. Round ≥2: list only groups still failing.

Record per group the final path, any `adjust` text, and drops in `{run_dir}/rounds/r{N}/plan.md`.

### Step 3: Diagnose (groups on the diagnose path)

Skip if none. `{troubleshooter}` unavailable → park these groups (`no troubleshooter — run /discover --refresh`) and skip.

1. Per group, write `{run_dir}/tasks/{G}-r{N}-evidence.md`: the group's failure entries as plain text (case id, When, Then, observed, every non-null evidence field). Nothing else from the suite.
2. Arm the marker (format: `/troubleshoot` Step 3; `run_id` = this run's id):
   ```bash
   mkdir -p ~/.claude && cat > ~/.claude/.pipecrew-troubleshooter-active <<EOF
   pid=$$
   run_id={run_id}
   created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   EOF
   ```
3. Dispatch one `{troubleshooter}` per group, all in one message · description `"Diagnose — {G} {repo}"`. Prompt = `/troubleshoot` Step 4's prompt with: `SYMPTOM: {first case_id}: expected {then}, got {observed}` (other case ids listed on the next line), `env: {env name}` (never omitted), `since: 1h`, `repo: {repo}`, `evidence_file: {evidence path}`, `auto: true`, report directory `{run_dir}/rounds/r{N}/diagnose-{G}/`.
4. **Disarm — always, including when a dispatch errored:** `rm -f ~/.claude/.pipecrew-troubleshooter-active`.
5. Per group, read its report's Root cause:
   - `Found` with a `Fix:` action → fixable; the diagnosis is the root cause + Fix line + report path.
   - Says the case is outdated → spec-drift bucket (`/design-tests`).
   - Fix needs a spec / schema / contract change, or is a redesign → bounce (`/deliver`).
   - `Localized` / `Not yet` → parked for a human.
6. Show the updated plan (same table, diagnosis summary per group): `Proceed with {K} fixable groups? (proceed / stop)` via `gate.js` (`--gate=approval`).

Reach `prod` returns to `phase-verify.md` Step 3 here.

### Step 4: Worktrees (first round with a fixable group)

Per touched repo (the fixable groups' `repo`): `git -C {repo_path} worktree add ../{repo}-tf-{feature} -b {branch}` (branch exists from an earlier run today → reuse it with `git worktree add ../{repo}-tf-{feature} {branch}`). `--no-worktrees` → in place. Later rounds reuse the same worktrees. If a repo's AGENTS.md / CLAUDE.md / agent-context is untracked, implementers read it from the main checkout.

### Step 5: Task files

Per fixable group, fill `{plugin_dir}/templates/test-and-fix-task.md.template` into `{run_dir}/tasks/{G}-r{N}.md`:
- front matter: `repo`, `branch`, `source_run` = the round's runner dir, `case_ids`;
- `## Failing case(s)` from the group's failure entries;
- `## Diagnosis`: `direct — runner evidence` or the troubleshooter's root cause + Fix line + report path;
- `## Fix list`: the runner's `file_line` (direct) or the troubleshooter's Fix target; empty when neither exists (the implementer locates it from the evidence);
- any `adjust` text from the gate, appended under `## Diagnosis` as `User note:`.

### Step 6: Apply

1. `test -f ~/.claude/.pipecrew-troubleshooter-active && rm -f ~/.claude/.pipecrew-troubleshooter-active` — note it in the scratchpad if it was present.
2. One implementer per repo (TYPE_TO_AGENT by repo `type`), all repos in one message · description `"Fix r{N} — {repo}"`:
   ```
   repo_path: {worktree path}
   task_file: {run_dir}/tasks/{G}-r{N}.md   (all of this repo's groups, applied in order)
   fix_list: {each task file's ## Fix list}
   feature_summary: Fix failing acceptance cases of {feature}: {case titles}
   requirements: {the groups' covers ids + Then lines}
   Follow each task file's ## Constraints exactly. Run the repo's tests per ## Verification and fill ## Work log.
   ```
3. Per implementer result: it reports `bounce to /deliver` → bounce bucket; reports the Then looks outdated → spec-drift bucket. Neither is retried.

Emit `phase_end`.

### Step 7: Reach the environment

- Reach `a`: nothing — the runner reads the worktrees.
- Reach `b`: `Serve {serves_from or touched repos} from {worktree paths}, then reply ready.` (`--no-worktrees` → `Restart the local server, then reply ready.`)
- Reach `c`: `gate.js open --phase=reverify-r{N} --gate=approval --question="Deploy {branch} to {env}"` → `Deploy {branch} ({repos}) to {env}, then reply deployed — or skip to re-verify against the code.` `skip` → this round's re-verify uses `env: none` and the report notes the `consistent` cap.

### Step 8: Re-verify

Emit `phase_start` (`phase: "reverify-r{N}"`). Runner with `case_ids` = the fixed groups' ids, `run_dir: {run_dir}/rounds/r{N}-verify`, `env` per Step 7, and in reach `a` (or a skipped deploy) `repo_roster` paths replaced by the worktree paths. Extract its failures to `{run_dir}/rounds/r{N+1}/failures.json`. Emit `phase_end`.

- No failures → load `phases/phase-review-report.md`.
- Failures and `N < max-iterations` → repeat this phase with `N+1`.
- Failures and `N = max-iterations` → they are **residuals**; load `phases/phase-review-report.md`.
