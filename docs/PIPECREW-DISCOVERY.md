# PipeCrew — what it is

A Claude Code plugin that turns one Claude session into the orchestrator of a **multi-repo agent crew**. It's spec-first, config-driven, and runs end-to-end: from "I have these repos lying around" all the way to "draft PRs are open across N repos and the crew has learned from your feedback."

Top-level pieces:
- **13 skills** (slash commands) under `skills/`
- **23 agents** under `agents/` (architect, task-planner, implementers per stack, reviewers, learner, security, etc.)
- **Scripts** under `scripts/` — non-LLM utilities the skills call (validators, block extractors, gate driver, observability)
- **Templates** under `templates/` — workspace config schema, per-stack convention docs, agent prompts
- **Plugin hook** in `.claude-plugin/hooks/hooks.json` — installs a Bash `PreToolUse` guard that activates only during `/troubleshoot`

---

# The core mental model

Every command operates against a **workspace** — a directory under a configurable workspaces root (`~/.claude/pipecrew/workspaces/{slug}/` by default, set once via `scripts/workspace-root.js`). A workspace contains:

```
{workspace_root}/{slug}/
├── config.json              repo paths + types + roles + spec files (validated by scripts/validate-config.js)
├── context/                 ← active context (read by agents every dispatch)
│   ├── platform.md          domain + architecture (the "memory" all agents read)
│   ├── audit-findings.md    real bugs spotted during onboarding
│   ├── architecture.mmd     two canonical Mermaid diagrams
│   ├── architecture-overview.mmd
│   └── adrs/                architecture decision records (INDEX.md + ADR-NNN-<slug>.md, filled by /deliver Phase 2 ADR gate)
├── history/                 ← durable workspace history (not auto-loaded; human / next-/learn audit trail)
│   └── learn-log.md         append-only record of every /learn invocation
├── agents/                  workspace-tailored agents (product-owner, ux-consultant, assessor, troubleshooter)
└── runs/{skill}/{run_id}/   per-invocation work dir — scratchpad.md + checkpoints.jsonl + outputs/ + report.md
```

`run_id` = `{YYYY-MM-DD-HHMMSS}-{slug-or-feature}`. Every skill emits the same JSONL event schema (`run_start`, `phase_start/end`, `agent_end`, `retry`, `bash_slow`, `run_end`) — that's what powers the live UI and the post-hoc reporter.

---

# The 13 skills

## Setup & maintenance
| Skill | What it does |
|---|---|
| `/discover` | One-time onboarding — scan repos, interrogate domain, write workspace files |
| `/scaffold` | Create empty repos `--from-scratch` (from a brief) or `--from-example` (clone structure). Standalone or invoked by `/discover --greenfield` |
| `/context-refresh` | Audit/refresh `platform.md`, per-repo `CLAUDE.md`/`agent-context/`/`DESIGN_SYSTEM.md` (with a git-diff fast path + periodic full-audit safety net) |
| `/draw-diagram` | Regenerate the two canonical Mermaid diagrams, or produce a focused `--topic=auth-flow` view, in flowchart or `--c4` style. `--scan` mode reads code directly without needing `/discover` to have run |

## Feature work
| Skill | What it does |
|---|---|
| `/deliver <feature>` | The headline pipeline — requirements → design → spec edits → parallel implementation → review → assessment → optional PR publish |
| `/review` | Standalone code review on one repo's branch (dispatches the right tech-stack reviewer agent) |
| `/assess` | Standalone cross-repo assessment of a branch (wire-shape agreement, requirement symmetry, event/infra wiring) |

## Learning & ops
| Skill | What it does |
|---|---|
| `/learn` | Read feedback from a merged PR / `/deliver` run / branch diff / free-form text; propose tier-classified doc updates; optionally dispatch implementers to bring the existing branch in line with the new convention |
| `/troubleshoot` | Read-only cross-repo incident triage. Three layers of read-only enforcement: agent system prompt, `troubleshooter-bash-guard.js`, and a `PreToolUse` hook that self-gates on a marker file so it only activates during a live `/troubleshoot` run |

## UI
| Skill | What it does |
|---|---|
| `/site-view` | Live browser UI on `127.0.0.1:5173` — characters animate queued → working → done as the orchestrator progresses, fed by SSE off `scratchpad.md` + `checkpoints.jsonl`. Auto-started by `/deliver`. |
| `/siteview-list` | Inventory site-view servers running on ports 5173–5195 |
| `/siteview-cleanup` | Kill stale site-view servers (`--keep-port`, `--keep-run`, `--keep-latest`, `--all`); defaults to `--dry-run` |
| `/simulate-run` | Fabricates a fully-populated demo workspace (zero agent cost) and animates it through the UI. For UI regression testing and demos. |

---

# Step-by-step: `/discover` (one-time onboarding)

