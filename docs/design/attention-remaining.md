# Attention work — remaining

**Date**: 2026-04-28
**Status**: companion to [`attention-work-plan.md`](./attention-work-plan.md). That doc was the original 5-pass plan. This doc tracks **what's left** after the M-pass follow-ups in commit `c1e05ae`.

---

## Done so far

### Original plan (commit `6a26a8f` + `4cebea7` on `block-scripts` → merged via PR #5)
- **P0** — `context-engineering.md` cross-references
- **Pass A** — CRITICAL blocks at end of architect / implementer / reviewer dispatches
- **Pass B** — `identify ALL affected services` moved to architect system prompt; `R1–R9` parity across 11 implementer agents
- **Pass C** — trims to `SKILL.md` utility scripts + common-rules R2/R5 prose
- **Pass D** — additive-safe producer-side migrations: `API_DESIGN`, `DATA_MODEL`, `INFRASTRUCTURE_IMPACT` JSON blocks
- **Pass E** — list-embedding audits (no fix needed)
- 3 reflection docs at plugin root (`context-engineering.md`, `attention-and-caching.md`, `attention-work-plan.md`)

### Follow-ups (commit `c1e05ae` on `main`)
- **M3** — `effort: high` on architect / security-consultant / 4 code reviewers
- **M4** — `## Invariants` section added to `nestjs-reviewer` and `nextjs-reviewer` (parity with spring-boot/react)
- **M1** — UX consultant CRITICAL block in `phase-5-build.md` Step 2
- **M2** — reviewer dispatch lead tightening (feature name in first sentence)
- **Side**: code reviewers downgraded to `model: haiku` + `effort: high`

---

## Remaining

### #5 — architect / reviewer system-prompt trim pass
**Effort**: 1–2 hours
**Risk**: Medium (could lose teaching if too aggressive)

`rules/implementer-common.md` was trimmed in the Karpathy pass and again lightly in C3. The agent system prompts that DON'T live in common-rules haven't been through the same lens:

- `agents/solution-architect.md` — 334 lines + the new D1/D2/D3 block templates added
- `agents/spring-boot-code-reviewer.md` — 247 lines (longest reviewer)
- `agents/react-code-reviewer.md` — 264 lines (longest reviewer)
- `agents/nestjs-reviewer.md` — 86 lines (already lean; skip)
- `agents/nextjs-reviewer.md` — 87 lines (already lean; skip)

**Scope**: targeted trims on the two longest reviewers and the architect. Cut prose that doesn't change behavior. Preserve numbered rules and HARD constraints. One trim per topic so each is independently revertible.

**Specific candidates to inspect** (not pre-committed):
- spring-boot-code-reviewer "## Things that will bite you" section — likely overlaps with R1/R5
- react-code-reviewer "## Things that will bite you" — same
- solution-architect — verbose descriptions inside the per-block templates (lines 160–290) where the templates themselves carry the structural cue

**Why deferred**: each cut needs careful judgment ("does this teach something or just add tokens?"). Not mechanical. Best done in one focused session, not interleaved with other passes.

---

### #6 — other-phase dispatch audits
**Effort**: ~1 hour total (15 min per phase)
**Risk**: Low

Pass A focused on the 3 hot dispatches (architect / Phase 5b implementer / Phase 5.5 reviewer). The other phases also dispatch agents and have prompts that haven't been audited:

| Phase | File | Dispatch concern |
|-------|------|-----------------|
| Phase 1 — Requirements | `phases/phase-1-requirements.md` | product-owner agent dispatch — does it lead with the active task? Does it have integrity check (e.g., "list FR-1..FR-N in REQUIREMENTS_INDEX")? |
| Phase 6 — Assess | `phases/phase-6-assess.md` | assessor dispatch — what's restated at the end? Does it have a CRITICAL block? |
| Phase 7 — Report | `phases/phase-7-report.md` | reporter dispatch — long prompt, low stakes, but worth the same lens |
| Phase 8 — PR Publish | `phases/phase-8-pr-publish.md` | PR-publish dispatch — generally short but has content-rich body |

**Scope**: per phase, audit (a) does the dispatch lead with the imperative? (b) does it end with a CRITICAL block restating the most-forgotten rules? (c) is dynamic content placed at the end?

**Why deferred**: lower leverage than the 3 hot dispatches. Each individual phase is a small win. Worth batching into one session.

