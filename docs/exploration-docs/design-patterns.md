# PipeCrew — design-patterns inventory

**Context-engineering + multi-agent techniques used throughout the plugin.**

This doc is a reference for "what disciplines does the system actually follow?" — useful when adding a new agent, a new artifact, or a new skill, so the new addition follows the same patterns rather than inventing new ones.

---

# Context engineering

## 1. Tier-stratified context (4 tiers)

The plugin partitions information by lifetime + scope:

| Tier | Where | Lifetime | Read by |
|---|---|---|---|
| **Plugin** (`docs/pitfalls/{type}.md`, `templates/`, agent prompts) | Plugin source | Versioned with plugin | Pre-injected into per-task files (not loaded directly by implementers) |
| **Workspace** (`platform.md`, `learn-log.md`) | `{workspace_root}/{slug}/context/` | Durable across runs | Orchestration-tier agents only |
| **Per-repo** (`CLAUDE.md`, `agent-context/`, `DESIGN_SYSTEM.md`) | Inside each repo | Lives with the code | Every agent that touches the repo |
| **Per-run** (scratchpad, checkpoints, `outputs/blocks/`, `tasks/`) | `runs/{skill}/{run_id}/` | Ephemeral per invocation | Run-scoped agents |

**Why this matters**: doesn't conflate "what we know forever" with "what we did once", and each consumer reads only the tier it needs.

## 2. Task file as the implementer's bottleneck input

The single most important pattern. Phase 4.5's `task-planner` pre-builds a self-contained markdown file per sub-task — FR/EC list, architecture context, Contract Reference, Known Pitfalls, Out of Scope. Phase 5 dispatch carries only `task_id` + `worktree_path`; the implementer reads the task file once. **Per-dispatch input bounded to ~5K tokens instead of ~30K+**, regardless of workspace size. This is what makes the system scale to N repos.

## 3. JSON blocks inside markdown via BEGIN/END markers

The architect's `phase-2-architecture.md` is a single human-narrative file BUT contains 8 fenced JSON blocks delimited by `<!-- BEGIN X -->` / `<!-- END X -->`. `scripts/split-design.js` runs after Phase 2 and materializes each as `outputs/blocks/<slug>.json`. Downstream consumers `cat` the small side file (~1–3 KB) instead of re-loading the 30K+ markdown. Schema discipline — every block has a canonical example in `templates/blocks/*.json` and a reference in `templates/blocks/block-schemas.md`. Producer–consumer contract is explicit and machine-validated.

## 4. Lazy phase loading

Each phase lives in its own file under `phases/`. The skill's `SKILL.md` is the always-loaded index; phase files are read only when entering that phase. Auto-compaction drops them when the phase ends. Mid-run context stays lean — at any moment the orchestrator has roughly: SKILL.md + active phase file + scratchpad + per-call agent prompt.

## 5. Pointers, not copies

Deferred follow-up files (`{workspace_root}/{slug}/deferred/{feature-slug}.md`) contain **pointers** to the source run's `outputs/phase-2-architecture.md` `<!-- BEGIN DATA_MODEL -->` block, not embedded copies. Avoids stale duplicates. Same for the task files' "Architecture context" sections — they reference `outputs/blocks/*.json` paths.

## 6. YAML frontmatter for machine state, body for human content

Every task file has YAML frontmatter (`id`, `repo`, `fr_refs`, `status: todo→done`, `cumulative_total_tokens`, `last_worked_by`). The body is human-readable narrative. Implementer flips `status` and bumps `cumulative_*` counters via Edit; the orchestrator parses frontmatter for the dispatch log. Same pattern in deferred files (`status: pending→consumed`).

## 7. Section extraction without LLM re-parse

`scripts/extract-block.js` pulls one named section from any markdown file (default = JSON-fenced inside the section; `--raw` = the whole section body). Phase docs cite the exact extract command at point-of-use. The orchestrator never asks an LLM to re-parse markdown when the content is structured.

## 8. Pre-injection over per-dispatch loading

Per-stack pitfalls live in the plugin (`docs/pitfalls/{type}.md`). The `task-planner` filters them per task and injects relevant bullets into each task file's `## Known Pitfalls` section. Implementer doesn't load pitfalls; they read their task file. Same pattern for FR/EC filtering — the planner pulls only the FR/EC bullets relevant to THIS task's repo into THIS task's file.

## 9. Workspace agents as system-prompt baked

