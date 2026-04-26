### Phase 5.5: Per-repo Code Review

**Skip gate:** if `--no-review` was passed, skip this entire phase. Set Phase 5.5 status to SKIPPED in the scratchpad with reason "--no-review flag" and jump directly to Phase 6. Use this for small, low-risk features (e.g., adding a single read endpoint) where two reviewer dispatches are not worth the cost.

After all Phase 5 implementers finish, dispatch **code reviewers** against each repo that had code written, **except mock and infra**. The reviewers read the git diff of what the implementer just wrote, compare it against the requirements and the OpenAPI spec, and produce a structured report grouped into Critical, Non-critical, and Suggestions.

Reviewers **raise issues only** — they do not fix anything. If fixes are needed, the original implementer agents are re-dispatched with the reviewer's fix list.

This phase runs for:
- **Backend + Workers**: one reviewer per affected service whose repo type has a matching reviewer agent (see `TYPE_TO_AGENT` table in `dispatch-rules.md`). The reviewer prompt is shaped by the service's `spec_policy` (see Step 1).
- **Frontend**: one `react-code-reviewer` for the frontend worktree if Phase 5b ran

This phase is SKIPPED for:
- **Mock server** — mocks are transient and reviewed implicitly by the frontend tests consuming them
- **Infrastructure — CDK**: verified by `cdk synth` and by Phase 6 cross-stack reference checks
- **Infrastructure — Terraform**: the `terraform plan` output produced by `terraform-implementer` is itself the review artifact; a human reviews it before any `terraform apply`
- **Services with no matching reviewer agent**: fastapi, flask, django, python-worker, nextjs (where no `*-reviewer` exists today). Log the skip with reason in the scratchpad: `"Phase 5.5 skipped {svc} — no reviewer agent for type {type}"` so the reporter can surface the gap at Phase 7.

**Precondition**: Before dispatching reviewers, confirm each worktree path recorded in the scratchpad's Implementation Tasks table still exists (`git -C {worktree_path} status`). If a worktree is missing, log it as a skip and do not dispatch a reviewer for that repo — a missing worktree means Phase 5 failed for that repo, which Phase 6 will flag as a blocker.

#### Step 1: Dispatch reviewers in parallel

All applicable reviewers go in a single assistant message so they run concurrently.

**Backend / Worker reviewer — one per affected service (spec_policy-aware)**

For each service in `AFFECTED_SERVICES`:

1. Resolve `type = config.repos[config.services[svc].repo].type` and `policy = config.services[svc].spec_policy` (default `api-first`).
2. Look up the reviewer `subagent_type` via the `TYPE_TO_AGENT` table in `dispatch-rules.md`. If the reviewer column is `—` for this type (no reviewer ships today), SKIP this service with the reason logged in the scratchpad and move on — do NOT dispatch spring-boot-code-reviewer as a fallback (it misreads non-Spring code).
3. Dispatch using the template below, but substitute the `## Contract inputs` block per the service's `spec_policy`.

**Tool**: `Agent`
**subagent_type**: {looked up per type — `spring-boot-code-reviewer` / `nestjs-reviewer` / etc., or SKIP}
**description**: `"Backend review — {service} — {feature-slug}"`
**prompt template**:

```
You are reviewing the backend implementation in the worktree at {service_worktree_path} (branch: feature/{feature-slug}). Work read-only.

FEATURE: {feature_summary}

REQUIREMENTS TO VERIFY ENFORCEMENT OF:
{list of FR-X and EC-X from outputs/phase-1-requirements.md that this service owns}

## Contract inputs
spec_policy: {api-first | code-first | no-api}

{Substitute the matching input shape below at dispatch time. Contract-check directives live in your system prompt's "Contract compliance pass (depends on `spec_policy`)" section — apply the matching one to these inputs.}

--- If spec_policy = "api-first":

ENDPOINTS IMPLEMENTED:
{list of endpoint paths + methods the Phase 5a implementer added or modified}

OPENAPI SPEC:
{absolute path to the service's spec file inside the worktree}

--- If spec_policy = "code-first":

ENDPOINTS IMPLEMENTED:
{list of endpoint paths + methods}

INLINE CONTRACT (copied byte-for-byte from Phase 2 API_DESIGN for this service):
{paste the architect's full inline-contract block(s) for this service}

--- If spec_policy = "no-api":

HANDLERS IMPLEMENTED:
{list of handler names + trigger source}

EVENT CONTRACT (Event Triggers from Phase 2 API_DESIGN):
{paste the architect's full Event Triggers block(s) for this worker}

EVENT SCHEMA FILES:
- {absolute path to event schema file 1 in the contract repo worktree}
- {absolute path to event schema file 2 in the contract repo worktree}

--- End contract-inputs switch

INSTRUCTIONS:
1. Read {service_worktree_path}/CLAUDE.md and the agent-context docs it points to (conventions, error-handling, database, and for workers: event handling / idempotency).
2. Apply the contract compliance pass from your system prompt — the directive matching `spec_policy` above tells you exactly what to walk and what to flag.
3. Get the diff: cd into the worktree and run git diff against the appropriate base (merge-base with main or dev).
4. Walk each FR/EC and identify its enforcement point; flag any that are not enforced as Critical.
5. Run the craft, security, and test passes described in your system prompt.
6. **Verify each bullet in the task file's `## Known Pitfalls` section was actively avoided.** Treat the section as a checklist: for each pitfall, either cite the file:line where the implementation handled it, or flag the bullet as a Critical or Non-critical finding depending on severity. If the section is missing, flag that itself as a process issue.
7. **Scope-drift check** — per your system prompt (step 7): emit `## Scope findings` and add `scope` rows to the FINDINGS block.
8. **Classify every Critical finding** as `mechanical` or `architectural` — per your system prompt (step 8): add `**Classification**:` to each Critical prose entry and a 5th pipe field on every `critical` FINDINGS row.
9. Produce the report in the Output Format from your system prompt. Every finding must have file:line and a citation.

Do not fix anything. Your output is a report the orchestrator will pass to an implementer for fix dispatch if needed.
```

**Frontend reviewer — one for the frontend**

**Tool**: `Agent`
**subagent_type**: `react-code-reviewer`
**description**: `"Frontend review — {feature-slug}"`
**prompt template**:

```
You are reviewing the React frontend implementation in the worktree at {frontend_worktree_path} (branch: feature/{feature-slug}). Work read-only.

FEATURE: {feature_summary}

REQUIREMENTS TO VERIFY IMPLEMENTATION OF:
{list of FR-X and EC-X from outputs/phase-1-requirements.md that the frontend owns}

ENDPOINTS INTEGRATED:
{list of endpoints with their EXACT spec field names — this is the most important context for the reviewer}

SPEC FILES TO VALIDATE TYPES AGAINST:
- {frontend_worktree_path}/src/api/publisher-api-specs.YAML
- {frontend_worktree_path}/src/api/backoffice-api-specs.yaml
(and any other specs the feature touches)

UX SPEC (to verify what was built matches what was designed):
{<!-- BEGIN IMPLEMENTATION_SPEC --> from the Phase 5b ux-consultant output}

INSTRUCTIONS:
1. Read {frontend_worktree_path}/CLAUDE.md and the design-system + conventions + feature docs it points to.
2. Read the OpenAPI specs for every endpoint listed above — note the exact request/response field names, nullability, and enum values.
3. Get the diff: cd into the worktree and run git diff against the appropriate base.
4. Walk every new type in src/api/types/ field-by-field against its spec schema. Flag any drift as Critical.
5. Walk each FR/EC and identify its implementation point; flag any that are missing as Critical.
6. Run the React Query, TypeScript, i18n/RTL, accessibility, and test passes described in your system prompt.
7. **Scope-drift check** — per your system prompt (step 12): emit `## Scope findings` and add `scope` rows to the FINDINGS block.
8. **Classify every Critical finding** as `mechanical` or `architectural` — per your system prompt (step 13): add `**Classification**:` to each Critical prose entry and a 5th pipe field on every `critical` FINDINGS row.
9. Produce the report in the Output Format from your system prompt. Every finding must have file:line and a citation.

