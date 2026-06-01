# Karpathy Assessment v3 — PipeCrew Plugin

**Date**: 2026-04-26  
**Basis**: Fresh assessment against Karpathy's 4 principles (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution). Independent of v1/v2 — no anchoring on prior findings.

---

## Assessment

### Principle 1 — Think Before Coding (75%)

**Strengths**
- `spec_policy` forces explicit upfront classification before any implementation work.
- R7 (Assumptions block) makes agents stop on load-bearing ambiguity rather than guess.
- Task files carry `## Out of Scope` so agents know what NOT to do before writing a line.
- FR-X / EC-X IDs link requirements → implementation → review.

**Gaps found**
- SA produced one design and moved on — didn't surface alternatives or explain trade-offs.
- Phase files assumed their preconditions silently (Phase 5 assumes worktrees exist, Phase 5.5 assumes task files exist — no explicit verification).

---

### Principle 2 — Simplicity First (60%)

**Strengths**
- Lazy-loading phase files keeps orchestrator context lean.
- `per R{N}` shorthand replaced verbose repetition across 12 implementer files.
- Spec policy branches moved into reviewer system prompts reduces per-dispatch overhead.

**Gaps found**
1. `implementer-common-rules.md` R0 was ~280 words for "read your task file first."
2. Steps 7–8 (scope-drift + classification) were copy-pasted verbatim between the backend and frontend reviewer dispatch templates in `phase-5.5` (~60 lines duplicated).
3. *(Kept by design)* Deferred file system — user confirmed this complexity is intentional.
4. Phase 4 "Adjust" gate option had no defined handling path.
5. R3 listed 9+ specific artifact patterns instead of a simple principle.

---

### Principle 3 — Surgical Changes (70%)

**Strengths**
- R6 names 6 specific scope traps — actionable, not abstract.
- R8 (worktree isolation) prevents cross-repo drift at the agent level.
- Machine-readable FINDINGS block makes scope findings parseable and traceable.

**Gaps found**
- Scope-drift and classification instructions lived in the orchestrator dispatch template rather than the reviewer system prompts — wrong layer.
- `## Stack-specific invariants` heading rename diverged from the original `## Invariants` style.
- `feature_slug:` key in deferred file frontmatter diverged from `feature:` used in task file frontmatter.
- R3 artifact enumeration is brittle — grows stale as IDEs evolve.

---

### Principle 4 — Goal-Driven Execution (65%)

**Strengths**
- Checkpoints.jsonl provides machine-verifiable run state.
- Mechanical/architectural classification narrows the gate to a binary decision.
- Phase gates are at explicit approval points.

**Gaps found**
- Phase success criteria were process-based ("dispatch agent X, update scratchpad") rather than outcome-based ("all task files show done or failed").
- Phase 5.5 fix loop had no explicit termination condition — could theoretically re-dispatch indefinitely.
- `--auto-fix-mechanical` assumed reliable classification with no verification step; an agent misclassifying architectural as mechanical would auto-dispatch a bad fix round.

---

## Changes Made

### `rules/implementer-common.md` (209 → 183 lines)
- **R0**: Trimmed from ~280 words to ~50 words. Core message preserved: read task file first, trust it, don't re-ask, update metrics on completion.
- **R3**: Trimmed 9-artifact bullet list to a 4-line principle: stage only what you intentionally changed; fix `.gitignore` for noise.

### `agents/solution-architect.md`
- Added to design constraints: when two designs meet requirements, name the runner-up and explain why it was ruled out. If both are equal in simplicity, surface the trade-off and ask before picking.

### `agents/spring-boot-code-reviewer.md` (219 → 234 lines)
- Added **Step 7** (Scope-drift check) — walk non-trivial diff hunks for FR/EC traces; emit `## Scope findings`; flag Out-of-Scope matches as Critical.
- Added **Step 8** (Classify every Critical) — mechanical vs. architectural; when in doubt: architectural.
- Renumbered "Produce the report" to Step 9.

