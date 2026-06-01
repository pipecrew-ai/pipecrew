# PipeCrew × Karpathy Principles — Assessment

**Date**: 2026-04-25
**Plugin version reviewed**: pipecrew 1.0.0 (`C:\Users\ramy7\.claude\plugins\cache\pipecrew\pipecrew\1.0.0`)
**Reference**: https://github.com/forrestchang/andrej-karpathy-skills

---

## Karpathy's four principles (recap)

1. **Think Before Coding** — state assumptions, present alternatives, ask when unclear, stop when confused
2. **Simplicity First** — minimum code that solves the problem, nothing speculative, no premature abstractions
3. **Surgical Changes** — touch only what you must, match codebase style, don't refactor adjacent code
4. **Goal-Driven Execution** — define verifiable success criteria; strong criteria let the LLM loop independently

---

## Where pipecrew already embodies them (keep these)

| Principle | What's already strong in the plugin |
|---|---|
| 1. Think Before Coding | `solution-architect` split into `MODE: discovery` / `MODE: design` (hard guardrail against design-creep during onboarding); `product-owner` and architect have explicit *Ask Clarifying Questions* blocks; six user approval gates (Phase 1/2/3/4.5/5b/5.5); Phase 2 forces architect to re-read the spec before proposing contract changes ("Spec Gap Analysis"); discover's B1 deliberately limits itself to 3 questions that code can't answer. |
| 2. Simplicity First | `spec_policy: api-first \| code-first \| no-api` avoids forcing OpenAPI on every service; React implementer: *"Do NOT transform spec shapes into 'friendlier' internal shapes"*; Phase 6 assessment skipped when only 1 repo changed; config-driven auto-detection (phases only run if their preconditions hold); task files contain only what that task needs. |
| 3. Surgical Changes | Worktree-per-feature isolation by default; `openapi-spec-editor` and `schema-implementer` are scoped to *edit-in-place, no worktree, no rollback* — narrow contracts; `schema-implementer` refuses breaking changes unless architect explicitly authorized; discover's *"Never overwrite existing CLAUDE.md / config"*; `fix_list` with `file:line` targets for fix rounds. |
| 4. Goal-Driven Execution | `FR-X` / `EC-X` ID-based requirements are a verifiable success criterion; reviewers emit a *Requirement coverage map* + machine-readable `<!-- BEGIN FINDINGS -->` block (programmatic loop surface); implementer "You are not done until" checklist (types match spec / typecheck 0 / tests green / every FR enforced); Phase 5.5 → fix-round loop exists. |

---

## Gaps worth closing (ranked by impact on deliver quality)

### 1. No explicit "minimum-viable" bias in architect design-mode prompt *(Simplicity — biggest gap)*

`agents/solution-architect.md` lines 54–97 describe *what* to produce but never *"propose the smallest change that satisfies the requirements; no new abstractions, no config knobs, no speculative extensibility unless a current requirement is load-bearing on it."* The architect is free to over-design.

**Suggested:** add a `## Design Constraints` section near the top of design-mode with Karpathy-style rules. One paragraph, not a checklist.

### 2. Implementer agents have "correctness traps" but no "scope traps" *(Simplicity + Surgical)*

`react-feature-implementer.md` has a nice *Things that will bite you* section — but every bullet is about correctness (contract drift, XHR auth, role enum drift). None say *"do not refactor adjacent code, do not add try/catch for impossible errors, do not add a config flag that wasn't requested."* Same pattern in every implementer agent.

**Suggested:** add a parallel `## Out of scope` block to each implementer agent (2–4 bullets, stack-specific).

### 3. Task files list what to do but not what *not* to do *(Surgical)*

Phase 4.5 task-file template (`phases/phase-4-plan.md` lines 168–234) has `## Contract Reference`, `## Known Anti-Patterns`, `## Work Log` — but no `## Out of Scope`. Useful because the architect often raises topics that got descoped at the Phase 2 gate, and the implementer has no durable record of that.

**Suggested:** add `## Out of Scope` section to task body, populated from anything the user rejected/deferred at the Phase 2 or 4.5 gate.