Do not fix anything. Your output is a report the orchestrator will pass to an implementer for fix dispatch if needed.
```

**On completion of each reviewer**: save the report to `outputs/phase-5-5-code-review.md` (append one section per reviewed repo). Update the scratchpad with the review findings count.

#### Step 1.5: Persist each finding as a task file

After each reviewer returns, **parse the `<!-- BEGIN FINDINGS -->` / `<!-- END FINDINGS -->` block** at the end of its report (every code reviewer now emits this machine-readable block — see the spring-boot-code-reviewer and react-code-reviewer agent definitions). The format is:

```
critical | {short-title} | {file}:{line} | {one-line-problem} | {mechanical|architectural}
non-critical | {short-title} | {file}:{line} | {one-line-problem}
scope | {short-title} | {file}:{line} | {one-line-problem}
```

Critical rows have a 5th pipe-field with `mechanical` or `architectural` (set by the reviewer in Step 8 of the dispatch prompt). Non-critical and scope rows have only 4 fields. The 5th field on criticals drives the gate decision in Step 2 below — store it in the task file's frontmatter so Step 2 can read it without re-parsing the FINDINGS blocks.

Write one task file per row to `{run_dir}/tasks/{feature-slug}-review-{severity}-{slug-of-title}.md`:

```markdown
---
id: {feature-slug}-review-{severity}-{slug-of-title}
phase: "5.5"
severity: "critical"          # or "non-critical" or "scope"
classification: "mechanical"  # or "architectural" — REQUIRED when severity=critical, OMIT for non-critical/scope
status: "todo"                # "todo" → "done" after fix dispatch
repo: "{repo-name}"
agent: "spring-boot-code-reviewer"  # which reviewer produced this
target: "{file}:{line}"
created: "{ISO-date}"
---

# {short-title}

**Severity**: {severity}
**Classification**: {mechanical|architectural}    <!-- omit for non-critical / scope -->
**Target**: `{file}:{line}`
**Problem**: {one-line-problem}

**Full finding context**: see `{run_dir}/outputs/phase-5-5-code-review.md` under the {repo} section.

## Fix plan
(Filled in when a fix dispatch is triggered — implementer writes the approach and resolution here.)
```

If a `critical` row arrives without a 5th field, treat the missing classification as `architectural` (conservative default — forces the user gate). Log a warning so the reviewer agent prompt can be tightened later.

#### Step 2: Gate decision

Once Step 1.5 has persisted every finding as a task file, count across all reviewer reports:

- `critical_total` — every `critical` row in every reviewer's FINDINGS block
- `critical_mechanical` — subset where the 5th field is `mechanical` (or the task file's frontmatter `classification: "mechanical"`)
- `critical_architectural` — `critical_total - critical_mechanical`
- `non_critical_total` — every `non-critical` row
- `scope_total` — every `scope` row

Branch on the counts:

| Condition | Action |
|---|---|
| `critical_total == 0` | **No fix round.** Set Phase 5.5 status to COMPLETED. Skip Step 3. Continue to next phase (5.75 or 6). |
| `critical_total > 0` AND `--auto-fix-mechanical` was passed AND `critical_architectural == 0` | **Verify then auto-dispatch.** Re-read each "mechanical" task file's Problem field. If any description starts with "decide whether" or "requires changing the approach", re-classify it as `architectural` and fall through to the user gate instead. Otherwise skip the gate, proceed to Step 3. Log: `"Auto-dispatching fix round — {N} mechanical criticals, --auto-fix-mechanical set. No user gate."` |
| Otherwise (any architectural critical, OR `--auto-fix-mechanical` not set) | **User gate.** Open the gate per SKILL.md rule #5 (use `node {plugin_dir}/scripts/gate.js open ...`). Show the summary below. On the user's answer: `yes` → close gate, proceed to Step 3. `no` → close gate, set Phase 5.5 COMPLETED with note `"user declined fix round, {critical_total} criticals deferred to follow-up"`, continue. `show details` → print per-repo finding lists, re-prompt. |

**Gate summary template**:

```
Phase 5.5 found {critical_total} critical issues across {repo_count} repo(s):
  - {critical_mechanical} mechanical (auto-fixable with --auto-fix-mechanical)
  - {critical_architectural} architectural (need your judgment)
{non_critical_total} non-critical, {scope_total} scope findings.

