# PipeCrew vs Claude Code Agent Teams — what each has, what each lacks

**Date**: 2026-04-28
**Source for Agent Teams**: <https://code.claude.com/docs/en/agent-teams> (experimental feature, behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, requires Claude Code v2.1.32+)
**Source for PipeCrew**: this plugin (`marketplaces/pipecrew/`)

Both coordinate multiple agents. They solve **different problems**, with **different architectures**, at **different maturity levels**. Honest split below.

---

## Quick framing

| | **Agent Teams** | **PipeCrew** |
|---|---|---|
| **What it is** | Claude Code feature (experimental, opt-in flag) | Production plugin |
| **Worker unit** | A full **Claude Code session** per teammate | A **subagent** (single `Agent` tool call within one session) |
| **Workflow shape** | Free-form, lead-orchestrated, peer-messaging | Linear pipeline of phases, phase-internal parallelism |
| **Best for** | Parallel exploration where teammates need to **talk to each other** | Shipping a feature **end-to-end across multiple repos** |
| **Maturity** | Experimental, opt-in, "known limitations" | Production-stable, plugin-installable |

---

## The architectural divide (the one that explains everything else)

### Agent Teams = multiple **sessions** with peer mailboxes
Each teammate is its **own Claude Code process** with its own context window, permission state, and tools. Coordination via:
- Shared task list with file-locking (`~/.claude/tasks/{team}/`)
- Mailbox for direct teammate-to-teammate messages
- Team config (`~/.claude/teams/{team}/config.json`) the lead manages
- Hooks (`TeammateIdle`, `TaskCreated`, `TaskCompleted`)

Teammates message each other by name. The lead doesn't proxy.

### PipeCrew = one session orchestrating **subagents** through a pipeline
Exactly one Claude Code session — the orchestrator. It dispatches subagents via the `Agent` tool, each in its own context window inside the same session. Coordination is implicit:
- Subagents return one report and disappear
- The orchestrator collects reports and threads outputs into the next phase
- Subagents **never talk to each other**
- Phase outputs (markdown files with structured JSON blocks) are the inter-phase contract

Pipe-and-filter architecture. Teams is a peer mesh.

---

## What Agent Teams has that PipeCrew doesn't

### 1. Peer-to-peer messaging between workers
Teammate-A directly messages Teammate-B via the mailbox. PipeCrew has no equivalent — implementers running in parallel can't communicate; they only see the task file and produce a report.

