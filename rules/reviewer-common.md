# Reviewer common rules — framework-agnostic

> Every `*-reviewer.md` agent in this plugin references this document. The invariants, process, output format, and findings schema below are universal — they apply regardless of tech stack (Spring Boot, NestJS, FastAPI, React, Python worker, …). Stack-specific anti-patterns live in `{plugin_dir}/anti-patterns/{type}.md` and are folded into Step 5 of the per-stack reviewer.

These rules compose on top of each reviewer's stack-specific Step 5. Where a shared rule conflicts with a repo-specific convention surfaced in `CLAUDE.md` or `agent-context/`, the repo convention wins for that repo — but in practice they should agree.

> **Notation used throughout this document and the pipeline:**
> `FR-X` = a **functional requirement** ID (e.g. FR-1, FR-2) assigned by the product-owner in Phase 1. It names something the feature must do.
> `EC-X` = an **edge case** ID (e.g. EC-1, EC-2) from the same Phase 1 output. It names a boundary condition or failure mode the feature must handle.
> `spec_policy` = `api-first` (OpenAPI spec is the contract) / `code-first` (architect-inlined contract) / `no-api` (event-driven worker; event schemas are the contract). Set by the dispatch.

---

## Invariants

1. **Review against the repo's actual conventions**, not generic stack best practices. Read `CLAUDE.md` and the agent-context docs it points to before forming any opinion. If the repo pins a library, a DI style, an error-handler shape, or a test framework, enforce those — do not substitute your own preferences.
2. **The contract is the source of truth.** For `api-first` the OpenAPI spec; for `code-first` the architect's inline contract; for `no-api` the event schema files. Request/response/event models must match exactly — same field names, same nullability, same enum values. Any drift is a Critical finding.
3. **Every functional requirement (FR-X) must have an enforcement point.** Walk through the FR list and name the file:line that enforces each. If a requirement has no identifiable enforcement, that is a Critical finding.
4. **Every edge case (EC-X) must have a test or a guard** — preferably both. If an edge case has neither, that's a Critical finding.
5. **Cite, don't assert.** Every finding must point to concrete code (file:line) and — where relevant — a specific requirement, convention, spec element, or event schema field. "This is wrong" is not acceptable; "line 42 names the field `bookId` but the spec schema names it `book_id` — the generated client will not deserialize it" is.
6. **Raise issues, don't fix them.** Do not produce code modifications. You may include short illustrative snippets to explain a finding, but the fix itself is the implementer's job.

---

## Implementer-common rules you enforce

Implementers operate under `{plugin_dir}/rules/implementer-common.md` (R0–R10). The reviewer enforces a subset of those rules on the code it reviews. Below is the canonical mapping — what to check, where, and how to grade the finding. Use this as a checklist alongside the per-stack Step 5 patterns.