Dispatch fix round? (yes / no / show details)
```

Always close the gate before proceeding (`gate.js close`) so the pipeline-view UI's yellow waiting banner clears.

#### Step 3: Fix-round dispatch

Run for each repo that has at least one critical or scope task file from Step 1.5. Mock and infra repos still skip (no reviewer ran for them).

1. **Build the fix list per repo.** Read every task file under `{run_dir}/tasks/` whose frontmatter has `phase: "5.5"`, `status: "todo"`, and `repo: <this repo>`. Collect them into an ordered list (criticals first, then scope, then non-criticals).

2. **Re-dispatch the original implementer.** Look up the implementer's `subagent_type` via the `TYPE_TO_AGENT` table in `dispatch-rules.md` (the same lookup Phase 5 used). Use this prompt template:

```
You are running a FIX ROUND on the implementation in the worktree at {worktree_path} (branch: feature/{feature-slug}).

The code reviewer flagged the following issues. Apply each fix, then re-test.

FIX LIST (from {reviewer_agent}):
{for each review-task-file in this repo's list:}
- [{severity}{ - classification if critical}] {file}:{line} — {one-line-problem} (task: {run_dir}/tasks/{task-id}.md)

INSTRUCTIONS:
1. For each fix-list entry, Read the corresponding task file for the full reviewer context (Problem, Target, link to the review report).
2. Apply the fix at the cited file:line. Cite by R6 — do NOT touch lines outside the fix list.
3. After all fixes, re-run the repo's test command (`mvn test` / `npm test` / `pytest` — whatever the stack uses).
4. Update each fix task's frontmatter: `status: todo` → `status: done` after applying. Bump `updated_at` to the current UTC ISO-8601 timestamp.
5. Report what you changed in the standard report format (files modified, FR/EC coverage map, test results, commands run).

Per common-rules R6 (scope discipline): touch ONLY the lines the fix list cites. Do not refactor adjacent code, do not add unrequested improvements, do not "while-I'm-here" anything. Per R7, if any fix-list entry is ambiguous (the reviewer's one-liner doesn't tell you exactly what to change), emit an `## Assumptions` block before writing code.
```

3. **Dispatch all repos' fix rounds in the same assistant message** so they run in parallel — they touch different worktrees, no contention.

4. **Per-round artifacts**: save each implementer's report to `{run_dir}/fix-rounds/round-1/{repo-name}.md`. If a second round runs (e.g., user re-triggers after another review), the directory becomes `round-2/`, etc.

5. **On completion**: parse each implementer's report. If any fix-list item is reported "skipped" or "failed", record it in the scratchpad's Phase 5.5 row for human follow-up — do not silently swallow. Update the scratchpad's Phase 5.5 status to:
   - `COMPLETED` if all fix-list items reported done
   - `COMPLETED ⚠` if any items were skipped/failed (note the count)

6. **One fix round per run.** Re-review does not auto-run. If issues remain after the fix round, record them in the scratchpad and report them at Phase 7 — do not auto-re-dispatch. If the user wants a second round, they re-run `/deliver --resume` after inspecting.

After Step 3 completes (or Step 2 short-circuited to COMPLETED), continue to Phase 5.75 (security review, if triggered) or Phase 6 (assessment).