Pre-phase 0:
1. Resolve workspaces root (prompt once, persist to `~/.claude/pipecrew/config.json`).
2. Ask workspace name → derive slug.
3. Pre-flight usage gate (warn if today's `stats-cache.json` shows >80% of observed daily ceiling).
4. Compute `run_id`, create `runs/discover/{run_id}/`, emit `run_start`, write scratchpad.

Pipeline:

```
[Greenfield]  brainstorm + /scaffold  (only if --greenfield or zero repos)
  ↓
Phase A     scan parent dirs, detect tech stacks, confirm with user (~8k)
  ↓
Phase B1    4 domain questions to user
  ↓
Phase B2    solution-architect reads ACTUAL code, writes platform.md (~80–120k Opus)
  ↓
Phase B2.6  observability extraction (CDK/Terraform/k8s/compose) → OBSERVABILITY block
  ↓
Phase B3    design system discovery (frontend repos only) (~20–40k Sonnet)
  ↓
Phase C     generate config.json → commit platform.md → publish workspace agents (slug-product-owner / -ux-consultant / -assessor / -troubleshooter to ~/.claude/agents/) → CLAUDE.md per repo (parallel) → optional agent-context per repo (parallel)
  ↓
Phase D     verify, validate checkpoints, write report.md
```

Each phase emits a one-line `[phase X ✔] ...` status. Scratchpad updated after every phase so `--resume` can pick up exactly where an interruption left off. Targeted refresh flags: `--refresh-observability`.

---

# Step-by-step: `/deliver <feature>` (the main pipeline)

Pre-flight: load `config.json`, validate, derive which phases auto-run from what repos exist, create run dir, auto-start `/site-view`.

```
Phase 1   Requirements        {slug}-product-owner agent  →  WHAT  ──────── user gate
Phase 2   Architecture        solution-architect          →  HOW + which services + AFFECTED_CONTRACTS + API_DESIGN + INFRASTRUCTURE_IMPACT + TASK_SKELETON  ──────── user gate
Phase 3a  Contract edit       schema-implementer (JSON Schema / Avro / Protobuf)  ┐
Phase 3b  Spec edit           openapi-spec-editor (in-place YAML edits)           ┴── single user gate over both diffs (orchestrator does git checkout to roll back if rejected)
Phase 4   Spec sync           copy edited specs to repos with `spec_copies`  ──── default OFF — opt-in via follow-up question at the Phase 3 gate
Phase 4.5 Implementation plan        task-planner agent (3 modes: draft / adjust / persist)  ──────── user gate
            ↳ draft   → produces plan summary from architect's TASK_SKELETON
            ↳ adjust  → re-issued per natural-language pushback round
            ↳ persist → writes per-task markdown files under {run_dir}/tasks/
                         + optional deferred follow-up file
Phase 5   PARALLEL DISPATCH (one Agent message, multiple tool calls):
            5a backend     spring-boot- / nestjs- / fastapi- / flask- / django- / python-worker-implementer (one per service)
            5b frontend    {slug}-ux-consultant → user gate → react- / nextjs-feature-implementer
            5c mock        mock-endpoint-implementer
            5d infra       cdk-stack-implementer / terraform-implementer (worktrees per repo by default)
Phase 5.5 Per-repo code review — {type}-reviewer per touched repo, parallel
            critical findings → user gate (auto-skipped with --auto-fix-mechanical when every critical is `mechanical`) → fix-round dispatch
Phase 5.75 Security review (security-consultant — keyword trigger or --force-security-review)
Phase 6   Cross-repo assessment by {slug}-assessor (skipped if only 1 repo changed)
Phase 7   Reporter agent → report.md → context-manager refresh → archive
Phase 8   --with-pr: user gate → push → draft PRs → cross-repo linking → append PR URLs to report.md
            Always: feedback offering (offer to dispatch /learn)
```

Cross-cutting rules:
- **Worktrees by default** for Phases 3 & 5 — each repo is touched in its own worktree, never the user's checkout. `--no-worktrees` opts out.
- **Section extraction**: architect output uses `<!-- BEGIN X --> ... <!-- END X -->` delimiters; `scripts/split-design.js` materializes each block as a separate file so later phases `cat outputs/blocks/<slug>.json` instead of re-reading the full design markdown.
- **Gate UX**: every approval gate calls `scripts/gate.js open/close` so the live UI shows a yellow "waiting for input" banner.
- **Transient retries**: all agent dispatches share a 529/503/network retry policy; emit `retry` + follow-up `agent_end` events.
- **Workspace agents** dispatch by slug-prefixed name; fall back to `general-purpose` with a preamble that reads the canonical agent file.

---

# The other skills, briefly

**`/review <repo-key> --branch=...`** — Looks up the repo's `type` in config, maps it to a reviewer agent (`spring-boot-code-reviewer` / `react-code-reviewer` / `nestjs-reviewer` / `nextjs-reviewer`), dispatches with the diff. Reports findings; doesn't fix.

**`/assess --branch=...`** — Finds repos that have the branch (≥ 2), gathers requirements (from `--requirements` / pipeline scratchpad / spec only), dispatches `{slug}-assessor` with focus on wire-shape agreement, requirement symmetry, event/infra wiring. Returns PASS / PARTIAL / FAIL with per-repo fix assignments.

**`/learn`** pipeline:
```
1. Resolve workspace
2. Collect signal (--pr via gh / --run / --branch / free text)
3. Dispatch feedback-learner (read-only)
4. Present findings tier-classified: run-local / repo-durable / workspace-durable / plugin-level   ─── per-finding user gate
5. Apply approved doc edits (Edit only, never full-file Write; never plugin-level)
6. Append to learn-log.md
6.5. Optional fix-round — group findings by repo, resolve implementer + branch (refuses main/master/dev), per-repo confirmation gate, parallel dispatch
7. One-line status + (if --run) update parent /deliver scratchpad row
```

**`/context-refresh`** — three scopes (single repo / `--workspace` / `--all`), two modes (`audit` / `refresh`). Smart fast path: maintains `runs/context-refresh/state.json` per repo; uses `git diff` to limit scope, falls back to a full audit on branch change, >100 modified files, >5 fast runs since last full, or `--full`.

**`/troubleshoot`** is the exception in this whole plugin — the only **read-only** skill, with three layers of enforcement (agent prompt, bash guard script, plugin hook gated by a marker file at `~/.claude/.pipecrew-troubleshooter-active`). The marker contains the orchestrator pid; the guard auto-cleans stale markers when the pid is dead. Outside an active `/troubleshoot` run, the hook is a no-op for every other Bash dispatch in the user's environment.

**`/draw-diagram`** — two source modes. Workspace mode dispatches `solution-architect` against pre-discovered `platform.md` (fast, narrative-grounded). Code-scan mode (`--scan` / `--repos`) dispatches `architecture-mapper` directly against repos with no `/discover` required. `--c4` switches output style; `--topic=<name>` produces a focused single-file diagram without touching the canonical pair; `--audit` reports staleness without writing.

**`/simulate-run`** — pure JS (`scripts/simulate-run.js`), no agents. Fabricates a complete demo workspace with two `/deliver` runs, two `/learn` runs, one `/discover` run, full diagrams, then steps the active deliver run through ~22 timeline events (~33s) so the UI animates. For demos and UI regression testing.

**`/site-view`** — Node server in `skills/site-view/server.js` watching the run's scratchpad + checkpoints, broadcasting state over SSE. Pyramid tiers rise as agents complete; yellow banner whenever a gate is open.

---

# What makes this thing tick

A few patterns that show up everywhere once you read the source:

1. **Config is the single source of truth** — `config.json` says which repos exist, their type, role, spec file, and (for frontend/mock) where copied specs live. Phase auto-detection in `/deliver` is derived from this, not hardcoded. Schema validated by `scripts/validate-config.js`.
2. **One run dir per invocation, one event log per run** — `runs/{skill}/{run_id}/checkpoints.jsonl` is unified across every skill, so the reporter and site-view work the same way for `/discover`, `/deliver`, `/learn`, `/context-refresh`, `/troubleshoot`.
3. **Scratchpad for resume, checkpoints for telemetry** — two different files, two different jobs.
4. **Section-extracted artifacts** — agents emit `<!-- BEGIN X -->` blocks; `scripts/extract-block.js` and `scripts/split-design.js` give later phases tiny, focused inputs instead of the full design doc.
5. **Tier-stratified docs** — workspace-level (platform.md, adrs/) governs convention; repo-level (CLAUDE.md, agent-context/, DESIGN_SYSTEM.md) governs implementation. `/learn` and `/context-refresh` keep them in sync; `/discover` bootstraps them.
6. **Architect–planner split for Phase 2 / 4.5** — SA owns architecture and emits a coarse `TASK_SKELETON` (per-repo M/D sub-task list grounded in `AFFECTED_SERVICES` + `RISKS`). The dedicated `task-planner` agent (Sonnet) hydrates the skeleton in Phase 4.5 with workspace-shaped material the architect didn't have (pitfalls, audit-findings, post-Phase-3 spec paths) and writes the task files. The orchestrator never reads the full architecture markdown — it routes between SA, the planner, and the user gate.
7. **Lazy phase loading** — `/deliver` loads only the active phase file into context; same for `/discover`. Keeps mid-run context lean.
8. **Hooks are scoped by marker, not by matcher** — the troubleshooter bash guard works around Claude Code's lack of `agentMatcher` by self-gating on a marker file, so it can be installed plugin-wide without affecting any other agent.
