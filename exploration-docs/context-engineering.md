# Context engineering in PipeCrew

**Date**: 2026-04-26
**Companions**: [`eval/`](./eval/) (the eval harness this analysis recommends), [`extractor-enhancement.md`](./extractor-enhancement.md) (the structured-block work — a context-precision intervention shipped before this principle was named explicitly).

---

## Why this doc exists

A list of 12 common LLM-system techniques was reviewed against PipeCrew to see which ones are actionable at the plugin layer vs. handled below our abstraction. The exercise surfaced a single principle that already shapes most of the plugin's design — **signal vs. noise in the context window** — and made gaps visible. This doc captures both the principle and the audit so future contributors don't have to re-derive it.

PipeCrew is an **orchestrator over Claude Code subagents**, not a model server. It composes LLM calls; it doesn't run them. That framing decides what's actionable here.

---

## The list, scored against PipeCrew

| Technique | Layer | Actionable here? |
|-----------|-------|------------------|
| Prefix caching | API | **Yes** — prompt structure decides cache hit rate |
| KV cache management (eviction, quantization, paged attention) | Server | No — Anthropic API handles |
| Continuous batching, vLLM/SGLang | Server | No |
| Speculative decoding | Server | No |
| Test-time compute / thinking modes | API | **Yes** — per-agent model + thinking choice |
| Lost-in-the-middle | Prompt design | **Yes** — placement inside long dispatch prompts |
| Agentic RAG / multi-hop / reranking | Agent design | **Already** — agents retrieve via tools (Read/Grep/Glob/Explore) |
| Permission-aware retrieval | Enterprise data | N/A — local repos, no tenant isolation needed |
| Faithfulness / context-precision evals | Quality gate | **Yes — biggest gap** — no formal eval suite exists today |
| GQA / MQA | Model architecture | No |
| MoE active params | Model architecture | No (we do pick model per agent — sonnet/opus/haiku — which is the consumer-side knob) |

The "context precision" framing in its **classic RAG sense** doesn't directly apply to PipeCrew — there's no embedding retriever, no top-K chunks, no reranker. But the **underlying concern** — signal vs. noise in the context window — does apply, and is in fact the design pressure behind a lot of what's already shipped.

---

## The principle: signal vs. noise in the context window

An LLM only "sees" what's in its context window for a given call. Everything in there — system prompt, prior messages, retrieved documents, tool outputs, code files, examples — gets processed by the same attention mechanism, all at once, with no built-in notion of "this part is important, ignore the rest."

- **Signal** = tokens that materially help the model produce the right output for *this specific call*.
- **Noise** = tokens that don't help with *this specific call*, even if they're truthful, well-written, or might be useful elsewhere.

Critical nuance: **noise is task-relative, not content-relative**. A 3-page architecture document is signal when the architect is reasoning about the system, and noise when a downstream phase only needs the list of affected services.

### Why noise actually hurts (four mechanisms)

1. **Attention dilution** — self-attention spreads weight across every token. More tokens means each one gets a thinner slice of focus.
2. **Lost-in-the-middle** — transformers attend more strongly to the start and end of context than to the middle. Adding noise pushes signal toward the middle, where it gets under-weighted.
3. **Distractor pull** — if noise contains anything that *looks* relevant (similar terminology, plausible-but-wrong facts, prior wrong attempts), the model can latch onto it. The output looks confident and grounded but is actually grounded in the wrong thing.
4. **Cost and latency** — every prefix token gets prefilled (often quadratic in attention layers); every output token is generated against the full context. Noise is dollars and seconds, every call.

### The non-intuitive part

Humans deal with noisy information by skimming and refocusing. LLMs cannot do this reliably. Telling the model "ignore the irrelevant parts" works inconsistently — the model still processed those tokens and was still influenced by them. **The only reliable way to make the model ignore something is to not put it in the context in the first place.**