| Implementer rule | Reviewer enforcement | Severity |
|---|---|---|
| **R4** Security tests when auth/role enforcement changes | If the diff modifies any auth/permission/role guard (new endpoint with auth, new permission class, new role check, etc.), there MUST be a test exercising both the authorized and unauthorized paths. Missing test → **Critical** | Critical |
| **R5** Documentation updates are part of done | When the diff introduces a **new pattern, new library, new architectural decision, or new top-level directory**, the implementer is bound by R5 to also update the relevant docs: `CLAUDE.md`, `agent-context/conventions.md` (or stack-specific subfile), `DESIGN_SYSTEM.md` (frontend), or `platform.md § Architect Guidance` (architectural). If the diff has the new pattern but no doc update → **Non-critical** (call it out in the report so the implementer can backfill in fix-round). If the diff has the new pattern AND an `## Assumptions` block records the decision AND no doc update → still **Non-critical** (the implementer escaped R10 but is still on the hook for R5) | Non-critical |
| **R6** Scope discipline | Walk every non-trivial diff hunk and find its FR-X / EC-X trace. Hunks with no trace go in `## Scope findings`. Hunks matching the task file's `## Out of Scope` section are **Critical scope violations**. Add a `scope` row to the FINDINGS block for each | Critical (Out-of-Scope) / Non-critical (untraced) |
| **R7** State assumptions before coding | When the implementer deviates from a pattern (whether per R10's escape valve, or per the "this repo's pattern is itself a documented anti-pattern" escape valve), the deviation MUST be recorded in an `## Assumptions` block in the implementer's report. If the diff shows deviation but no Assumptions block exists → **Non-critical** (the deviation may still be correct, but the rationale is missing from the audit trail). The Assumptions block does NOT excuse silent invention — it documents an INTENTIONAL deviation | Non-critical |
| **R9** Verify requirement coverage | The `## Requirement coverage map` section of your report exists specifically to enforce R9. Every FR/EC must appear with its enforcement point. Use Invariant 3 above | Critical (missing FR) |
| **R10** Inherit, don't invent | Walk new files / non-trivial new code blocks and ask: does an analogous existing file in this repo use the same pattern? Look for: new module/component/service/repository with different shape than the repo's existing ones (Non-critical for cosmetic drift, Critical for structural drift); new dependency in the package manifest not previously used (Non-critical for small additions, Critical for new major libraries — new ORM, new validation library, new test framework); new top-level directory without precedent (Critical); new framework usage (Critical). If the implementer recorded the invention in an `## Assumptions` block per R10's escape valve, accept it but call it out as a Suggestion. Add a `non-critical \| pattern-{title} \| {file}:{line} \| {one-line}` (or `critical \| … \| architectural`) row to the FINDINGS block for every adherence violation | Non-critical / Critical |

Rules NOT in scope for the reviewer (these are implementer-runtime concerns the reviewer cannot meaningfully check from a diff):

- **R0** Task file is source of truth — runtime contract, not visible in the diff.
- **R1** Read CLAUDE.md first — runtime ordering, not visible in the diff.
- **R2** Validate config files — orchestrator validates separately.
- **R3** `git status` hygiene — orchestrator checks pre-commit.
- **R8** Stay in launched worktree — orchestrator enforces.

---

## Process

The reviewer follows this 11-step process. Step 5 is the **only** stack-specific step — every per-stack reviewer plugs in its own patterns there. The other 10 steps are universal.

1. **Read `CLAUDE.md`** and the repo's conventions docs (and `agent-context/` if pointed to).
2. **Get the diff** — `git diff` against the base branch.
3. **Walk each FR/EC** and identify its enforcement point. Flag any missing as Critical.
4. **Contract compliance pass — depends on `spec_policy` from the dispatch.** The dispatch's `## Contract inputs` block sets `spec_policy: <api-first|code-first|no-api>`. Apply the matching directive:
   - **`api-first`** (spec file provided) — read the spec for the affected endpoints. Walk every new request/response model field-by-field against the spec schema; walk endpoint paths/methods/status-codes/auth against the spec. Drift = Critical.
   - **`code-first`** (no spec; inline contract block provided) — treat the inline contract as the spec. Walk every new model and endpoint implementation field-by-field against it. Drift = Critical. DO NOT flag "missing spec file" or "no $ref resolution".
   - **`no-api`** (event worker; event schema file paths provided) — walk every typed event model field-by-field against its schema file. Drift = Critical. Verify idempotency guard present (missing = Critical), partial-failure reporting on batch triggers (missing = Critical), DLQ + retry config (missing = Non-critical). DO NOT flag "missing HTTP status codes" or "missing request body validation".
5. **Stack-specific patterns** — see the per-stack reviewer's body. Consult the matching `{plugin_dir}/anti-patterns/{type}.md` catalog and flag any match in the diff.
6. **Check test coverage** (includes **R4 enforcement**):
   - Unit tests for every new service / domain function; integration tests for every new endpoint / handler.
   - Tests must assert on **outcomes** (response status, response body fields, database state, downstream effects, emitted events) not on **implementation details** (mock-call counts, internal method spies). Tests that assert HOW the code runs instead of WHAT it produces → **Non-critical**.
   - Test fixtures and request payloads must use the contract's field names, not internal type shapes. Wrong field names in test data = future production break → **Critical**.
   - Missing test for a new code path → **Non-critical**.
   - **R4 enforcement** — if the diff modifies any auth/role/permission guard, the diff MUST include a test covering both authorized and unauthorized paths. Missing test for an auth-change code path → **Critical**.
7. **Scope-drift check (R6 enforcement)** — see the implementer-common-rules table above. Walk every non-trivial diff hunk and find its FR-X / EC-X trace. Hunks with no trace go in `## Scope findings`. Hunks matching the task file's `## Out of Scope` section are Critical scope violations. Add a `scope` row to the FINDINGS block for each.
8. **Pattern adherence pass (R10 enforcement)** — see the implementer-common-rules table above. Walk new files / non-trivial new code blocks and ask: does an analogous existing file in this repo use the same pattern? Apply the severity grading in the table.
9. **Assumptions block check (R7 enforcement)** — if Step 8 surfaced a deviation that the implementer's report records under `## Assumptions`, accept it as intentional and mark its Step 8 finding as a Suggestion. If Step 8 surfaced a deviation and there is no Assumptions block, the deviation is **Non-critical** (per the table) — call it out so the audit trail can be completed.
10. **Documentation update check (R5 enforcement)** — if Step 5 or Step 8 surfaced a new pattern / new library / new architectural decision / new top-level directory, walk the diff for an accompanying doc update (`CLAUDE.md`, `agent-context/`, `DESIGN_SYSTEM.md` for frontend, `platform.md § Architect Guidance` for workspace-level decisions). Missing doc update → **Non-critical**. Use the severity in the table above.
11. **Classify every Critical finding** as `mechanical` (fix is "change X to Y", no design judgment) or `architectural` (needs design decision or cross-file refactor). When in doubt: `architectural`. Add a `**Classification**:` line to each Critical's prose entry AND a 5th pipe field on every `critical` FINDINGS row.
12. **Produce the report** in the Output Format below.

---

## Output Format

```markdown
# {Stack} Code Review — {feature name}

## Scope
- **Repo**: {repo_path}
- **Branch**: {branch} vs {base}
- **Files reviewed**: {N}
- **Trigger type(s)** (workers only): {sqs / sns / kinesis / kafka / schedule / celery / lambda-direct — from dispatch}
- **Contract(s)**: {spec file path | "inline (code-first)" | event schema file paths}

## Requirement coverage map
| Requirement | Enforcement point | Status |
|-------------|-------------------|--------|
| FR-1 | {file}:{line} | ✅ enforced |
| EC-2 | {file}:{line} | ✅ guarded + tested |
| FR-3 | — | ❌ missing |

## Critical findings
### 1. [Short title]
- **File**: path:line
- **Requirement**: FR-X / spec schema / event schema field / convention
- **Classification**: `mechanical` | `architectural` (REQUIRED — Step 11)
- **Problem**: [what is wrong]
- **Suggested fix direction**: [one sentence]

## Non-critical findings
### 1. ...

## Scope findings
### 1. ...

## Suggestions
### 1. ...

## Summary
- **Critical**: {count}
- **Non-critical**: {count}
- **Scope**: {count}
- **Suggestions**: {count}
- **Overall**: {PASS / NEEDS FIXES / BLOCKED}

## Machine-readable findings list

Emit the summary first (counts pre-computed for the orchestrator's gate decision), then the per-finding rows.

<!-- BEGIN FINDINGS_SUMMARY -->
```json
{ ... matches {plugin_dir}/templates/blocks/findings-summary.example.json ... }
```
<!-- END FINDINGS_SUMMARY -->

<!-- BEGIN FINDINGS -->
critical | {short-title} | {file}:{line} | {one-line-problem} | {mechanical|architectural}
non-critical | {short-title} | {file}:{line} | {one-line-problem}
scope | {short-title} | {file}:{line} | {one-line-problem}
<!-- END FINDINGS -->
```

**Severity vocabulary** is exactly `critical`, `non-critical`, or `scope` (lowercase, hyphen-separated).
**Self-consistency** — `FINDINGS_SUMMARY` counts MUST equal actual rows in `FINDINGS`:
- `critical_mechanical + critical_architectural == critical_total`
- `non_critical_total` == non-critical rows
- `scope_total` == scope rows

**Critical rows** carry a 5th pipe field with `mechanical` or `architectural`. The orchestrator uses it to decide whether the fix-round can skip the user gate. Non-critical and scope rows omit the 5th field.

A missing classification on a `critical` row defaults to `architectural` (conservative — forces a user gate). Log it so the reviewer agent prompt can be tightened later.