### `agents/react-code-reviewer.md` (236 → 251 lines)
- Added **Step 12** (Scope-drift check) and **Step 13** (Classify every Critical).
- Renumbered "Produce the report" to Step 14.

### `agents/nestjs-reviewer.md` (71 → 73 lines)
- Added Steps 7 (scope-drift) and 8 (classify) before "Produce the report" (renumbered to Step 9).

### `agents/nextjs-reviewer.md` (73 → 74 lines)
- Added Steps 9 (scope-drift) and 10 (classify) before "Produce the report" (renumbered to Step 11).

### `skills/deliver/phases/phase-5.5-code-review.md` (261 → 247 lines)
- **Removed** the ~60-line verbatim copy-paste of steps 7–8 from BOTH dispatcher templates (backend + frontend). Replaced with 2-line references to the reviewer system prompts.
- **Added** precondition check at start of Step 1: verify each worktree still exists before dispatching reviewers; missing = skip + log, not crash.
- **Added** auto-fix verification: before auto-dispatching, re-read each "mechanical" task file's Problem field; if description starts with "decide whether" or "requires changing the approach", re-classify as architectural and fall through to user gate.
- **Changed** Step 3 item 6: explicit loop termination — one fix round per run; remaining issues are recorded and reported at Phase 7, not silently re-dispatched.

### `skills/deliver/phases/phase-5-build.md`
- **Added** explicit worktree verification before agent dispatch: `git -C {worktree_path} status` must exit cleanly; missing worktree = stop and report.
- **Changed** "after all agents complete" language to outcome-based: "Phase 5 is complete when every task file shows `status: done` or `status: failed` (none remain `todo` or `in_progress`)."

### `skills/deliver/phases/phase-4-plan.md`
- **Added** "Adjust" handling: user describes changes in natural language, orchestrator applies them, re-presents the updated plan, repeats the gate. Does not re-run Phase 1 or 2.
- **Fixed** style drift: deferred file frontmatter key `feature_slug:` → `feature:` (consistent with task file frontmatter).

### `skills/deliver/phases/pre-flight.md`
- Updated deferred-file field reference from `feature_slug` to `feature` to match the template change above.

### 11 implementer agents (bash batch)
Files: `spring-boot-api-implementer`, `react-feature-implementer`, `nestjs-implementer`, `fastapi-implementer`, `django-implementer`, `flask-implementer`, `python-worker-implementer`, `nextjs-implementer`, `mock-endpoint-implementer`, `cdk-stack-implementer`, `terraform-implementer`
- Renamed `## Stack-specific invariants` → `## Invariants` (restored original naming convention).

---

## Net token impact

| File | Before | After | Delta |
|------|--------|-------|-------|
| `implementer-common-rules.md` | 209 lines | 183 lines | −26 |
| `phase-5.5-code-review.md` | 261 lines | 247 lines | −14 |
| `spring-boot-code-reviewer.md` | 219 lines | 234 lines | +15 |
| `react-code-reviewer.md` | 236 lines | 251 lines | +15 |
| `nestjs-reviewer.md` | 71 lines | 73 lines | +2 |
| `nextjs-reviewer.md` | 73 lines | 74 lines | +1 |

The phase-5.5 reduction is net-positive: the ~60 lines removed from the orchestrator context (loaded per run) are worth more than the ~33 lines added to 4 reviewer system prompts (loaded once per reviewer instance). Instructions now live in the right layer.

---

## Implementer & Reviewer Karpathy Compliance Check

A second pass assessed whether **the code that implementers produce** and **the code that reviewers evaluate** follows the same 4 principles.

### Coverage map

