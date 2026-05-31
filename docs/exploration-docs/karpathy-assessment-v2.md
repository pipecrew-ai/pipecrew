# PipeCrew × Karpathy Principles — Re-assessment (v2)

**Date**: 2026-04-26
**Plugin source**: `C:\Users\ramy7\.claude\plugins\marketplaces\pipecrew\` on branch `feat/multi-stack-spec-policy`, based on commits through `0a26337` (the "big bang" commit that landed `rules/implementer-common.md`, `/learn` skill, `feedback-learner` agent, `IMPROVEMENT-PLAN.md`, `phase-8-pr-publish.md`, `phase-b25-stack-discovery.md`, 11 stack templates, the SA prompt rewrite, and the Common-rules reference in every implementer)
**Reference**: https://github.com/forrestchang/andrej-karpathy-skills
**Predecessor**: `karpathy-assessment.md` (v1, 2026-04-25)

---

## Status of plan items

- **P1 — Add R6 (scope discipline) + R7 (state assumptions) to common-rules** — ✅ done 2026-04-26. Two new HARD-RULE sections appended to `rules/implementer-common.md`; reference updated from `R1–R5` → `R1–R7` in all 12 implementer agents.
- **P2 — `## Out of Scope` task-section + `## Scope findings` reviewer category** — ✅ done 2026-04-26. (a) `phase-4-plan.md` task body bullet list now includes `## Out of Scope` between Known Anti-Patterns and Report format; new "Building the `## Out of Scope` section" sub-block added between the Known Anti-Patterns building block and the Work Log paragraph (sources: requirements doc, architecture RISKS section, captured gate-rejections; fallback "(none)" line for empty cases). (b) `phase-5.5-code-review.md` backend + frontend reviewer dispatch prompts both gained a new Step 7 "Scope-drift check" (renaming the old Step 7 → Step 8) — instructs reviewer to trace every non-trivial diff hunk to an FR/EC, file scope-only hunks under a new `## Scope findings` section, treat any match against the task's `## Out of Scope` as a Critical scope violation, and append a `scope | ...` row to the `<!-- BEGIN FINDINGS -->` block so Step 1.5's task-file persistence picks them up.
- **P3 — Trim implementer-agent redundancy + add R8 (worktree discipline)** — ✅ done 2026-04-26. Added Rule 8 (HARD RULE) to `rules/implementer-common.md` covering "stay in your launched worktree" (no `git checkout other-branch`, no second `git worktree add`, no edits in another repo's worktree, use `git show <branch>:<path>` for read-only cross-branch peeks). Bumped reference range `R1–R7` → `R1–R8` in all 12 implementer agents. Then trimmed each implementer's Invariants and Process steps to remove what's now in R0–R8: dropped restated "Read CLAUDE.md first" (R0/R1), "Work in worktree, don't switch branches" (R8), and "Apply documentation update rules" (R5). Replaced with one-line `per R{N}` pointers. Also fixed domain leaks per the plugin-agents-domain-agnostic memory: react-feature no longer hardcodes EN/AR or RTL — now reads "i18n + RTL coverage matches the workspace" with the language list sourced from `stacks/react.md` / `platform.md`; nextjs already had "all configured languages" wording, kept. Word counts: total 14,566 → 12,746 words across 12 files (-1,820 words / **-12.5%**). Per-file biggest cuts: spring-boot-api -20%, react-feature -20%, mock-endpoint -13%, terraform -13%; smallest cuts on already-lean files: nextjs -4%, nestjs -7%.
- **P4 — Mechanical-vs-architectural fix-round split + formalized Phase 5.5 gate** — ✅ done 2026-04-26. (a) All 4 reviewer agents (`spring-boot-code-reviewer`, `react-code-reviewer`, `nestjs-reviewer`, `nextjs-reviewer`) now require a `**Classification**: mechanical | architectural` field on every Critical finding in the prose template, AND a 5th pipe-field on every `critical` row in the `<!-- BEGIN FINDINGS -->` block (4-field format preserved for non-critical / scope rows — backward compatible for any older parser). (b) Phase 5.5 backend + frontend reviewer dispatch prompts gained a new Step 8 "Classify every Critical finding" with the canonical mechanical/architectural definitions inline (mechanical = small local edit, no design judgment; architectural = needs design decision or cross-file refactor; "when in doubt, mark architectural"). The old Step 8 (Produce report) is now Step 9. (c) Phase 5.5 itself was missing explicit Step 2 / Step 3 (the gate + fix-round dispatch were only referenced from SKILL.md and phase-5.75 — never documented in phase-5.5). Added Step 2 (Gate decision) — counts criticals/mechanical/architectural across all reviewer reports and branches three ways: zero criticals → COMPLETED; auto-dispatch when `--auto-fix-mechanical` is set AND all criticals are mechanical; user gate otherwise. Added Step 3 (Fix-round dispatch) — re-dispatches the original implementer per repo with a fix-list prompt (cites R6 + R7 for scope discipline and assumptions), parallel across repos, saves artifacts to `{run_dir}/fix-rounds/round-N/`, no auto-rereview in v1. Updated the task-file template to include a `classification` frontmatter field; fixed two stale `~/.claude/dal-pipeline/...` paths to `{run_dir}/...` in the same block. (d) SKILL.md gained the `--auto-fix-mechanical` flag in the Flags table, the FLAG BEHAVIOR SUMMARY, and a parenthetical note on the user-approval-gates rule. Closes gap #5 (mechanical-vs-architectural split) and bridges the previously-implicit Phase 5.5 fix-round documentation gap as a side win.
- **P5 — Phase 4.5 Minimum / Deferrable split + auto-discovered follow-up file** — ✅ done 2026-04-26. (a) `phase-4-plan.md` sub-task templates (backend / frontend / mock) now mark every sub-task `[M]` (Minimum) or `[D]` (Deferrable) with the architect's `## Risks & Trade-offs` section as the source of truth. The plan presentation template renders two named tables per repo (Minimum slice, then Deferrable if any). The gate question expanded from 2 options to 3: `Approve all` / `Minimum only` / `Adjust`. If the architect flagged zero deferrables, the gate collapses back to the original 2-option form. (b) New section "When user picks 'Minimum only': write the deferred follow-up file" — defines the file format (frontmatter with `feature_slug`, `source_run_id`, `status: pending`; body with deferred sub-tasks by repo, filtered FRs/ECs, pointers to the source run's architecture sections, plus a "How to resume" footer). File location: `{workspace_root}/{slug}/deferred/<feature-slug>.md`. (c) `pre-flight.md` Step 1.7 (new) auto-discovers pending deferred files: with `--from-deferred=<slug>` it loads directly; with `--from-deferred` (no value) it lists and prompts; without the flag it prints a heads-up but doesn't interrupt the user's typed feature flow. The deferred file's body becomes the feature input for the new run; Phase 1 + Phase 2 still run (so the product-owner can refine against current state). (d) `phase-7-report.md` Step 7.5 (new) flips the source deferred file's `status: pending` → `status: consumed` on successful run end, plus stamps `consumed_at` and `consumed_by_run_id` for audit. (e) SKILL.md gained the `--from-deferred[=<slug>]` flag in the Flags table, the FLAG BEHAVIOR SUMMARY, and two new usage examples. Also fixed two domain leaks in the same edit: removed hardcoded `EN + AR` in i18n sub-task descriptions (now reads "every language the workspace configures (per stacks/{type}.md)") and replaced hardcoded repo names like `abvi-publisher-service` / `abvi-pms-frontend` / `abvi-backends-mock` with `{service.repo}` / `{frontend.repo}` / `{mock.repo}` placeholders. Closes gap #7 (Phase 4.5 minimum/deferrable framing) and gives users a way to ship in smaller increments without losing the architect's deferred work.
- **P6 — Move spec_policy switch into reviewer system prompts** — ✅ done 2026-04-26 (kept despite modest token math). (a) `spring-boot-code-reviewer.md` Process step 3 was rewritten from "Spec compliance pass" (api-first only, ~8 lines) to "Contract compliance pass (depends on `spec_policy`)" with three policy sub-sections (api-first / code-first / no-api), preserving the existing rich Spring Boot checks under api-first and adding equivalents for code-first (treat inline contract as the spec) and no-api (event model field check, idempotency, partial-failure, DLQ + retry). (b) `nestjs-reviewer.md` step 5 collapsed into one Step 4 "Contract compliance pass" with terser per-policy bullets matching nestjs-reviewer's existing style. (c) `phase-5.5-code-review.md` backend dispatch prompt's `## Contract inputs` block had its three CONTRACT CHECK DIRECTIVE blocks removed (the directives now live in the reviewer system prompts); per-policy INPUT shapes (ENDPOINTS / SPEC / INLINE CONTRACT / EVENT SCHEMAS) preserved since the orchestrator still selects them per service. INSTRUCTIONS step 2 now reads "Apply the contract compliance pass from your system prompt — the directive matching `spec_policy` above tells you exactly what to walk and what to flag." (d) Honest token result: line counts +29 / +2 / -18 across the 3 files (net +13 lines). Per-dispatch math is slightly worse for spring-boot-heavy runs (~+25 to +130 tokens per run depending on reviewer count) because the system-prompt growth outweighs the dispatch shrinkage. Kept anyway — the architectural win (single source of truth for contract-check rules; reviewer owns its identity) is real and the absolute cost is small. Documented in v2 as "kept despite modest token math".
- P7 — pending (plain-English pass on `IMPROVEMENT-PLAN.md`, low priority unless user-facing)
- P4 — pending
- P5 — pending
- P6 — pending
- P7 — pending