This means: the plugin (the system designer) must filter on the model's behalf. Every architectural decision about what goes into a prompt is implicitly a precision decision.

---

## How PipeCrew applies it today

Eleven mechanisms, in rough order of impact:

### 1. Subagent dispatch — the single biggest lever

Every `Agent` call creates an isolated context. The orchestrator hands a subagent a focused brief; the subagent does its file reads / greps / writes; the orchestrator gets back only the final report. Without this, the orchestrator's main thread would accumulate every tool call from every implementer × every reviewer × every fix round. Precision-via-isolation.

### 2. Worktree-per-feature

Each `/deliver` run gets its own worktree. Agents see only the working state for *this* feature, not unrelated branches/files. Removes a category of grep noise without anyone having to think about it.

### 3. Phase outputs as files, not conversation

Phases write to `outputs/phase-N-*.md`; the next phase reads what it needs. The conversation thread doesn't carry every artifact forward.

### 4. Structured-block extractor

The exact intervention this principle predicts. Phase 3 reading 5K of architect prose to extract a service list = noise. Reading a 0.2K JSON block via `extract-block.js` = signal only. Same information, ~25× the precision per consumer. See [`extractor-enhancement.md`](./extractor-enhancement.md) — the impact estimate (17–30K tokens saved per `/deliver` run) is the precision delta made concrete.

### 5. CLAUDE.md as a shallow index

CLAUDE.md auto-loads into every agent that touches a repo, so it's intentionally **thin** — an index, not the docs. Deep content lives in `agent-context/common/{topic}.md` and loads only when a task actually needs it. Always-loaded content is precious; pay for it sparingly.

### 6. TYPE_TO_AGENT routing (Phase 5b / 5.5)

Frontend dispatch routes by repo `type` (`react` → `react-feature-implementer`, `nextjs` → `nextjs-implementer`). The orchestrator loads only the implementer it'll dispatch — not all 11. Each implementer prompt is 200–600 lines; loading the wrong 10 would be pure noise.

### 7. spec_policy switch

`api-first` / `code-first` / `no-api` routes implementers through different code paths within their own system prompt. A worker implementer never reads OpenAPI guidance; a Spring Boot implementer never reads event-schema guidance. Same agent file, different sections active per dispatch.

### 8. Schema referenced by path, not inlined

Agent prompts say "match `templates/blocks/affected-services.example.json`" instead of inlining the schema. The schema isn't loaded into the agent's context until it's actually emitting that block. Bonus: single source of truth — but precision is the original reason.

### 9. Reviewer pre-computes gate-relevant counts

`FINDINGS_SUMMARY` exists so Phase 5.5 Step 2's gate decision doesn't need to re-read the full FINDINGS table and count rows. The reviewer aggregates (it has all findings in context anyway); the orchestrator pulls 5 numbers. Detail rows stay in the report file for human review but never re-enter orchestrator context.

### 10. Scratchpad as structured state, not narrative

Phase status lives in a small structured file, not a chat log. The orchestrator reads "Phase 3 = COMPLETED, Phase 4 = IN_PROGRESS" in ~200 tokens and skips the prose history.

### 11. Karpathy pass — explicit noise removal

The recent refactor trimmed `docs/implementer-common-rules.md` R0 from ~280 words to ~50 and R3 from a 9-bullet list to a 4-line principle. Same teaching, less context cost, every implementer dispatch. See [`karpathy-assessment-v3.md`](./karpathy-assessment-v3.md).

### The pattern

The plugin treats **always-loaded context** (CLAUDE.md, agent system prompts, SKILL.md preambles) as expensive and **on-demand context** (Read, Grep, file artifacts) as cheap. It pushes work toward the on-demand side: shallow indexes pointing to deep files, schemas referenced by path, agents dispatched per-type, structured artifacts replacing prose hand-offs. None of this was framed as "context engineering" while being built — it emerged from "this is getting too long" pressure — but it's consistent across the codebase.