`{slug}-product-owner`, `{slug}-ux-consultant`, `{slug}-assessor`, `{slug}-troubleshooter` — domain context is **baked into the system prompt at agent-publish time** (Phase C). Subsequent dispatches don't re-inject domain. Prompt-cache benefits across the run, plus the agent's identity carries the workspace's vocabulary without per-call data injection.

## 10. Scratchpad (state) vs checkpoints.jsonl (event log)

Two artifacts, two jobs:

- **scratchpad.md**: human-readable phase state — what's complete, what's pending, the dispatch log. Used by `--resume`.
- **checkpoints.jsonl**: machine event log with unified schema across skills. Used by reporter, site-view, trend comparison.

Both kept; neither replaces the other.

## 11. Architect–planner–implementer hierarchy (post-Phase-4.5-split)

Layered scope:

- **Architect** (Opus): reasons across workspace; outputs design + TASK_SKELETON.
- **Planner** (Sonnet, three-mode): hydrates skeleton with workspace-shaped material (pitfalls, audit findings, post-Phase-3 spec paths) into per-task files.
- **Implementer** (per-stack): consumes one task file, follows R10 to inherit patterns from existing code.

Each layer's input is bounded; each does only what its role uniquely qualifies it for.

## 12. R10 + Pattern Adherence pass instead of stacks/{type}.md

Implementers told to "find closest analog in this repo before writing"; reviewers gate-check via a Pattern Adherence pass (mechanical = Non-critical; architectural = Critical, with `## Assumptions` as escape valve). Discipline-via-rule replaces docs-that-drift. Replaced the previous per-stack convention docs (`stacks/{type}.md`) entirely.

---

# Multi-agent orchestration

## 1. Fan-out parallelism in single Agent message

`/deliver` Phase 5 dispatches backend + frontend + mock + infra implementers in **one orchestrator message with multiple Agent tool calls** — they run concurrently. Same for Phase 5.5 reviewers (parallel per repo) and the upcoming Phase B2.0 (parallel `repo-discoverer` per repo). The "single message, multiple Agent calls" pattern is the parallelism primitive.

## 2. Gated stages with cheap checkpoints

The pipeline is sequenced: Phase 1 → gate → 2 → gate → 3 → gate → 4.5 → gate → 5 → 5.5 → gate-on-criticals → 6 → 7 → 8. Each gate is a place where the user can redirect cheaply, before the expensive next step fires. Phase 4.5's "Approve all / Minimum only / Adjust" is a particularly tight gate UX — three escape hatches before kicking off N parallel implementers.

## 3. Per-stack agent specialization