---

## What changed since v1 (good news first)

**1. New `rules/implementer-common.md`** — five shared rules (R0 task file as truth, R1 workspace stack standards, R2 validate configs, R3 git hygiene, R4 security tests on auth changes, R5 docs-as-part-of-done). **Every implementer now references it** with a "Common rules" section. This is the right architecture for adding cross-cutting rules in one place — exactly the pattern v1 was about to recommend for gaps #2 and #6.

**2. Per-workspace stack standards** (`{workspace_root}/{slug}/context/stacks/{type}.md`) generated by new Phase B2.5. Implementers now have a workspace-tuned conventions doc to match — solves the "implementer guesses conventions" problem.

**3. New `/learn` skill + `feedback-learner` agent** — closed feedback loop with tier classification (run-local / repo-durable / workspace-durable / plugin-level). Read-only learner, verbatim-quote evidence, surgical before/after diffs. **This is the most Karpathy-aligned addition** — it embodies "stop and ask before changing" and "small, surgical proposals" by design. No major fixes needed here.

**4. `IMPROVEMENT-PLAN.md`** — 9-item roadmap with priority. Items #2 (non-circular verification), #7 (pipeline-inspector), #9 (simple-mode fast lane) are conceptually strong. Some overlap with the v1 Karpathy gaps, some don't.

