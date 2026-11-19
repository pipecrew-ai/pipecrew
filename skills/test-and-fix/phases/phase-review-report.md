## Phase: Final pass, review, report, commit

Skip Steps 1–2 when no fix was applied.

### Step 1: Final full-scope pass

Emit `phase_start` (`phase: "final"`). Runner over the whole feature: `case_files: [{ws}/testcases/{feature}.md]`, no `case_ids`, `run_dir: {run_dir}/rounds/final`, same env / worktree rules as the last re-verify. Extract failures.

Cases that passed in r0 and fail now → **regressions introduced**. Gate (`gate.js --phase=final --gate=approval`):
```
The fixes broke {K} previously-passing cases: {ids}.
  fix — one more round on these (counts toward the cap; {remaining} left)
  stop — report them as regressions
```
`fix` with rounds left → `phase-fix-loop.md` with these failures as the next round; no rounds left or `stop` → report. Emit `phase_end`.

### Step 2: Review (unless `--no-review`)

Emit `phase_start` (`phase: "review"`). Per touched repo with a reviewer in TYPE_TO_AGENT (none, e.g. `node-mock` → skip, note it), dispatch the reviewer, all in one message · description `"Review — {repo}"`:
```
repo_path: {worktree path}
diff_base: {the commit the worktree branched from}
feature_summary: Fixes for failing acceptance cases of {feature}: {case ids}
requirements: {fixed cases' covers ids + Then lines}
Also check, and report as CRITICAL: any change that special-cases test data, ids, fixtures or environment names;
loosens a validation, check or assertion; or hides an error instead of fixing it.
```
Critical findings → `gate.js --phase=review --gate=fix-round` → `Apply one fix round for {N} critical findings? (yes / no)`. Yes → one implementer per affected repo with the findings as `fix_list` (marker check from `phase-fix-loop.md` Step 6.1 first), then re-run the affected case ids once (`rounds/review-verify`). No second review. Emit `phase_end`.

### Step 3: Commit

`--commit` → per touched repo, in the worktree: `git add -u` and commit
```
fix({feature}): {case ids}

{one line per group: case ids — what changed}

Co-Authored-By: {the session's standard co-author line}
PipeCrew-Run-Id: {run_id}
PipeCrew-Version: {node -p "require('{plugin_dir}/.claude-plugin/plugin.json').version"}
```
Never push. Without `--commit` → list the worktree paths and the branch, uncommitted.

### Step 4: Report

Write `{run_dir}/report.md`:
```markdown
# Test and fix — {slug} · {feature} · {env | code-grounded} · {YYYY-MM-DD}

**Result: ALL PASS | RESIDUALS | VERIFY ONLY (production)** — {one sentence}. Reach: {mode}{; caveat: re-verified code-grounded, verdicts capped at consistent}.

| Case | r0 | Path | Diagnosis | Fix (files) | Final |
|---|---|---|---|---|---|

## Flaky ({N})
## Residuals ({N}) — still failing after {rounds} rounds, with last evidence
## Parked — needs a human ({N}) — troubleshooter report paths
## Bounced to /deliver ({N}) — the printed /deliver lines
## Case looks outdated → /design-tests ({N})
## Regressions introduced ({N})
## Review — per repo: critical / non-critical counts, fix round applied?
## Branch — {branch}; worktrees: {paths}; committed: yes/no
```
Emit `run_end`. Print the Result line, the counts per section, the report path, and the branch. Relay runner verdicts as given.