**Why it matters**: enables "scientific debate" patterns (the doc's example: 5 teammates investigating competing hypotheses, debating each other to disprove their own theories). PipeCrew's reviewer-vs-implementer fix loop happens via the orchestrator as middleman, not directly.

### 2. Self-claiming task pool
A teammate finishes work and claims the next unblocked task autonomously. File locking prevents races. PipeCrew's Phase 4.5 produces task files but the orchestrator hands them out; agents don't self-claim.

**Why it matters**: lets a small team chew through a backlog with minimal orchestrator decisions. Good when work is genuinely uniform.

### 3. Live human steering of a specific worker
User presses Shift+Down to cycle to a specific teammate's session and sends them a message mid-flight. Or in split-pane mode, clicks into the pane and types. PipeCrew has approval gates at pre-defined points (architecture, spec edits, fix rounds) but no per-agent live steering.

**Why it matters**: when you realize Teammate-3 is going down a rabbit hole, you can redirect just them without restarting the team.

### 4. Display modes (split panes)
tmux or iTerm2 split panes show every teammate's terminal at once. PipeCrew has the **site-view** browser UI (live timeline, characters representing agents) but it's **passive observation** — you can't type into a teammate's session from there.

### 5. Plan-approval workflow per teammate
A teammate can be required to plan before implementing. The lead reviews and approves/rejects with feedback. PipeCrew has gates at the **architecture** and **spec-edit** levels but not per-implementer.

### 6. `TeammateIdle` / `TaskCreated` / `TaskCompleted` hooks
Hooks at the team-event level can block or send feedback (exit code 2). PipeCrew has its own checkpoint/scratchpad system and `gate.js` for approvals, but no hook surface at the agent-task level.

### 7. Full Claude Code session per worker
Each teammate has unrestricted tool access (subject to its permission mode). PipeCrew's subagents inherit a tool allowlist from their YAML — usually scoped tighter (e.g., reviewers get `Read, Glob, Grep, Bash` but not `Edit/Write`).

### 8. General-purpose, no opinions
Teams works for any task. PipeCrew is **shaped** — it expects a feature description, repos in `config.json`, a discover/deliver/review/assess/learn pipeline. If your task isn't "ship this feature across these repos," PipeCrew doesn't help.

---

## What PipeCrew has that Agent Teams doesn't

### 1. Multi-repo coordination
PipeCrew's `config.json` maps an entire workspace: backend services, frontend repos, mock servers, infra repos, contract repos, all with their tech stacks. The pipeline routes work across them. Teams operates within one Claude Code session's working directory — no native concept of "this feature touches 5 repos."

### 2. Worktree-per-feature isolation
Each affected repo gets a git worktree at `feature/{slug}` before any agent runs. Implementations land in worktrees, never the main checkout. Teams has **no worktree integration** — though the docs note Git worktrees as a separate manual workflow for parallel sessions.

### 3. Phased pipeline structure
9 phases:
```
pre-flight → 1. requirements → 2. architecture → 3a. contract edit
→ 3b. spec edit → 4. plan → 5. build (parallel) → 5.5. review
→ 5.75. security review → 6. assess → 7. report → 8. PR publish
```
Each phase has a defined producer/consumer contract, gated approvals, structured outputs. Teams is **free-form** by design — the lead decides shape based on the user's prompt.

### 4. Specialized typed agents (16 of them)
12 framework-specific implementers (`spring-boot`, `nestjs`, `fastapi`, `flask`, `django`, `react`, `nextjs`, `python-worker`, `mock`, `cdk`, `terraform`, `schema`) + 4 reviewers + `solution-architect` + `security-consultant` + `ux-consultant` + `product-owner` (workspace-published) + `feedback-learner` + `context-manager`. Each carries hard-won, framework-specific knowledge.

Teams uses **generic subagent definitions** by default. You can reference subagent types as teammate roles, but Teams doesn't ship a standard library of them — you bring your own.

### 5. Spec-first / contract-driven flow
OpenAPI / JSON Schema / Avro / Protobuf contracts are first-class. The architect emits contract changes, the `schema-implementer` and `openapi-spec-editor` apply them, downstream implementers consume the typed contract. Teams has no equivalent.

### 6. Cross-repo assessment
Phase 6 dispatches the `assess` skill to verify wire-shape agreement, requirement enforcement symmetry, and event/infra wiring **across** the touched repos. Catches things like "frontend expects field X but backend ships field Y." Teams' parallelism doesn't help with cross-repo integrity by itself.

### 7. Structured-block extraction (JSON-in-markdown)
Phase outputs are markdown for humans, but carry `<!-- BEGIN BLOCK -->` JSON blocks the orchestrator extracts via `scripts/extract-block.js`. `AFFECTED_SERVICES`, `REQUIREMENTS_INDEX`, `COVERAGE`, `FINDINGS_SUMMARY`, `API_DESIGN`, `DATA_MODEL`, `INFRASTRUCTURE_IMPACT`. Lets downstream phases iterate without re-LLM-parsing prose.

Teams has a shared task list and a mailbox — both transient runtime constructs, not durable cross-phase artifacts.

### 8. Eval harness (`eval/`)
Layered self-correctness suite (templates parse, script refs resolve, schema shape checks, co-located unit tests aggregator, scaffolded LLM-judge layer). Teams has no plugin to validate.

### 9. Site-view (live browser UI)
`/site-view` opens at `http://127.0.0.1:5173` showing characters per phase, pyramid tiers rising as agents complete, fed by SSE from the scratchpad and checkpoints. Auto-started at pre-flight. Teams has tmux/iTerm2 panes — terminal-bound observation only.

### 10. `/discover` — workspace onboarding
Scans existing repos, generates `platform.md`, `stacks/{type}.md` per tech stack, per-repo `agent-context/` and `CLAUDE.md`, per-repo `DESIGN_SYSTEM.md` for frontends, workspace-specific agents (`{slug}-product-owner`, `{slug}-ux-consultant`). Teams has no onboarding flow.

### 11. `/learn` — feedback loop into durable context
Takes a merged PR / `/deliver` run / branch diff / free-form text, proposes scoped updates to workspace docs and per-repo context, presents tier-classified findings (repo / workspace / plugin) with before/after diffs for user approval. Teams has no learning loop.

### 12. `/context-refresh` — staleness audit
Audits or refreshes context docs at three scopes (single repo / workspace / everything). Teams has no equivalent.

### 13. `/troubleshoot` with read-only enforcement
Cross-repo incident triage with a `PreToolUse` hook backed by `scripts/troubleshooter-bash-guard.js` that blocks any state-mutating command. Teams' permission system is per-session inherited from the lead — coarser.

### 14. `/assess` standalone
Cross-repo integration check independent of `/deliver`. Useful for verifying manually-implemented features. Teams has no equivalent.

### 15. PR publishing as a pipeline phase
Phase 8 creates PRs across all touched repos and stores `pr_urls.json`. Teams stops at "task done."

### 16. Reviewer gate decisions with classification
Phase 5.5 reviewers emit `FINDINGS_SUMMARY` JSON pre-counted; orchestrator's gate decision branches on `critical_total / critical_mechanical / critical_architectural`. With `--auto-fix-mechanical` flag, mechanical criticals self-fix without user gate. Teams has no equivalent gate logic.

### 17. Plugin-shipped hooks (PipeCrew vs. user-configured hooks)
PipeCrew ships its own `PreToolUse` hook with marker-file self-gating so it scopes to active `/troubleshoot` runs only. Teams' hooks are user-configured at the settings level.

---

## Side-by-side feature matrix

| Capability | Agent Teams | PipeCrew |
|---|:-:|:-:|
| Parallel work | ✓ (peer mesh) | ✓ (phase-internal fanout) |
| Per-worker context window | ✓ | ✓ |
| Inter-worker messaging | ✓ peer-to-peer | ✗ (only via orchestrator/files) |
| Self-claim from shared task pool | ✓ | ✗ (orchestrator dispatches) |
| Plan-approval workflow | ✓ per teammate | ✓ at architecture + spec gates |
| Live human steering of one worker | ✓ Shift+Down / panes | ✗ (gates only) |
| Multi-repo with workspace config | ✗ | ✓ |
| Git worktree per feature | ✗ (manual) | ✓ |
| Specialized typed agents | ✗ (BYO) | ✓ (16 shipped) |
| Spec-first contract editing | ✗ | ✓ (OpenAPI / Avro / JSON Schema / Protobuf) |
| Cross-repo assessment | ✗ | ✓ |
| Structured-block extraction | ✗ | ✓ |
| Eval harness for self-correctness | ✗ | ✓ |
| Live browser UI (passive) | ✗ | ✓ (site-view) |
| Terminal split panes (interactive) | ✓ (tmux/iTerm2) | ✗ |
| Discovery / onboarding flow | ✗ | ✓ (/discover) |
| Feedback learning loop | ✗ | ✓ (/learn) |
| Context refresh / staleness audit | ✗ | ✓ (/context-refresh) |
| Read-only troubleshooting agent | ✗ | ✓ (/troubleshoot + bash-guard) |
| PR publishing | ✗ | ✓ (Phase 8) |
| Hooks at agent-task events | ✓ (TeammateIdle / TaskCreated / TaskCompleted) | ✗ (uses scratchpad + gate.js instead) |
| One-team-per-session limit | ✓ | N/A (no team concept) |
| Production-stable | ✗ (experimental) | ✓ |
| Token cost relative to single session | High (N × full session) | Medium (N × subagent context) |

---

## When to use which

**Use Agent Teams when:**
- The work is **research or review** with multiple independent angles (the doc's strongest use cases)
- Workers genuinely need to **talk to each other** — debates, hypothesis disproof, cross-cutting handoffs
- You want **live steering** of individual workers as the work progresses
- The task is **one-off / exploratory** and doesn't need the structure of a pipeline
- You're OK with experimental status + higher token cost

**Use PipeCrew when:**
- You're **shipping a feature across multiple repos** (its sweet spot)
- You need **typed-agent specialization** (Spring Boot, React, Terraform, etc.)
- You want **spec-first contracts** with automatic OpenAPI / schema editing
- Cross-repo wire-shape consistency matters (assess phase)
- You want a **production-stable, plugin-installable, repeatable** workflow
- You're OK with the workflow being **shaped** rather than free-form

**Use Subagents (plain `Agent` tool) when:**
- The task is **focused** with one clear deliverable
- Workers don't need to talk to each other
- You don't want either the overhead of Teams or the opinionation of PipeCrew

---

## Could they compose?

Interesting tangent: could PipeCrew dispatch each phase or each parallel implementer to a **Teams teammate** instead of a subagent?

Architecturally yes; in practice **probably not worth it**.

- PipeCrew's parallelism is **phase-internal fanout** (e.g., 3 backend implementers + 1 frontend + 1 mock + 1 infra dispatched in one assistant message). Each runs in its own subagent context. Promoting them to teammates would 5–10× the token cost (full session per worker) for marginal gain — they don't need to talk to each other; they need to ship to different repos cleanly.
- PipeCrew's pipeline is **sequential between phases**. Teams' value-add is parallel + peer-messaging. The pipeline's structure doesn't benefit from either at the *between-phases* level.
- PipeCrew's specialization (typed agents, common-rules, structured blocks) is **subagent-shaped** — it relies on the orchestrator collecting reports and threading outputs. Teams' "self-claim from a pool" model would have to be reimplemented to preserve that.

**One real opportunity** for composition: a Phase 5.5 reviewer **fix-round** could in principle become a small Team — implementer + reviewer pair with peer messaging — to cut the round-trip latency. Today the orchestrator middlemans every fix exchange. But this is a niche optimization; the current pipeline works.

---

## TL;DR

- **Teams** = "spawn a few Claude Code sessions to **explore something together** with peer messaging." General-purpose, experimental, opinion-free.
- **PipeCrew** = "ship this feature **across these repos** with typed agents, spec-first contracts, gates, eval, and PR publishing." Specialized, production-stable, opinionated.

Different jobs. Both legitimate. The overlap is "multiple agents working on something" — but the moment you ask "what kind of *something*," they pull in opposite directions: parallel exploration vs. structured delivery.

If your team is shipping features across multi-repo workspaces, PipeCrew. If your team is investigating bugs, reviewing PRs, or doing parallel research where workers need to argue with each other, Teams. If you genuinely need both, run them in different sessions — they don't conflict.

---

## Cross-references

- [`context-engineering.md`](./context-engineering.md) — the broader signal-vs-noise framing PipeCrew operates within
- [`attention-and-caching.md`](./attention-and-caching.md) — attention-first design discipline applied across PipeCrew's dispatches
- Agent Teams official docs: <https://code.claude.com/docs/en/agent-teams>
- Subagents (the building block both use, in different ways): <https://code.claude.com/docs/en/sub-agents>