**5. Phase 5.5 review dispatch is now `spec_policy`-aware** (api-first / code-first / no-api branches), persists findings as task files, and now includes "verify each bullet in the task file's `## Known Anti-Patterns` section was actively avoided" — that's a real goal-driven addition.

**6. Phase 8 PR publish exists** as a phase file (item #8 from the plan).

**7. SA agent `Design Constraints` section** — done in v1 turn (gap #1 closed).

---

## v1's 7 gaps — current status

| v1 gap | Status | Why |
|---|---|---|
| #1 SA Design Constraints | ✅ Closed | done in v1 turn |
| #2 Implementer "Out of scope" / scope-traps | ❌ Open | common-rules R0–R5 cover discipline + correctness, but no anti-overengineering rule |
| #3 Task-file `## Out of Scope` section | ❌ Open | phase-4-plan template unchanged on this |
| #4 Reviewer scope-drift detection | ❌ Open | reviewer agents only walk FR→code; not code→FR |
| #5 Mechanical-vs-architectural fix-round split | ❌ Open | Phase 5.5 still uniform "if criticals → user gate" |
| #6 Implementer ASSUMPTIONS step | ❌ Open | not in common-rules or any Process step |
| #7 Phase 4.5 minimum/deferrable framing | ❌ Open | plan template unchanged |

---

## New observations the changes opened up

**N1. The common-rules file is the right place for #2 and #6.** Add R6 (scope discipline / anti-overengineering) and R7 (state assumptions before coding) to one file → all 11 implementers inherit it without 11 file edits. Highest leverage edit available right now.

**N2. There's no `reviewer-common-rules.md`** — so reviewer cross-cutting rules (scope-drift detection, severity classification) have no shared home. Two paths: create it, or fold reviewer-side cross-cutting into the Phase 5.5 dispatch prompt template (which is where the per-call directives already live). The dispatch prompt is lighter-touch.

**N3. Implementer agents now have redundancy with common-rules.** spring-boot's Invariant 1 ("Read CLAUDE.md first") overlaps R0/R1; Invariant 3 ("Work in worktree, don't switch branches") isn't in common-rules but should be (every implementer says it); the Process step 11 "Apply documentation updates" duplicates R5. Cleaning this up = direct token savings on every implementer dispatch (~5–10% per agent file). **This is the simpler-English angle**: not just word-by-word simplification, but cutting structural repetition.

**N4. `IMPROVEMENT-PLAN.md` itself uses dense language and could be simplified.** "stochastic, not reproducible", "infra-delta sniffer", "non-circular verification" — fine for an internal roadmap, but if it's user-visible (it's at the plugin root), worth a plainer pass.

**N5. Phase 5.5 dispatch prompt is ~110 lines per reviewer call** with the spec_policy switch inlined. That switch could move into the reviewer's system prompt, with the orchestrator passing only `policy: api-first` — saves ~50 lines per dispatch. Token-cost win, no behavior change.

**N6. The `feedback-learner` + `/learn` already does most of what gap #4 (scope-drift detection) wants**, but post-hoc, on merged PRs. Doing it inside the run (Phase 5.5) catches it before the PR — strictly better, complements `/learn` rather than competing.

---

## Plan — prioritized, with effort and token-impact

Each item lists: **what / why / where / effort / token impact / Karpathy principle**.

### P1. Add R6 + R7 to `implementer-common-rules.md` (closes gaps #2 + #6 in one edit)

- **What.** R6 = scope discipline: "no abstractions / config knobs / defensive layers / refactors of adjacent code unless the task names them. If you find yourself touching code that has no FR/EC trace, stop and ask." R7 = state assumptions: "if any FR/EC, contract field, or sub-task line is ambiguous, emit an `## Assumptions` block in your report BEFORE the code section. Continue only if the ambiguity is stylistic; stop and return if it's load-bearing."
- **Why.** Single-file edit, applies to all 11 implementers automatically. R0–R5 set the pattern; R6–R7 fit the same shape.
- **Where.** `rules/implementer-common.md` — append two sections.
- **Effort.** Small (one file, ~30 lines added).
- **Token impact.** Adds ~600 tokens to common-rules read once per implementer dispatch. Net positive: prevents whole rounds of unnecessary work.
- **Karpathy.** Surgical Changes (R6) + Think Before Coding (R7).

### P2. Add `## Out of Scope` to the task-file template + `## Scope` finding category to reviewer dispatch (closes gaps #3 + #4)

- **What.** In `phase-4-plan.md` task-file template: add `## Out of Scope` section between `## Known Anti-Patterns` and `## Report format`, populated from anything the user rejected/deferred at the Phase 2 or 4.5 gate. In `phase-5.5-code-review.md` reviewer dispatch prompt: add Step 8 — "For every non-trivial diff hunk, identify the FR/EC it enforces. Hunks with no trace go in a new `## Scope findings` category."
- **Why.** Two-file edit; Out of Scope gives the implementer a record of what NOT to do; Scope findings gives the reviewer a check for whether the implementer respected it.
- **Effort.** Small.
- **Token impact.** Adds ~150 tokens to task-file template + ~80 tokens to reviewer dispatch. Per-dispatch cost is low; catches scope creep that would otherwise cost a full fix-round.
- **Karpathy.** Surgical Changes.

### P3. Trim implementer-agent redundancy with common-rules (cross-cutting simpler-English / token saving)

- **What.** In each `*-implementer.md`: remove invariant bullets and Process steps already covered by R0–R5. Keep only stack-specific ones. Add explicit pointers like "see R1" instead of restating.
- **Why.** Common-rules now exists; the duplication is dead weight loaded on every dispatch.
- **Where.** All 11 implementer files — but the pattern is identical across them, so the edit is mechanical.
- **Effort.** Medium (touches many files but each is small).
- **Token impact.** ~5–10% reduction per implementer dispatch. Compounds across every `/deliver` run.
- **Karpathy.** Simplicity First (apply to the prompts themselves).

### P4. Mechanical-vs-architectural classification in reviewer output (closes gap #5, partially)

- **What.** Reviewer adds `(mechanical)` or `(architectural)` tag to every Critical finding. Phase 5.5 fix-round logic: if all criticals are `(mechanical)`, dispatch fix-round without user gate. If any `(architectural)`, gate as today.
- **Why.** Mechanical fixes (missing field, wrong status code, missing i18n key) don't need a human turn; the success criteria are already strong.
- **Where.** Reviewer agent system prompts (add tag instruction) + Phase 5.5 dispatch prompt + Phase 5.5 fix-round step.
- **Effort.** Medium. Pilot behind `--auto-fix-mechanical` flag first.
- **Token impact.** Saves human latency more than tokens — but reduces total run cost when fewer rounds need re-context.
- **Karpathy.** Goal-Driven Execution (loop independently when criteria are strong).

### P5. Phase 4.5 minimum/deferrable framing (closes gap #7)

- **What.** Plan template gets two sub-tables: "Minimum viable slice" and "Deferrable to follow-up". User can approve only the minimum at the gate.
- **Effort.** Small.
- **Token impact.** Neutral on the plan render; net negative on the run if user trims.
- **Karpathy.** Simplicity First.

### P6. Move spec_policy switch into reviewer system prompts (token win, no behavior change)

- **What.** Each reviewer's system prompt contains the three-policy contract-check directive. Orchestrator dispatch prompt shrinks to "policy: api-first / code-first / no-api" plus the per-call inputs.
- **Why.** ~50-line reduction per Phase 5.5 dispatch × N reviewers per run.
- **Effort.** Medium (touch every reviewer agent).
- **Token impact.** Significant on Phase 5.5.
- **Karpathy.** Simplicity (in the prompt itself).

### P7. Plain-English pass on `IMPROVEMENT-PLAN.md` (low priority unless it's user-facing)

- **What.** Replace dense terms ("stochastic", "non-circular verification", "infra-delta sniffer") with simpler equivalents while preserving meaning.
- **Effort.** Small.
- **Token impact.** Marginal — this file isn't loaded into agent context routinely.
- **Karpathy.** Style alignment, not a structural fix.

---

## Suggested order

1. **P1 (R6 + R7)** — single file, biggest leverage, closes 2 of 6 remaining gaps. **Do first.**
2. **P2 (Out of Scope + Scope findings)** — closes 2 more gaps with two small edits.
3. **P3 (trim implementer redundancy)** — token win on every run; mechanical edits.
4. **P5 (minimum/deferrable in Phase 4.5)** — small, useful at the next gate.
5. **P4 (mechanical/architectural)** — flag-gated; pilot before defaulting.
6. **P6 (spec_policy switch into reviewers)** — pure token win; can be deferred.
7. **P7 (plain-English IMPROVEMENT-PLAN)** — only if user-facing.

After P1–P3, all of v1's original 7 gaps are closed except P4/P5 which are flag-gated experiments.

---

## Files referenced (for the next implementation pass)

- `rules/implementer-common.md` (target for **P1**)
- `skills/deliver/phases/phase-4-plan.md` (target for **P2** + **P5**)
- `skills/deliver/phases/phase-5.5-code-review.md` (target for **P2** + **P4**)
- `agents/spring-boot-api-implementer.md`, `agents/react-feature-implementer.md`, `agents/nestjs-implementer.md`, `agents/fastapi-implementer.md`, `agents/django-implementer.md`, `agents/flask-implementer.md`, `agents/nextjs-implementer.md`, `agents/python-worker-implementer.md`, `agents/mock-endpoint-implementer.md`, `agents/cdk-stack-implementer.md`, `agents/terraform-implementer.md`, `agents/schema-implementer.md` (targets for **P3** + **P4** tag)
- `agents/nestjs-reviewer.md`, `agents/spring-boot-code-reviewer.md`, `agents/react-code-reviewer.md`, `agents/nextjs-reviewer.md` (targets for **P4** + **P6**)
- `IMPROVEMENT-PLAN.md` (target for **P7**)