---

## Where slack still exists

Honest gaps, in order of size:

### A. Architect output prose still re-parsed by consumers

`outputs/phase-2-architecture.md` carries `API_DESIGN`, `DATA_MODEL`, `INFRASTRUCTURE_IMPACT`, `RISKS`, `FRONTEND_ARCHITECTURE`, `CONTRACT_DESIGN` — all still prose-only. Only `AFFECTED_SERVICES` got the JSON treatment. Each downstream consumer that needs one of these still LLM-parses 3–5K of prose.

**Why not yet**: prose has narrative value (rationale, alternatives) for human review. Migrating means deciding per-block which fields are programmatically consumed vs. which are pure narrative.

### B. Long dispatch prompts

Phase 5.5 reviewer dispatch is long: precondition check + auto-fix-mechanical instructions + loop logic + run-specific values, all interleaved. Some static framing could move into the reviewer agent's system prompt (loaded once, cached) instead of being re-pasted every dispatch.

### C. No selective SKILL.md loading

Every `/deliver` run loads the full `skills/deliver/SKILL.md` preamble, even though most phases only need a subset. Could be split into per-phase files. Hasn't been worth it yet, but it's a known cost.

### D. Tool inventory cost

The utility scripts inventory we added to SKILL.md costs ~250 tokens loaded every run. Net positive (it unlocks 17–30K of savings via the extractor) — worth naming as deliberate spend rather than accidental.

---

## Recommended additions, ranked

1. **Eval harness for task faithfulness** — *the highest-value missing piece.* Without it, prompt changes (Karpathy refactor, future trims) can silently regress quality. This doc ships alongside [`eval/`](./eval/) — the layered scaffold for it. See `eval/README.md`.
2. **Attention-first prompt redesign of the 3 longest dispatch templates** — critical instructions at the top *and* restated near the end, integrity checks on enumerable inputs, stable rules in agent system prompts vs per-call content in dispatch user messages. The full plan lives in [`attention-and-caching.md`](./attention-and-caching.md) (the principle) and [`attention-work-plan.md`](./attention-work-plan.md) (the per-pass execution). **Goal is anti-forgetting; cache friendliness falls out as a side effect.**
3. **Extended thinking on reasoning-bottleneck agents** — turn it on for `solution-architect`, `security-consultant`, and reviewer gate calls. Leave it off everywhere else. Quality lift on the steps that bottleneck pipeline correctness.
4. **Continue the structured-block migration for what implementers consume** — `API_DESIGN`, `DATA_MODEL`, `INFRASTRUCTURE_IMPACT` are the next candidates after `AFFECTED_SERVICES`. Each migration cuts attention noise for downstream consumers; see [`attention-work-plan.md`](./attention-work-plan.md) Pass D.

---

## What this doc is *not*

- Not a performance benchmark — no measured tokens-per-second or end-to-end latency numbers. The 17–30K/run figure in `extractor-enhancement.md` is the only concrete measurement, derived from per-call file sizes, not from runtime profiling.
- Not a formal eval — that's `eval/`.
- Not a redesign proposal — it documents principles already in use and gaps already known. It's an audit, not a refactor.

---

## See also

- [`attention-and-caching.md`](./attention-and-caching.md) — the focused lens on attention as the primary design constraint; reframes recommendations #2 and #4 above
- [`attention-work-plan.md`](./attention-work-plan.md) — the per-pass execution plan implementing those recommendations
- [`extractor-enhancement.md`](./extractor-enhancement.md) — the structured-block work; the canonical example of context-precision applied
- [`karpathy-assessment-v3.md`](./karpathy-assessment-v3.md) — the Simplicity-First pass that trimmed always-loaded content
- [`docs/file-formats.md`](./docs/file-formats.md) — schema reference for the structured blocks
- [`eval/`](./eval/) — the eval harness this doc recommends
