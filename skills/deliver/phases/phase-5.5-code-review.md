### Phase 5.5: Per-repo Code Review

**Skip gate:** if `--no-review` was passed, skip this entire phase. Set Phase 5.5 status to SKIPPED in the scratchpad with reason "--no-review flag" and jump directly to Phase 6. Use this for small, low-risk features (e.g., adding a single read endpoint) where two reviewer dispatches are not worth the cost.

After all Phase 5 implementers finish, dispatch **code reviewers** against each repo that had code written, **except mock and infra**. The reviewers read the git diff of what the implementer just wrote, compare it against the requirements and the OpenAPI spec, and produce a structured report grouped into Critical, Non-critical, and Suggestions.

Reviewers **raise issues only** — they do not fix anything. If fixes are needed, the original implementer agents are re-dispatched with the reviewer's fix list.

This phase runs for:
- **Backend + Workers**: one reviewer per affected service whose repo type has a matching reviewer agent (see `TYPE_TO_AGENT` table in `dispatch-rules.md`). The reviewer prompt is shaped by the service's `spec_policy` (see Step 1).
- **Frontend**: one reviewer for the frontend worktree if Phase 5b ran. Type-aware via `TYPE_TO_AGENT` (`react` → `react-reviewer`, `nextjs` → `nextjs-reviewer`) — resolved from the frontend repo's `type` in config.
- **Infrastructure**: one reviewer per affected infra repo. Type-aware via `TYPE_TO_AGENT` (`cdk` → `cdk-reviewer`, `terraform` → `terraform-reviewer`). The reviewer's contract is the per-repo entry in the architect's `INFRASTRUCTURE_IMPACT` block (Phase 2); `spec_policy: infra`. The implementer's `cdk diff` (the delta — preferred; full `cdk synth` is the fallback) / `terraform plan` output is consumed as a verification artifact alongside the source diff. The reviewer NEVER runs `terraform apply` or `cdk deploy` — it produces findings only.

This phase is SKIPPED for:
- **Mock server** — mocks are transient and reviewed implicitly by the frontend tests consuming them
- **Services with no matching reviewer agent**: only fires for `other` / fallback-resolved types whose generated implementer has no paired reviewer. All plugin-shipped stack implementers (spring-boot, fastapi, flask, django, nestjs, python-worker, react, nextjs, cdk, terraform) now have paired reviewers. Log the skip with reason in the scratchpad: `"Phase 5.5 skipped {svc} — no reviewer agent for type {type}"` so the reporter can surface the gap at Phase 7.

**Precondition**: Before dispatching reviewers, confirm each worktree path recorded in the scratchpad's Implementation Tasks table still exists (`git -C {worktree_path} status`). If a worktree is missing, log it as a skip and do not dispatch a reviewer for that repo — a missing worktree means Phase 5 failed for that repo, which Phase 6 will flag as a blocker.

#### Step 1: Dispatch reviewers concurrently (background — process each as it finishes)

Dispatch every applicable reviewer as a **background** Agent (`run_in_background: true`), all in a single assistant message so they start at once. Record each dispatch's task handle keyed by repo.

**Why background, not a synchronous batch:** the gate lane is now fully pipelined (Step 2) — a repo's fix round, or its approval gate, fires the moment *that* reviewer finishes, without waiting for slower siblings. That only works if the orchestrator can observe reviewers completing one at a time. A synchronous parallel dispatch returns all results together (a barrier by construction), which would force the old wait-for-all behavior. Background dispatch + per-completion processing is what makes "surface each repo as its reviewer finishes" real.

As each background reviewer completes, the harness notifies you. **Process that reviewer immediately** (Step 1.5 → Step 2 for its repo) before the others finish — do not collect them into a batch. While you are blocked on one repo's gate, the remaining reviewers keep running in the background; their completions queue and are handled in turn once the current gate resolves.

**Pre-compute each repo's diff to a file — reviewers have no `Bash`.** Reviewers are dispatched with a `Read, Glob, Grep` tool grant only (no `Bash`, no `Edit`, no `Write`) so they are structurally incapable of mutating the worktree — that is the hard prevention for the reviewer-violates-read-only failure mode. Because they can't run `git diff` themselves, **before** each reviewer dispatch run the diff helper, which writes the diff to a file and prints only a byte-count (the diff body never enters your context):

```bash
node {plugin_dir}/scripts/write-review-diff.js --worktree={worktree_path} --out={run_dir}/review/{repo}.diff [--base={diff_base}]
```