### 4. Reviewers don't flag scope drift *(Surgical)*

`nestjs-reviewer.md` (and peers) walks FR → enforcement point and flags missing enforcement. They don't walk the inverse: *"this diff hunk has no FR/EC trace — why is it in this PR?"*

**Suggested:** add a `## Scope findings` category to the reviewer output format and one step: *"For every non-trivial hunk in the diff, find the FR/EC it enforces. If none, flag as scope-drift."*

### 5. Fix-round loop gates on a human for mechanical fixes *(Goal-Driven)*

`phases/phase-5.5-code-review.md` gates on user approval whenever reviewer found critical issues. For *mechanical* criticals (missing field, wrong status code, missing i18n key), this burns a human turn on something the LLM could verify autonomously — Karpathy's whole point about strong success criteria.

**Suggested:** classify criticals into `mechanical` vs `architectural` in the reviewer output. For mechanical-only rounds, dispatch the fix without the user gate and only gate if a second round is needed. Architectural findings still gate.

### 6. No "state your assumptions before coding" step in implementers *(Think Before Coding)*

Implementer dives into `### 1. Orient → 2. Plan → 3. Types first …`. The *Plan* step lists files to touch; it doesn't force the implementer to articulate ambiguity in the task file (especially for `code-first` services where the inline contract can have gaps).

**Suggested:** insert a step 1.5 — *"If any FR/EC or contract field is ambiguous, emit an `ASSUMPTIONS` block at the top of your report before you start coding. Continue only if the ambiguity is stylistic; stop and return if it's load-bearing."*

### 7. Phase 4.5 plan doesn't surface a deferrable slice *(Simplicity)*

Current plan shows one big sub-task list. A *"Minimum viable slice: X; Deferrable to a follow-up: Y"* framing at the Phase 4.5 gate would let the user trim at approval time instead of negotiating inside the architecture phase.

**Suggested:** top of the plan template gets two lists: Minimum / Deferrable. User can approve only the minimum and re-invoke for the rest.

---

## Discover-side observations (lighter lift)

- **Already well-aligned:** B1's 3-question cap, MODE: discovery guardrail, *"Never overwrite"* rules, `--skip-divergence-harvest` escape hatch, optional `agent-context/` for complex repos only.
- **Worth checking** (not read in full during this pass): does Phase C match generated CLAUDE.md verbosity to what the repo already implies? A minimalist repo getting a 400-line generated CLAUDE.md is a Simplicity violation.
- **Verification phase is thin:** Phase D checks paths + git status. Could add a "generated docs proportional to repo size" sanity check, e.g., warn if generated agent-context exceeds 20% of repo's own docs.

---

## Priority order

1. Architect design-mode "Design Constraints" (#1) — flows downstream into every other phase
2. Implementer "Out of scope" blocks (#2) — pairs with #1
3. Task-file `## Out of Scope` section + reviewer scope-drift category (#3 + #4) — single phase-4-plan + reviewer-template edit
4. Mechanical-vs-architectural fix-round split behind `--auto-fix-mechanical` flag first (#5)
5. Implementer ASSUMPTIONS step (#6)
6. Phase 4.5 minimum/deferrable framing (#7)
7. Discover Phase C verbosity sanity check (follow-up)

---

## Files referenced (for the next implementation pass)

- `skills/deliver/SKILL.md`
- `skills/deliver/phases/phase-1-requirements.md`
- `skills/deliver/phases/phase-2-architecture.md` (not read in detail this pass — re-check before editing #1)
- `skills/deliver/phases/phase-4-plan.md` (lines 168–234 hold the task-file template)
- `skills/deliver/phases/phase-5-build.md`
- `skills/deliver/phases/phase-5.5-code-review.md` (target for #5)
- `skills/discover/SKILL.md`
- `skills/discover/phases/phase-b-domain-and-architect.md`
- `skills/discover/phases/phase-c-generation.md` (not read this pass — needed for discover follow-up)
- `agents/solution-architect.md` (target for #1)
- `agents/react-feature-implementer.md` (canonical pattern for #2 / #6)
- `agents/nestjs-reviewer.md` (canonical reviewer pattern for #4)