Twelve implementer agents (one per stack) instead of one polyglot agent. Each has stack-specific invariants (Spring Boot's "@RestController + GlobalExceptionHandler"; React's "spec → typed → React Query → Component" flow; CDK's stage/regionSuffix pattern). Polyglot would lose this discipline. Same for reviewers (4 stack-specific code reviewers).

## 4. Three-mode agent contract (planner, openapi-spec-editor, feedback-learner)

Some agents have multiple modes parameterized by a `mode:` field in the dispatch. The task-planner has `draft` / `adjust` / `persist`. The feedback-learner has `pr` / `run` / `branch` / `text`. Avoids spawning N variants of the same agent for related tasks.

## 5. Worktree isolation per dispatch

Phase 3 + Phase 5 default to **one worktree per repo touched** (`{repo}-{feature-slug}` sibling dir on `feature/{feature-slug}` branch). Implementers always work in their worktree; orchestrator never lets them touch the user's main checkout. Multiple parallel implementers can write different repos safely (no contention, no race). User can `git diff` the worktree without context-switching.

## 6. Adjust-loop determinism via re-derivation

The planner's `adjust` mode re-derives from the **original TASK_SKELETON every round**, applying the *accumulated* adjustments list. Two rounds with the same final pushback list converge to the same output. No "drift across re-rolls" — the canonical input is constant.

## 7. Read-only enforcement via three independent layers

`/troubleshoot` is the only read-only skill. Three layers ensure it stays that way:

1. Agent system prompt has HARD RULES (R1: Bash allowlist, R2: blocklist, R3: pre-flight self-check, R6: only `report.md` writes).
2. `scripts/troubleshooter-bash-guard.js` validates Bash calls against an allowlist (111 unit tests).
3. `PreToolUse` hook in `.claude-plugin/hooks/hooks.json` invokes the guard.

The hook self-gates on a marker file (`~/.claude/.pipecrew-troubleshooter-active`) so it's a no-op outside an active `/troubleshoot` run. Self-cleans on stale pid. Defense-in-depth via marker pattern.

## 8. Cross-repo verification (assessor) ≠ fix dispatch

The assessor agent diagnoses cross-repo issues but **doesn't fix anything**. It produces PASS / PARTIAL / FAIL with per-repo fix assignments. The orchestrator (with user gate) re-dispatches the original Phase 5 implementers to apply fixes. Separation of concerns: the diagnosing agent has different incentives + tooling than the fixing agent.

## 9. Standalone fix-round-only invocation

`/learn` (and Phase 5.5 fix rounds) re-dispatch the same Phase 5 implementer agents but with a **fix-list** instead of a task file. Same agent, different prompt structure. Avoids parallel "implementer" and "fixer" agent definitions; the implementer agent's R6 (scope discipline) keeps it from over-reaching.

## 10. Workspace-published vs plugin-shipped agent split

- **Plugin-shipped**: stack-specific (spring-boot-api-implementer, react-code-reviewer, security-consultant, schema-implementer). Stack knowledge doesn't change per workspace.
- **Workspace-published**: domain-specific (`{slug}-product-owner`, `{slug}-assessor`). Generated at `/discover` Phase C from a template + the workspace's actual platform.md. Published to `~/.claude/agents/` so Claude Code resolves them as first-class subagent types.

Plus a **fallback chain**: if a workspace agent isn't found, dispatch falls back to `general-purpose` with a preamble that reads `{workspace_root}/{slug}/agents/{role}.md`. Hand-edits to workspace agents persist; users can customize without forking the plugin.

## 11. Deferred work as a first-class artifact

When the user picks "Minimum only" at Phase 4.5, deferred sub-tasks become a `{workspace_root}/{slug}/deferred/{feature-slug}.md` file with frontmatter `status: pending`. A future `/deliver --from-deferred=<slug>` resumes against current state. Phase 7 flips `status: pending → consumed` on success, with `consumed_at` and `consumed_by_run_id` for audit trail. Lets users ship in increments without losing work, with a paper trail.

## 12. Unified observability across skills

All skills (`/discover`, `/deliver`, `/learn`, `/context-refresh`, `/troubleshoot`) emit the **same JSONL event schema** (`run_start`, `phase_start/end`, `agent_end`, `retry`, `bash_slow`, `run_end`) into their run-dir's `checkpoints.jsonl`. Same reporter agent, same site-view UI, same trend comparison work for every skill — no per-skill telemetry. `validate-checkpoints.js` enforces the schema.

## 13. Site-view from telemetry, not from agents

The site-view UI watches `scratchpad.md` + `checkpoints.jsonl` via SSE and renders character animations + pyramid tiers. **No agent has to "report to UI"** — agents emit standard events; UI consumes them. Decoupled by design.

## 14. SendMessage for continuation, new dispatch for fresh start

When an agent's response is incomplete, the orchestrator uses `SendMessage` to continue the existing agent (preserves working memory, no re-prompt cost). When fresh perspective is needed (a different agent type, or restart on a new task), spawn a new Agent dispatch. The two have different cost profiles and the system uses both deliberately.

## 15. Tiered finding severity with classification-driven gating

Reviewer findings are tiered: Critical (mechanical | architectural classification) / Non-critical / Suggestions. Different tiers gate differently:

- 0 criticals → no gate, no fix round.
- All criticals mechanical + `--auto-fix-mechanical` → no gate, auto-dispatch.
- Any critical architectural → user gate fires.
- Missing classification → defaults to architectural (forces gate).

The escape hatch (`--auto-fix-mechanical`) is conservative by design — the safer behavior is the default; the optimization is opt-in.

## 16. Workspace-tier scaffold pattern

`/discover` produces the durable workspace scaffold (`config.json` + `context/platform.md` + `agents/` + repo `CLAUDE.md`). All other skills consume that scaffold. The scaffold is created **once**; `/learn` and `/context-refresh` keep it current; `/discover --resume` re-runs it. Bootstrap-and-evolve, not bootstrap-every-run.

## 17. Two-author pattern (script + LLM)

`scripts/extract-observability.js` does the deterministic, regex-extractable work for free (walks IaC files, extracts log destinations). The LLM curates what scripts can't reliably extract — operator dashboards, runbook URLs, trace headers. Each does what it's best at; neither does what the other does better. (`extract-repo-manifest.js` was tried with this pattern but rejected after testing — see `discover-enhancement.md`.)

## 18. Cost gating on heavy phases

`/discover` Pre-phase 0.2 reads `~/.claude/stats-cache.json` and warns if today's usage exceeds 80% of the observed daily ceiling. Doesn't block — informs. Same gate runs at `/deliver` pre-flight. Lets the user defer a heavy run rather than hitting a rate limit mid-pipeline.

## 19. R-rule centralization (R0–R10)

`rules/implementer-common.md` defines 11 numbered rules every implementer must apply. Each implementer agent prompt cites by number ("R0, R1, R6, R7, R8, R9, R10 are load-bearing — do not restate them, just follow them"). Centralized + numbered + reusable. Reviewers enforce them by number ("Pattern Adherence pass — R10 enforcement").

## 20. Scratchpad-driven resume

Every skill's run dir has `scratchpad.md` with a Phase Status table. `--resume` reads the phase status and continues from `Current Phase`. Failure recovery without losing intermediate work. Combined with `checkpoints.jsonl` (machine state), the system is genuinely resumable across context-limit interruptions.

---

# Synthesis — three principles

If I had to compress these 30+ techniques into three principles:

1. **Bound per-dispatch input.** No agent should ever load workspace-wide context unless its job genuinely requires synthesis. The task file pattern, JSON-block side files, lazy phase loading, and pre-injection of pitfalls all serve this.

2. **Specialize agents to bounded scopes.** Per-stack implementers and reviewers, three-mode agents, workspace-published vs plugin-shipped, architect–planner–implementer hierarchy — each agent has the smallest possible scope that lets it do its job competently.

3. **Make state machine-extractable, narrative human-readable, and unify telemetry.** YAML frontmatter + JSON blocks + checkpoints.jsonl let scripts and tools work without LLM re-parsing. Same telemetry powers reporter + UI + trends across every skill.

The plugin pays a real complexity cost for these — multiple agent definitions, schema discipline, structured outputs — but the payoff is that a multi-repo `/deliver` run can dispatch 10+ agents in parallel with bounded per-dispatch input, gate cheaply, fix narrowly, and trace the whole thing through one event log.

---

# When to apply each pattern (decision aids)

If you're **adding a new agent**, ask in this order:

1. Does it need workspace-wide context, or one repo's worth?
   - Workspace-wide → orchestration tier (read platform.md, multiple artifacts).
   - One repo → light reader (task file + repo's CLAUDE.md only).
2. Is it stack-knowledge (any workspace using this stack) or domain-knowledge (this specific workspace)?
   - Stack → plugin-shipped agent.
   - Domain → workspace-published, generated by `/discover` Phase C from a template.
3. Will it have multiple modes (draft/adjust/persist style)?
   - Yes → one agent definition with a `mode:` field, not N agents.
4. Does it need to dispatch other agents?
   - Yes → it's an orchestration agent; consider whether the orchestrator could do this directly instead.
   - No → it's a worker; can be parallelized cleanly via fan-out.

If you're **adding a new artifact**, ask:

1. What's its lifetime? (plugin / workspace / per-repo / per-run)
2. Is it machine-extractable (JSON block, frontmatter) or narrative (prose)?
3. Who reads it? Add to the access matrix in `context-map.md`.
4. Who writes it? Should the writer also be a consumer, or strictly producer?
5. If frequently read by many agents, can it be split into smaller side files (BEGIN/END pattern)?

If you're **adding a new skill**, ask:

1. Does it produce or consume workspace context? (probably consumes if it's a feature skill; produces if it's a maintenance skill)
2. Does it emit `checkpoints.jsonl` events? (it should — same schema as the others)
3. Does it interact with the site-view UI? (only if it's a long-running pipeline like `/deliver`)
4. Is it gated by user approval at the right places? (one gate per "next step is expensive or visible")

---

# See also

- [`PIPECREW-DISCOVERY.md`](../PIPECREW-DISCOVERY.md) — overview of the plugin
- [`rules/implementer-common.md`](../implementer-common-rules.md) — R0–R10, the implementer contract
- [`templates/blocks/block-schemas.md`](../../templates/blocks/block-schemas.md) — schema reference for structured blocks
- [`docs/exploration-docs/context-map.md`](./context-map.md) — what `/discover` creates and which agents read what
- [`docs/exploration-docs/discover-enhancement.md`](./discover-enhancement.md) — six wins, current status of each