Pass the resulting path (`{run_dir}/review/{repo}.diff`) into the reviewer prompt as its `DIFF FILE`. The reviewer `Read`s that file instead of running git. Omit `--base` to let the helper auto-resolve (origin/main → main → dev → master); pass it when the repo's base branch is non-standard.

**Backend / Worker reviewer — one per affected service (spec_policy-aware)**

Pull the structured services list from the architect's output (do NOT LLM-parse the prose Notes):

```bash
node {plugin_dir}/scripts/extract-block.js outputs/phase-2-architecture.md AFFECTED_SERVICES
```

For each entry in `services[]` (the `spec_policy` field is already there — no config lookup needed for that):

1. Resolve `type = config.repos[config.services[svc.name].repo].type`. The `policy` is `svc.spec_policy` from the JSON above.
2. Look up the reviewer `subagent_type` via the `TYPE_TO_AGENT` table in `dispatch-rules.md`. If the reviewer column is `—` for this type (no reviewer ships today), SKIP this service with the reason logged in the scratchpad and move on — do NOT dispatch spring-boot-reviewer as a fallback (it misreads non-Spring code).
3. Dispatch using the template below, but substitute the `## Contract inputs` block per the service's `spec_policy`.

**Tool**: `Agent`
**subagent_type**: {looked up per type — `spring-boot-reviewer` / `nestjs-reviewer` / etc., or SKIP}
**description**: `"Backend review — {service} — {feature-slug}"`
**prompt template**:

```
Review the backend implementation of feature "{feature_summary}" at `{service_worktree_path}` (branch `feature/{feature-slug}`). Read-only — produce a structured findings report only.

FEATURE: {feature_summary}

REQUIREMENTS TO VERIFY ENFORCEMENT OF:
{list of FR-X and EC-X — id + summary, enumerated from outputs/blocks/requirements-index.json — that this service owns}

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

ESTABLISHED PATTERNS (load as a review checklist — Invariant 8):
{workspace_root}/{slug}/context/platform.md  (read the § Established Patterns section)

NEAREST-SIBLING DESIGN DIFF (from Phase 2 — verify HC-2):
{paste the `### Nearest-sibling design diff` sub-section from the architect's ARCHITECTURE_DECISION block, or "none recorded" if the architect omitted it}

INSTRUCTIONS:
1. Read {service_worktree_path}/CLAUDE.md and the agent-context docs it points to (conventions, error-handling, database, and for workers: event handling / idempotency), AND the workspace `platform.md § Established Patterns`. Build a checklist from the applicable established patterns + repo conventions (Invariant 8) — freshly-learned conventions are first-class rules — and confirm the diff complies with each in your pattern-adherence pass.
2. Apply the contract compliance pass from your system prompt — the directive matching `spec_policy` above tells you exactly what to walk and what to flag. Then apply the two Hard checks from `reviewer-common.md`: **HC-1** (any schema-affecting ORM/`@Entity` change MUST have a matching migration in the diff — non-droppable, cite the existing changeset by file:line if you claim none is needed) and **HC-2** (a contract-shape divergence from the nearest sibling above with no recorded justification is a finding).
3. Read the diff: it is pre-computed at {run_dir}/review/{repo}.diff (DIFF FILE). Read that file — it is the complete set of changes to review. You have no Bash and never run git yourself; use Read/Glob/Grep over the worktree for any surrounding context a hunk needs.
4. Walk each FR/EC and identify its enforcement point; flag any that are not enforced as Critical.
5. Run the craft, security, and test passes described in your system prompt.
6. **Verify each bullet in the task file's `## Known Anti-Patterns` section was actively avoided.** Treat the section as a checklist: for each anti-pattern, either cite the file:line where the implementation handled it, or flag the bullet as a Critical or Non-critical finding depending on severity. If the section is missing, flag that itself as a process issue.
7. **Scope-drift check** — per your system prompt's scope-drift step: emit `## Scope findings` and add `scope` rows to the FINDINGS block.
8. **Classify every Critical finding** as `mechanical` or `architectural` — per your system prompt's classification step: add `**Classification**:` to each Critical prose entry and a 5th pipe field on every `critical` FINDINGS row.
9. Produce the report in the Output Format from your system prompt. Every finding must have file:line and a citation.

Do not fix anything. Your output is a report the orchestrator will pass to an implementer for fix dispatch if needed.

