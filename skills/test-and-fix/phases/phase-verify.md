## Phase: Verify + flaky confirm

Emit `phase_start` (`phase: "verify"`).

### Step 1: Baseline run (r0)

Dispatch **`pipecrew:regression-runner`** · description `"Test-and-fix verify — {feature} ({env | code-grounded})"`:
```
workspace_root: {workspace_root}
slug: {slug}
case_files: [{ws}/testcases/{feature}.md]
env: {none | {name, production, base_url, services, notes}}
browser_available: {browser_available}
repo_roster: {key → {path, type, role} from config.json}
run_dir: {run_dir}/rounds/r0
purpose: {smoke if reach prod, else regression}
{credentials the user supplied, if any}
```

Extract: `node {plugin_dir}/scripts/extract-block.js {run_dir}/rounds/r0/report.md REGRESSION_FAILURES > {run_dir}/rounds/r0/failures.json`.
- Exit 2 → stop: `Runner report has no REGRESSION_FAILURES block — re-run after updating the plugin.` (Run Step 4 of `phase-review-report.md` with what exists.)
- `failures` empty → relay the runner's GO + counts, write the report (`phase-review-report.md` Step 4) and stop. No branch, no worktree.

### Step 2: Flaky confirm (reach b, c, prod only)

Reach `a` skips this step (code-grounded verdicts are deterministic).

Re-dispatch the runner with the same inputs plus `case_ids: [{failed ids}]`, `run_dir: {run_dir}/rounds/r0-confirm`. Extract its failures the same way. Ids that failed in r0 but not in r0-confirm → **flaky**: record them for the report and drop them from the loop. Remaining failures → `{run_dir}/rounds/r1/failures.json` (the entries from r0-confirm).

Reach `a`: copy r0's failures to `{run_dir}/rounds/r1/failures.json`.

All failures flaky → report (`phase-review-report.md` Step 4) and stop.

Emit `phase_end`.

### Step 3: Production stops here

Reach `prod`:
1. Plan groups: `node {plugin_dir}/scripts/plan-fix-groups.js --input={run_dir}/rounds/r1/failures.json > {run_dir}/rounds/r1/plan.json`.
2. Ask once: `Diagnose these {N} groups read-only on {env}? (yes / no)`. On yes → run `phase-fix-loop.md` **Step 3 (diagnose) only**, for every group regardless of its path.
3. Print per group:
   ```
   {G}: {case ids} — {root cause | evidence summary}
     reproduce on a non-prod env: /test-and-fix --feature={feature} --env=<non-prod>
     {if a troubleshooter report says Found: /patch --from-troubleshoot={report path}}
   ```
4. Write the report (`phase-review-report.md` Step 4) and stop. Never continue to the fix loop.

Otherwise load `phases/phase-fix-loop.md` with `N = 1`.
