# Claude Code `Workflow` tool — overlap with PipeCrew + integration plan

**Status**: exploration / strategy doc — not a commitment to ship.
**Date**: 2026-05-31

---

## The core framing

**Workflow** is *just-in-time orchestration* — you define the workflow per task, then it runs. The pipeline is generated per invocation; the shape is decided at call time.

**PipeCrew** is *curated orchestration* — the workflow is pre-defined by the skill (`/deliver` always runs phases 1 → 8 in the same order). The feature is the input; the pipeline is fixed.

Analogous to `bash` vs `make`: bash lets you author any sequence of steps fresh; make has a stable target graph and you parameterize it. They're not competing — they sit at different altitudes.

This framing is the whole point of the integration: **PipeCrew owns the pipeline shape (phases, gates, agents, contracts); Workflow owns the runtime mechanics inside any single phase that fans out**.

| Layer | Owner |
|---|---|
| Pipeline shape (which phases, in what order, what gates) | PipeCrew |
| Phase-internal fan-out (how many parallel agents, what schema, what concurrency) | Workflow |
| Per-invocation runtime of a fan-out phase | Workflow, dispatched by PipeCrew |

---

## What the `Workflow` tool is

A new JavaScript-based orchestration primitive exposed by the Claude Code harness. You author a script with `meta`, `agent()`, `parallel()`, `pipeline()`, `phase()` and an optional JSON `schema:` per agent. Key properties:

- **Deterministic control flow** — loops, conditionals, fan-out in JS, not LLM-driven
- **Custom subagent types** — `agentType: 'pipecrew:solution-architect'` calls any registered agent
- **Worktree isolation** — `isolation: 'worktree'` flag spins a fresh worktree per agent (auto-cleaned if no changes)
- **Token budget** — `budget.remaining()` is a HARD ceiling; calls throw once spent
- **Schema-enforced output** — `schema:` validates at the tool-call layer, model retries on mismatch
- **Journaled resume** — same-script + same-args → instant cache replay; first edited call re-runs live (same-session only)
- **Concurrency cap** — min(16, cpu-2) slots, excess queued
- **Total agent cap** — 1000 per workflow lifetime (runaway-loop backstop)

Runs in the background — invocation returns a task ID immediately, a `<task-notification>` arrives on completion.

---

## Overlap map

| Concern | PipeCrew today | `Workflow` tool |
|---|---|---|
| Multi-agent dispatch | Main loop reads markdown phase file, fans out `Agent` tool calls | Script-driven, deterministic |
| Structured I/O between agents | JSON-fenced blocks + `split-design.js` + `extract-block.js` + per-block validators | `schema:` enforced at tool layer; auto-retry on mismatch |
| Phases | Numbered markdown files in `skills/*/phases/*.md` | `phase()` groups in script |
| Per-repo isolation | Custom worktree dance per skill | First-class `isolation: 'worktree'` flag |
| Resume | `state.json` + `checkpoints.jsonl` (git-aware, cross-session) | Journal cache (same-session only) |
| Concurrency | Implicit; relies on main loop firing parallel tool blocks | Slot system, capped, queued |
| Token budgets | Not enforced anywhere | `budget.remaining()` is a hard ceiling |
| Caching by content key | `scripts/discover-cache.js` (head_sha + schema_version) | Journal keyed on (prompt, opts) identity |
| Observability | `checkpoints.jsonl` + site-view SSE | Built-in progress tree via `phase()` + `log()` |

**Asymmetry**: PipeCrew owns the **domain knowledge** (per-stack implementer agents, block schemas, workspace concept, observability routing table, human gates). The Workflow tool owns the **engine** (deterministic flow, schema enforcement, journal resume, budget guard, real concurrency).

The two aren't competing — they're complementary layers. PipeCrew's prose phase files are doing engine work today (poorly, in some places), and Workflow is doing it better while having no opinions about backend-stack agents or cross-repo state.

---

## Where Workflow wins outright