CRITICAL FOR THIS DISPATCH (do not skip — these are the rules most often forgotten):
- **FINDINGS_SUMMARY block first.** The first machine-readable block in your report MUST be `<!-- BEGIN FINDINGS_SUMMARY -->` containing the JSON counts (per `{plugin_dir}/templates/blocks/findings-summary.example.json`). The orchestrator's gate decision in Step 2 reads this — missing block forces a fallback row-count and logs a warning.
- **Classify every Critical.** Every Critical finding MUST carry `**Classification**: mechanical` or `**Classification**: architectural` in its prose entry, AND a 5th pipe field on its `critical` FINDINGS row. Missing classifications default to architectural — costs a user-gate round-trip.
- **Self-consistency.** FINDINGS_SUMMARY counts must equal actual rows in FINDINGS: `critical_mechanical + critical_architectural == critical_total`; `non_critical_total` == non-critical rows; `scope_total` == scope rows.
- **Hard checks are non-droppable.** HC-1 (modified ORM model / `@Entity` ⇒ matching migration in the diff) and HC-2 (unjustified contract-shape divergence from the nearest sibling) MUST NOT be downgraded to a false positive on a hunch. For HC-1 the only valid "no migration needed" outcome is citing the existing changeset by file:line; when uncertain, raise the Critical.
- **Established patterns are a checklist, not background reading.** Confirm the diff complies with each applicable rule in `platform.md § Established Patterns` and the repo conventions — a convention the team taught the pipeline via `/learn` is as binding as any older one.
- **Apply only your system-prompt passes.** Contract / craft / security / test / scope-drift are defined in your agent system prompt. Do not invent additional checks. Do not flag findings the prompt didn't authorize.
- **Read-only — structurally enforced.** Your tool grant is `Read, Glob, Grep` only: no `Bash`, no `Edit`, no `Write`. You cannot mutate the worktree, run git, apply a fix, or run a formatter/build. Output is the report only. (The orchestrator also re-checks the worktree is clean after you return.)

Now: review the diff in `{service_worktree_path}` for the feature, against the requirements and contract above.
```

**Frontend reviewer — one for the frontend**

Look up the reviewer via `TYPE_TO_AGENT`: resolve the frontend repo (`config.repos` where `role === "frontend"`), then map its `type` to the reviewer (`react` → `react-reviewer`, `nextjs` → `nextjs-reviewer`). Do NOT hardcode `react-reviewer`.

**Tool**: `Agent`
**subagent_type**: {looked up per the frontend repo's type}
**description**: `"Frontend review — {feature-slug}"`
**prompt template**:

```
Review the frontend implementation of feature "{feature_summary}" at `{frontend_worktree_path}` (branch `feature/{feature-slug}`). Read-only — produce a structured findings report only.

FEATURE: {feature_summary}

REQUIREMENTS TO VERIFY IMPLEMENTATION OF:
{list of FR-X and EC-X — id + summary, enumerated from outputs/blocks/requirements-index.json — that the frontend owns}

ENDPOINTS INTEGRATED:
{list of endpoints with their EXACT spec field names — this is the most important context for the reviewer}

SPEC FILES TO VALIDATE TYPES AGAINST:
{absolute paths to every OpenAPI spec the feature touches inside this worktree}

UX SPEC (to verify what was built matches what was designed):
{<!-- BEGIN IMPLEMENTATION_SPEC --> from the Phase 5b ux-consultant output}

ESTABLISHED PATTERNS (load as a review checklist — Invariant 8):
{workspace_root}/{slug}/context/platform.md  (read the § Established Patterns section)