---

### #7 — remaining architect blocks → JSON
**Effort**: ~2 hours per block × 3 blocks
**Risk**: Medium (each block has a different consumer profile)

Pass D shipped JSON migrations for `API_DESIGN`, `DATA_MODEL`, `INFRASTRUCTURE_IMPACT`. Three architect output blocks remain prose-only:

| Block | Producer | Consumer(s) | Migration value |
|-------|----------|-------------|-----------------|
| `CONTRACT_DESIGN` | architect | Phase 3a `schema-implementer` | Medium — schema-implementer reads prose; structured index would help enumerate per-contract changes |
| `FRONTEND_ARCHITECTURE` | architect | Phase 5b UX consultant + frontend implementer | Medium — currently both consumers LLM-parse. Structured index would let orchestrator pick relevant sub-blocks per consumer |
| `RISKS` | architect | Phase 6 assessor (reads), Phase 7 reporter (summarizes) | Low — narrative content with weak structured-consumption pattern |

**Scope per block**: same shape as D1
- `templates/blocks/{name}.example.json`
- `agents/solution-architect.md` block section emits JSON-first, prose-second
- `templates/blocks/block-schemas.md` schema doc
- `eval/tests/01-templates-parse.js` shape check

**Why deferred**: the additive-safe pattern means consumers can stay on prose. Migrate only when a real consumer pain emerges (e.g., schema-implementer occasionally misses a contract change because the prose is ambiguous). Defer `RISKS` indefinitely — it's narrative and unlikely to benefit.

**Trigger to ship**: when one of the three consumers has a "missed it because the prose was ambiguous" incident in a real `/deliver` run.

---

### #8 — eval Layer 4 (LLM-judge faithfulness)
**Effort**: ~4 hours scaffold + ongoing per-case budget
**Risk**: Medium (cost-bearing — needs decisions before building)

Without this, **we have zero empirical measurement** of whether the attention work actually reduced forgetting in practice. We assert it should help, with strong reasoning. We don't have receipts.

**Scaffold already in place**: `eval/llm-judge/README.md` documents the design. Three decisions need to be made before building:

1. **Judge model** — Sonnet (cheaper, faster, biased on nuance) vs. Opus (more expensive, more nuanced). Recommendation: pick one and use it for every case so scores stay comparable across runs. Don't rotate.
2. **Run-pipeline vs. frozen-output** — Does each eval case dispatch the architect agent fresh, or judge against a frozen `actual.md` committed to the repo? Probably want both modes via a flag.
3. **Cost cadence** — A case can be 50K–500K tokens (full pipeline run). 10 cases × Opus judge = real money. CI on every PR is not feasible; pre-release-only is. Decide cadence before wiring.

**Scope when built** (per `eval/llm-judge/README.md`):
- `eval/llm-judge/run.js` — runner
- `eval/llm-judge/cases/{name}/{input,expected,actual}.md` — case bundles
- `eval/llm-judge/judge-prompt.md` — rubric template
- ~10 cases covering the most-used `/deliver` shapes

**Why deferred**: not a code question — needs product/cost decisions before code. Building without those decisions produces a tool that may never be run.

**This is the only honest way to know whether any of the attention work is working.** Mark this as the single highest-leverage remaining item once decisions land.

---

## Recommended next batch

If you have ~2 hours and want a clean win: **#6 (other-phase dispatch audits)**. Mechanical, low-risk, completes the surface coverage that Pass A started.

If you want the highest-leverage remaining item: **#8 (eval Layer 4)** — but only after the three cost/model decisions land. Without measurement, every other "improvement" is asserted, not validated.

Skip **#5 (system-prompt trims)** unless attention budget feels actually constrained — the agents are reasonable size today.

Skip **#7 (remaining block JSON migrations)** until a real consumer incident triggers it.

---

## Cross-references

- [`attention-work-plan.md`](./attention-work-plan.md) — original 5-pass plan
- [`attention-and-caching.md`](./attention-and-caching.md) — principle this all serves
- [`context-engineering.md`](./context-engineering.md) — broader signal-vs-noise framing
- [`extractor-enhancement.md`](./extractor-enhancement.md) — D1/D2/D3 pattern precedent
- [`eval/llm-judge/README.md`](./eval/llm-judge/README.md) — Layer 4 design decisions awaiting