1. **Pipeline-without-barriers semantics.** PipeCrew's per-repo fan-outs today block on the slowest agent before moving to the next phase. `pipeline()` lets each item flow through all stages independently — discover repo A can be validating while discover repo B is still running.
2. **Schema validation is a tool-layer retry, not a downstream parse failure.** Today an architect emits a malformed `RISKS` block, `split-design.js` writes garbage to `outputs/blocks/risks.json`, and the failure surfaces three phases later in task-planner. With `schema:`, the agent gets told "your output didn't match" and retries immediately.
3. **Budget-driven scaling.** A `/discover --budget=500k` flag could literally drive `while (budget.remaining() > 50_000)` to scale depth — more parallel discoverers, more architect review passes — instead of being a fixed agent count baked into markdown.
4. **Adversarial verify is a 5-line pattern.** Reviewer findings could be skeptically refuted by N independent verifiers before reaching the user — today this would be a multi-phase rewrite.

## Where PipeCrew wins outright

1. **Cross-session resume.** Workflow journals are session-bound. `state.json` survives Claude Code restarts. Long-running `/discover` runs that get interrupted need PipeCrew's resume contract, not Workflow's.
2. **Human gates between phases.** "Architect designs → user reviews → user types `continue` → implementation fans out" doesn't fit in one workflow script (workflows run in background; gates need interactive turn boundaries).
3. **Domain agents.** PipeCrew's per-stack implementers (Spring Boot, NestJS, FastAPI, Django, Flask, React, Next.js, Terraform, CDK, ...) carry years of accumulated stack-specific prompt engineering. Workflow doesn't replace them — it dispatches them via `agentType:`.
4. **Workspace concept.** Multi-repo workspace state, per-stack `stacks/{type}.md` docs, the discover→deliver→learn lifecycle — none of this is in Workflow's scope.

---

## Five hybrid power moves

### 1. Replace phase dispatchers with workflow scripts (selectively)

Markdown phase files become the *contract* (what the phase does, what blocks it produces, what it expects). The *runtime* becomes a workflow script alongside the markdown. Pilot candidate: `/discover` Phase B2.0 (per-repo discoverer fan-out) — it's the most controlled fan-out in the plugin.

### 2. Schemas replace JSON-fence parsing for new blocks

Existing blocks (REPO_PROFILE, AFFECTED_CONTRACTS, RISKS, FRONTEND_ARCHITECTURE) keep their markdown-fence format for back-compat with `split-design.js`. New blocks added via Workflow use `schema:` directly — no `<!-- BEGIN X -->` markers, no extract step.

### 3. Adversarial-verify the reviewer

Phase 5.5 today = one reviewer agent. Wrap with a workflow that runs the reviewer, then fans out N skeptics per finding using the "perspective-diverse verify" pattern (correctness, security, repro). Drop findings where the majority refute. Cuts false-positives, improves user trust in reviewer output.

### 4. Budget-aware `/discover` and `/deliver`

Add a `--budget` flag → workflow uses `budget.remaining()` to gate optional passes (extra discoverer rounds, deeper architect synthesis, second-opinion reviewer). Today's depth is baked in; tomorrow's scales to the user's directive.

### 5. Loop-until-dry for `/assess`

Cross-repo assessment is single-pass today. Wrap with a workflow that keeps finding integration gaps until two consecutive rounds return nothing new. Same pattern as the canonical "find bugs, judge by 3 lenses, loop until dry" example in the tool docs.

---

## Where the two conflict (and how to resolve)

| Conflict | Resolution |
|---|---|
| Workflow runs in background; PipeCrew has interactive human gates between phases | Keep markdown skills as the **top-level orchestrator** (gates between phases). Drop into Workflow only for the bounded fan-out steps within a single phase. |
| Workflow's journal is same-session; PipeCrew's resume is cross-session | Keep `state.json` + `checkpoints.jsonl` as the cross-session resume contract. Use Workflow's journal opportunistically inside a single run. |
| `schema:` validation vs. existing JSON-fence + validator scripts | Don't migrate existing blocks — back-compat with `split-design.js` matters. Use `schema:` only for new blocks introduced via Workflow. |
| Site-view consumes `checkpoints.jsonl`; Workflow has its own `/workflows` progress view | Workflow's progress is for the developer authoring the script; site-view stays the user-facing view. Workflow agents inside a phase emit `checkpoints.jsonl` entries via the existing `Agent`-tool wrapping. |

