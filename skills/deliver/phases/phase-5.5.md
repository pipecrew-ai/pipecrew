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
{Choose ONE of the three blocks below based on spec_policy — substitute at dispatch time}

--- If spec_policy = "api-first":

ENDPOINTS IMPLEMENTED:
{list of endpoint paths + methods the Phase 5a implementer added or modified}

OPENAPI SPEC (authoritative contract — field-by-field drift is a Critical finding):
{absolute path to the service's spec file inside the worktree}

CONTRACT CHECK DIRECTIVE:
- Walk every new DTO / Pydantic model field-by-field against the spec schema; flag any drift as Critical.
- Walk endpoint implementations against spec method/path/status-codes/auth; flag any drift as Critical.

--- If spec_policy = "code-first":

ENDPOINTS IMPLEMENTED:
{list of endpoint paths + methods the Phase 5a implementer added or modified}

OPENAPI SPEC: — (no spec file for this service; the inline contract is authoritative)

INLINE CONTRACT (authoritative — copied from Phase 2 API_DESIGN for this service, byte-for-byte):
{paste the architect's full inline-contract block(s) for this service}

CONTRACT CHECK DIRECTIVE:
- There is NO OpenAPI spec for this service. The inline contract above IS the contract.
- Walk every new request/response type field-by-field against the inline contract; flag any drift as Critical.
- Walk endpoint implementations against the inline contract's method/path/status-codes/auth/error-shapes; flag any drift as Critical.
- DO NOT flag an implementation for "missing spec file" or "no $ref resolution" — these are legitimate absences for this service.

--- If spec_policy = "no-api":

HANDLERS IMPLEMENTED:
{list of handler names + their trigger source the Phase 5a implementer added or modified}

OPENAPI SPEC: — (worker — no HTTP endpoints)

EVENT CONTRACT (authoritative — event schemas from contract repos, edited in Phase 3a):
{paste the architect's full Event Triggers block(s) for this worker}

EVENT SCHEMA FILES:
- {absolute path to event schema file 1 in the contract repo worktree}
- {absolute path to event schema file 2 in the contract repo worktree}

CONTRACT CHECK DIRECTIVE:
- There is NO OpenAPI spec. The event schemas above are the contract.
- Walk every typed event model field-by-field against its schema file; flag any drift as Critical.
- Explicitly verify: idempotency mechanism present (flag missing as Critical), partial-failure reporting for batch triggers (flag missing as Critical for SQS/Kinesis batch), DLQ + retry config on deployment descriptor (flag missing as Non-critical with severity explanation).
- DO NOT flag "missing HTTP status codes" or "missing request body validation" — workers don't have those.

--- End contract-inputs switch

INSTRUCTIONS:
1. Read {service_worktree_path}/CLAUDE.md and the agent-context docs it points to (conventions, error-handling, database, and for workers: event handling / idempotency).
2. Apply the CONTRACT CHECK DIRECTIVE above.
3. Get the diff: cd into the worktree and run git diff against the appropriate base (merge-base with main or dev).
4. Walk each FR/EC and identify its enforcement point; flag any that are not enforced as Critical.
5. Run the craft, security, and test passes described in your system prompt.
6. **Verify each bullet in the task file's `## Known Pitfalls` section was actively avoided.** Treat the section as a checklist: for each pitfall, either cite the file:line where the implementation handled it, or flag the bullet as a Critical or Non-critical finding depending on severity. If the section is missing, flag that itself as a process issue.
7. Produce the report in the Output Format from your system prompt. Every finding must have file:line and a citation.

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
7. Produce the report in the Output Format from your system prompt. Every finding must have file:line and a citation.

Do not fix anything. Your output is a report the orchestrator will pass to an implementer for fix dispatch if needed.
```

**On completion of each reviewer**: save the report to `outputs/phase-5-5-code-review.md` (append one section per reviewed repo). Update the scratchpad with the review findings count.

#### Step 1.5: Persist each finding as a task file

After each reviewer returns, **parse the `<!-- BEGIN FINDINGS -->` / `<!-- END FINDINGS -->` block** at the end of its report (every code reviewer now emits this machine-readable block — see the spring-boot-code-reviewer and react-code-reviewer agent definitions). For each row:

```
critical | {short-title} | {file}:{line} | {one-line-problem}
```

Write one task file to `~/.claude/dal-pipeline/tasks/{feature-slug}-review-{severity}-{slug-of-title}.md`:

```markdown
---
id: {feature-slug}-review-{severity}-{slug-of-title}
phase: "5.5"
severity: "critical"  # or "non-critical"
status: "todo"        # "todo" → "done" after fix dispatch
repo: "{repo-name}"
agent: "spring-boot-code-reviewer"  # which reviewer produced this
target: "{file}:{line}"
created: "{ISO-date}"
---

# {short-title}

**Severity**: {severity}
**Target**: `{file}:{line}`
**Problem**: {one-line-problem}

**Full finding context**: see `~/.claude/dal-pipeline/outputs/phase-5-5-code-review.md` under the {repo} section.

## Fix plan
(Filled in when a fix dispatch is triggered — implementer writes the approach and resolution here.)
```