NEAREST-SIBLING DESIGN DIFF (from Phase 2 — verify HC-2):
{paste the `### Nearest-sibling design diff` sub-section from the architect's ARCHITECTURE_DECISION block, or "none recorded" if the architect omitted it}

INSTRUCTIONS:
1. Read {frontend_worktree_path}/CLAUDE.md and the design-system + conventions + feature docs it points to, AND the workspace `platform.md § Established Patterns`. Build a checklist from the applicable established patterns + repo conventions (Invariant 8) — freshly-learned conventions are first-class rules — and confirm the diff complies with each in your pattern-adherence pass. Apply **HC-2**: a contract-shape divergence from the nearest sibling above (e.g. the client round-tripping an id the backend resolves server-side for the analogous feature) with no recorded justification is a finding.
2. Read the OpenAPI specs for every endpoint listed above — note the exact request/response field names, nullability, and enum values.
3. Read the diff: it is pre-computed at {run_dir}/review/{repo}.diff (DIFF FILE). Read that file — it is the complete set of changes to review. You have no Bash and never run git yourself; use Read/Glob/Grep over the worktree for any surrounding context a hunk needs.
4. Walk every new typed model field-by-field against its spec schema. Flag any drift as Critical.
5. Walk each FR/EC and identify its implementation point; flag any that are missing as Critical.
6. Run the framework-specific passes (typing, data fetching, routing, i18n/RTL, accessibility, tests) described in your system prompt.
7. **Scope-drift check** — per your system prompt's scope-drift step: emit `## Scope findings` and add `scope` rows to the FINDINGS block.
8. **Classify every Critical finding** as `mechanical` or `architectural` — per your system prompt's classification step: add `**Classification**:` to each Critical prose entry and a 5th pipe field on every `critical` FINDINGS row.
9. Produce the report in the Output Format from your system prompt. Every finding must have file:line and a citation.

Do not fix anything. Your output is a report the orchestrator will pass to an implementer for fix dispatch if needed.

CRITICAL FOR THIS DISPATCH (do not skip — these are the rules most often forgotten):
- **FINDINGS_SUMMARY block first.** The first machine-readable block in your report MUST be `<!-- BEGIN FINDINGS_SUMMARY -->` containing the JSON counts (per `{plugin_dir}/templates/blocks/findings-summary.example.json`). The orchestrator's gate decision in Step 2 reads this — missing block forces a fallback row-count and logs a warning.
- **Classify every Critical.** Every Critical finding MUST carry `**Classification**: mechanical` or `**Classification**: architectural` in its prose entry, AND a 5th pipe field on its `critical` FINDINGS row. Missing classifications default to architectural — costs a user-gate round-trip.
- **Self-consistency.** FINDINGS_SUMMARY counts must equal actual rows in FINDINGS: `critical_mechanical + critical_architectural == critical_total`; `non_critical_total` == non-critical rows; `scope_total` == scope rows.
- **Spec field-name fidelity.** Frontend types must match the OpenAPI spec field names byte-for-byte. Renaming a spec field (e.g., `bookId` → `id`) is a Critical type-drift finding. Walk every typed model field-by-field.
- **Established patterns are a checklist + HC-2 applies.** Confirm the diff complies with each applicable rule in `platform.md § Established Patterns` and the repo conventions (a `/learn`-taught convention is as binding as any older one), and flag an unjustified contract-shape divergence from the nearest sibling (HC-2).
- **Apply only your system-prompt passes.** Typing / data-fetching / routing / i18n / RTL / accessibility / tests / scope-drift are defined in your agent system prompt. Do not invent additional checks.
- **Read-only — structurally enforced.** Your tool grant is `Read, Glob, Grep` only: no `Bash`, no `Edit`, no `Write`. You cannot mutate the worktree, run git, apply a fix, or run a formatter/build. Output is the report only. (The orchestrator also re-checks the worktree is clean after you return.)

Now: review the diff in `{frontend_worktree_path}` for the feature, against the requirements and the spec field names above.
```

**On completion of each reviewer**: save the report to `outputs/phase-5-5-code-review.md` (append one section per reviewed repo). Update the scratchpad with the review findings count.

#### Step 1.4: Read-only backstop — assert the reviewer left the worktree clean

Immediately when a reviewer returns (before Step 1.5 / Step 2 for that repo), verify it did not mutate the worktree. With reviewers granted only `Read, Glob, Grep` this should be impossible — this check is defense-in-depth that also catches any pre-existing reviewer (an older cached agent that still has `Bash`) or a recipe drift:

```bash
git -C {worktree_path} status --porcelain
```

- **Clean (empty output)** → expected. Proceed to Step 1.5.
- **Dirty** → the reviewer mutated the tree (a violation). Revert it so the dirty state never reaches the fix-round implementer, then flag:
  ```bash
  git -C {worktree_path} stash --include-untracked   # or: git -C {worktree_path} checkout -- . && git -C {worktree_path} clean -fd
  ```
  Log to the scratchpad's Phase 5.5 row: `"⚠ {reviewer_agent} mutated {repo} during review (read-only violation) — reverted N files. Findings still consumed."` The reviewer's *findings* are still valid and proceed through Step 1.5 as normal; only its illicit edits are discarded. Surface the violation in the Phase 7 report so the agent grant can be audited (a reviewer that mutated despite a `Read, Glob, Grep`-only grant means a stale agent definition is loaded — prompt a `claude` restart / plugin reinstall).

#### Step 1.5: Persist each finding as a task file (per reviewer, the moment it completes)

This runs **once per reviewer, as that reviewer completes** — not in a batch after all are done. Immediately after persisting a reviewer's findings here, route its repo through Step 2 before moving to the next completion. Steps 1.5 → 2 → (3) form a per-repo chain that runs independently for each reviewer.

**Parse the `<!-- BEGIN FINDINGS -->` / `<!-- END FINDINGS -->` block** at the end of its report (every code reviewer now emits this machine-readable block — see the spring-boot-reviewer and react-reviewer agent definitions). The format is:

```
critical | {short-title} | {file}:{line} | {one-line-problem} | {mechanical|architectural}
non-critical | {short-title} | {file}:{line} | {one-line-problem}
scope | {short-title} | {file}:{line} | {one-line-problem}
```

Critical rows have a 5th pipe-field with `mechanical` or `architectural` (set by the reviewer per its system prompt's classification step — see the reviewer agent definition for the exact rules). Non-critical and scope rows have only 4 fields. The 5th field on criticals drives the gate decision in Step 2 below — store it in the task file's frontmatter so Step 2 can read it without re-parsing the FINDINGS blocks.

Write one task file per row to `{run_dir}/tasks/{feature-slug}-review-{severity}-{slug-of-title}.md`:

```markdown
---
id: {feature-slug}-review-{severity}-{slug-of-title}
phase: "5.5"
severity: "critical"          # or "non-critical" or "scope"
classification: "mechanical"  # or "architectural" — REQUIRED when severity=critical, OMIT for non-critical/scope
status: "todo"                # "todo" → "done" after fix dispatch
repo: "{repo-name}"
agent: "spring-boot-reviewer"  # which reviewer produced this
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

#### Step 2: Per-repo routing (pipelined — auto-approved repos dispatch as their reviewer finishes)

Findings arrive **per reviewer** — Step 1.5 persists each repo's task files the moment that repo's reviewer returns. Route each repo as soon as its findings are persisted; do NOT barrier on the slowest reviewer unless the repo actually needs your approval. A fast reviewer's fix round must not wait behind a slow sibling reviewer when no human decision gates it.

For each repo, pull its reviewer's pre-computed counts from the FINDINGS_SUMMARY block — do NOT re-count FINDINGS rows:

```bash
node {plugin_dir}/scripts/extract-block.js {repo_report_path} FINDINGS_SUMMARY
```

(returns `{critical_total, critical_mechanical, critical_architectural, non_critical_total, scope_total}` for that repo. Missing block → fall back to counting that repo's FINDINGS rows and log a warning. Schema in `{plugin_dir}/templates/blocks/block-schemas.md`.)

Classify the repo into exactly one lane:

| Repo's findings | Lane | Action |
|---|---|---|
| `critical_total == 0` | **clean** | No fix round for this repo. Mark its Phase 5.5 row COMPLETED. |
| `critical_total > 0` AND no approval is needed for this repo — i.e. **gates are disabled** for this run (autonomous / trust mode), OR `--auto-fix-mechanical` is set AND this repo's `critical_architectural == 0` | **auto** | **Dispatch this repo's fix round NOW (Step 3) — pipelined. Do not wait for sibling reviewers.** Before dispatching under `--auto-fix-mechanical`, re-read each mechanical task's Problem; if any starts with "decide whether" / "requires changing the approach", re-classify it architectural and move this repo to the **gate** lane instead. Log: `"Pipelined fix round — {repo}, {N} auto-approved criticals, no gate."` |
| `critical_total > 0` AND not in the **auto** lane (an architectural critical with gates enabled, OR `--auto-fix-mechanical` not set) | **gate** | **Open this repo's approval gate NOW — do not wait for sibling reviewers.** Surface this one repo for the user's decision the moment its reviewer finishes (see per-repo gate below). |

**"Gates disabled"** = the run is in a mode where Phase 5.5's fix-round approval is never shown, regardless of classification (autonomous / trust mode — see `docs/design/autonomy-trust-mode.md`; or an explicit autonomous flag if one is wired). In a normal interactive run gates are NOT disabled, so without `--auto-fix-mechanical` every repo with criticals lands in the **gate** lane — but each gate now fires per-repo as its reviewer finishes, not as one consolidated prompt at the end.

**Per-repo gate (gate lane):** open a gate scoped to **this single repo** as soon as its reviewer completes — the user can approve it and start its fix round while other reviewers are still running. Open per SKILL.md rule #5 (`node {plugin_dir}/scripts/gate.js open --run-dir={run_dir} --phase=5.5 --gate=approval --question="..."`), using this repo's counts only:

```
Phase 5.5 — {repo}: {critical_total} critical issue(s) need your approval.
  - {critical_mechanical} mechanical
  - {critical_architectural} architectural (need your judgment)
{non_critical_total} non-critical, {scope_total} scope findings in this repo.

Dispatch the fix round for {repo}? (yes / no / show details)
```

On the answer: `yes` → close gate, dispatch THIS repo's fix round (Step 3) immediately. `no` → close gate, mark this repo COMPLETED with note `"user declined fix round, {critical_total} criticals deferred to follow-up"`. `show details` → print this repo's finding list, re-prompt. Always close the gate (`gate.js close`) before moving on so the UI's yellow banner clears.

**Only one gate is open at a time.** `awaiting_input.json` is per-run, so two repos can't hold a gate simultaneously. Process completed reviewers in arrival order: open repo A's gate → user answers → close → dispatch A's fix (it runs in the background) → then handle the next completed reviewer (open B's gate, etc.). A's fix round and B's gate overlap; you never block a finished reviewer behind a still-running one.

**When all reviewers have completed and all gates are resolved:** if every gate-lane repo was answered and every auto/clean repo handled, set Phase 5.5 COMPLETED and continue to Phase 5.75 / 6. There is no end-of-phase consolidated gate — approvals happened incrementally as findings arrived.

**Default interactive run, single repo:** identical to before — one reviewer, one gate, one decision. The pipelining only changes multi-repo runs, where you now get one focused prompt per critical-finding repo as each reviewer finishes instead of one big prompt after the slowest.

#### Step 3: Fix-round dispatch

Step 3 is invoked **per repo**, always for one repo at a time, from Step 2: immediately for each **auto**-lane repo (the moment its reviewer finishes), and for each **gate**-lane repo the moment the user approves its per-repo gate. It is the same dispatch either way — only the trigger differs. Mock and infra repos still skip (no reviewer ran for them).

> **Parallelism note:** each fix round is dispatched as soon as its repo is cleared (auto-routed or gate-approved) — one repo per message, fired immediately, never held back to batch with others. Because fix rounds run as background Agent dispatches against separate worktrees (no contention), multiple repos' fix rounds naturally overlap: repo A's fix runs while you answer repo B's gate. Pipelining, not batching, is the goal.

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

3. **Dispatch — one repo, immediately, as a background Agent (`run_in_background: true`).** Fire this repo's fix round the instant it's cleared (auto-routed or gate-approved); do not hold it to batch with other repos. A single repo per dispatch is expected and correct — overlap comes from the background dispatches running concurrently against separate worktrees, not from batching them into one message. This holds for both lanes: the auto lane fires on reviewer completion, the gate lane fires on the user's `yes`.

4. **Per-round artifacts**: save each implementer's report to `{run_dir}/fix-rounds/round-1/{repo-name}.md`. If a second round runs (e.g., user re-triggers after another review), the directory becomes `round-2/`, etc.

5. **On completion**: parse each implementer's report. If any fix-list item is reported "skipped" or "failed", record it in the scratchpad's Phase 5.5 row for human follow-up — do not silently swallow. Update the scratchpad's Phase 5.5 status to:
   - `COMPLETED` if all fix-list items reported done
   - `COMPLETED ⚠` if any items were skipped/failed (note the count)

   **Commit the fix round** (only if it changed files): the fix modifies files already captured by the Phase-5 task commit(s), so give it its own follow-up commit rather than leaving the worktree dirty for Phase 8. This keeps the review-fix visible as a distinct, honest step in the PR:
   ```bash
   git -C {worktree_path} add -A
   git -C {worktree_path} commit -q -m "fix({repo-short}): address review [round-{N}]"
   ```
   If the fix round made no file changes (all items skipped/failed), skip the commit. Record the SHA in the scratchpad's Phase 5.5 row.

6. **One fix round per run.** Re-review does not auto-run. If issues remain after the fix round, record them in the scratchpad and report them at Phase 7 — do not auto-re-dispatch. If the user wants a second round, they re-run `/deliver --resume` after inspecting.

**Phase exit:** Phase 5.5 is done when every reviewer has completed, every gate-lane repo has been answered, and every dispatched (auto- or gate-lane) fix round has returned. Because fix rounds are background dispatches, wait for the outstanding ones to finish before advancing. Then continue to Phase 5.75 (security review, if triggered) or Phase 6 (assessment).