| Principle | Implementers | Reviewers |
|-----------|-------------|-----------|
| **Think Before Coding** — state assumptions, stop on ambiguity | ✅ R7 (Assumptions block, load-bearing stop) | ✅ FR/EC enforcement walk |
| **Think Before Coding** — push back when simpler approach exists | Intentionally N/A — implementers follow the SA's design | ❌ No "is this unnecessarily complex?" check |
| **Simplicity First** — no unrequested features | ✅ R6 (scope traps) | ✅ Scope-drift check |
| **Simplicity First** — no single-use abstractions | ✅ R6 | ✅ Scope-drift (no FR/EC trace) |
| **Simplicity First** — no impossible-scenario error handling | ✅ R6 | ✅ Scope-drift |
| **Simplicity First** — simplify if 200 lines could be 50 | ❌ No self-check | ❌ No reviewer check |
| **Surgical Changes** — touch only what you must | ✅ R6, R8 | ✅ Scope-drift |
| **Surgical Changes** — don't improve adjacent code | ✅ R6 | ✅ Scope-drift |
| **Surgical Changes** — match existing style | ✅ R1 (read stack standards first) | ✅ Craft passes |
| **Surgical Changes** — report dead code, don't delete it | ✅ R6 | — |
| **Goal-Driven Execution** — run tests to verify | ✅ Stack invariants | — |
| **Goal-Driven Execution** — walk every requirement before done | ❌ Not required | ✅ Reviewers do this — but after the fact |
| **Goal-Driven Execution** — tests assert outcomes not implementation | ❌ Not stated | ✅ spring-boot ✅ react ✅ — nestjs ❌ nextjs ❌ |

### "Simplify if 200 lines could be 50" — skipped intentionally
Too subjective to enforce as a rule. No programmatic threshold makes sense; over-engineering that produces unrequested code is already caught by scope-drift.

### "Push back when simpler approach available" — N/A for implementers
This principle applies to the design phase. The SA was updated (this session) to surface alternatives. Implementers follow the task file — re-designing at implementation time would break the pipeline flow.

---

## Gaps found & fixed

### Gap 1 — Implementers never self-verified requirement coverage

**Problem**: Implementers ran tests and reported done without walking every functional requirement (FR-X) and edge case (EC-X) to confirm each had an enforcement point. The reviewer caught this in Phase 5.5, but that costs a full dispatch-and-fix-round.

**Fix — `rules/implementer-common.md`**
- Added terminology glossary at the top: `FR-X` = functional requirement, `EC-X` = edge case. Defined once in the doc every agent reads.
- Added **R9** (HARD RULE): before reporting done, walk every FR-X / EC-X in the task file, identify the `file:line` that enforces each, and include a `## Requirement coverage` table in the report. If any requirement has no enforcement point, fix it before reporting.

### Gap 2 — nestjs-reviewer and nextjs-reviewer lacked test quality guidance

**Problem**: Both agents had a single-line "Check test coverage" step with no quality criteria. spring-boot and react reviewers had detailed test quality rules (outcome vs. implementation assertions, mock data must match spec shapes). nestjs and nextjs would accept any test that existed.

**Fix — `agents/nestjs-reviewer.md` and `agents/nextjs-reviewer.md`**
- Expanded test coverage step to 4 bullets matching the standard in the larger reviewers:
  1. Unit tests for every new method; integration/e2e tests for controllers/routes/pages.
  2. Tests must assert on outcomes (response body, state change, rendered output) not implementation details (spy calls, method invocations) → violations are Non-critical.
  3. Mock data / test fixtures must use spec field names — wrong names pass locally, break against real backend → Critical.
  4. Missing test for new code path → Non-critical. Missing test for auth/permission path → Critical.

---

## Final line counts (after all changes in this session)

| File | Start of session | End of session | Delta |
|------|-----------------|----------------|-------|
| `implementer-common-rules.md` | 209 | 205 | −4 (net: trimmed R0+R3, added glossary+R9) |
| `phase-5.5-code-review.md` | 261 | 247 | −14 |
| `spring-boot-code-reviewer.md` | 219 | 234 | +15 |
| `react-code-reviewer.md` | 236 | 251 | +15 |
| `nestjs-reviewer.md` | 71 | 77 | +6 |
| `nextjs-reviewer.md` | 73 | 78 | +5 |