---

## Suggested pilot: `/discover` Phase B2.0

Pick one phase as the proving ground.

**Why B2.0**:
- Embarrassingly parallel (each repo independent)
- Stable contract: REPO_PROFILE JSON + schema_version
- Already has a cache plan/commit boundary (Win #6)
- No human gate inside the phase
- Failure mode is bounded (one bad repo profile → rescan, not a full rerun)

**Shape of the workflow**:

```javascript
export const meta = {
  name: 'discover-b2-per-repo',
  description: 'Per-repo discovery fan-out with cache-aware reuse',
  phases: [
    { title: 'Plan',     detail: 'cache decision per repo' },
    { title: 'Discover', detail: 'sonnet repo-discoverer per repo flagged rescan' },
    { title: 'Validate', detail: 'shape-check each profile' },
    { title: 'Commit',   detail: 'update state.json' },
  ],
}

const plan = await agent('Read state.json and decide per-repo reuse/rescan...', {
  phase: 'Plan', schema: PLAN_SCHEMA,
})

const results = await pipeline(
  plan.rescans,
  repo => agent(repoDiscovererPrompt(repo), {
    agentType: 'pipecrew:repo-discoverer',
    phase: 'Discover', schema: REPO_PROFILE_SCHEMA,
    label: `discover:${repo.repo_key}`,
  }),
  (profile, repo) => agent(validatePrompt(profile, repo), {
    phase: 'Validate', schema: VALIDATION_SCHEMA,
    label: `validate:${repo.repo_key}`,
  }),
)

await agent(commitPrompt(plan.reuses, results), { phase: 'Commit' })
```

~100 lines. Drop-in replacement for the per-repo dispatch section of `phase-b2-0-repo-discovery.md`. The markdown keeps its CRITICAL/contract framing; the runtime becomes deterministic.

**Validation criteria** for the pilot:
- Wall-clock at parity or better than the markdown-driven dispatch
- Schema retry catches at least one malformed REPO_PROFILE in real ABVI runs
- Resume from journal works inside a single session (kill mid-run, re-invoke)
- site-view + `checkpoints.jsonl` still populate correctly

**Out of scope for the pilot**:
- Multi-phase workflows
- Budget-aware scaling
- Adversarial verify
- Anything in `/deliver`

If the pilot pays off, propagate to:
1. `/deliver` Phase 5 (parallel implementers per repo)
2. `/deliver` Phase 5.5 (reviewer + adversarial verify)
3. `/assess` (loop-until-dry)

If it doesn't (e.g., debugging workflow scripts is worse than debugging markdown phase files), abandon and document the failure mode.

---

## Open questions

1. **Does `agentType: 'pipecrew:*'` work for plugin-registered agents?** The tool doc says "resolved from the same registry as the Agent tool" — needs verification with a tiny smoke workflow before any real integration work.
2. **How do checkpoints emit from agents called inside Workflow?** If they don't, site-view goes dark during workflow phases. Need to confirm or wrap.
3. **What happens to `--refresh-cache`-style flags?** They'd need to thread through `args` to the workflow, which is doable but means the markdown skill becomes a thin wrapper that builds the args object.
4. **Cost.** Workflow doesn't change agent token cost, but the orchestrator-loop tokens currently spent reading markdown phase files get saved — modest but real.

---

## Recommendation

Pilot Phase B2.0 only. One controlled experiment against the most stable phase contract in the plugin. If it works, the pattern propagates to the other 80% of fan-out work in `/discover` and `/deliver`. If it doesn't, we learned something and lost a day, not a quarter.

Do **not** do a big-bang rewrite of all phase files into workflow scripts. The markdown files are doing legitimate work (human readability, contract documentation, gate framing) that JS scripts would degrade.
