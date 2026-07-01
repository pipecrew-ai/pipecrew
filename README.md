<div align="center">

<img src="assets/pipecrew-logo.svg" alt="PipeCrew logo" width="160" height="160" />

<pre>
██████   ██████  ██████   ██████   █████  ██████   ██████  ██   ██
██   ██    ██    ██   ██  ██      ██      ██   ██  ██      ██   ██
██████     ██    ██████   █████   ██      ██████   █████   ██ █ ██
██         ██    ██       ██      ██      ██  ██   ██      ███████
██       ██████  ██       ██████   █████  ██   ██  ██████   ██ ██ 
</pre>

### A crew that learns your platform

A **self-learning, multi-repo agent crew** for [Claude Code](https://claude.ai/claude-code).
Hand it one feature; it ships across every repo that feature touches — engineering its own
context and learning your platform, so **every run starts smarter than the last**.

[![Website](https://img.shields.io/badge/pipecrew.ai-website-2563eb)](https://pipecrew.ai)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](https://claude.ai/claude-code)
[![Version](https://img.shields.io/badge/version-1.1.0-blue)](https://github.com/pipecrew-ai/pipecrew/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

[**Website**](https://pipecrew.ai) · [**Install**](#install) · [**Quick start**](#quick-start) · [**Skills**](#skills) · [**Agents**](#agents) · [**Supported stacks**](#supported-tech-stacks)

</div>

---

> **Not a faster one-shot agent** — a crew that fans out across your repos, engineers its own
> context, and gets sharper every run. One feature in, PRs across every repo out.

## The problem

Nothing a one-shot agent learns survives the session. Your platform's conventions, the gotchas,
the way you *always* do it — re-explained every run, to every agent, like onboarding a new hire on
a loop. And the moment a feature spans more than one repo, the agent that "finished" the backend
has no idea the frontend and the contract drifted out from under it.

## What PipeCrew does

Describe a feature in plain language. PipeCrew figures out **which repositories it touches — and
how** — then runs a crew of stack-specialized agents that take it from requirements to **merged
PRs in every affected repo**, and feeds the result back so the next run is smarter.

```
  one feature  ─►  product-owner ─► architect ─► contracts/specs ─► [ backend │ frontend │ mock │ infra ]
                                                                          (parallel, one specialist per repo)
                       ─► per-repo review ─► cross-repo assess ─► PRs in every repo ─┐
                                                                                     │
                       └──────────────── learns from the merged PR ◄────────────────┘
```

You stay the **director**, approving at gates. The orchestrator job moves to PipeCrew.

---

## The three pillars

### 01 · Multi-repo · multi-agent

Each repo draws an **implementer that knows its stack — and a reviewer that knows it too**. Every
agent works in **its own git worktree**, all building against the **same shared contract** at once,
so a feature spanning five repos moves like one. They never talk — they only read the contract.

> Per-repo reviewers run in parallel; a workspace-level **assessor reads every diff together** and
> catches the API/consumer mismatch no single per-repo reviewer can see — *before* PRs land, not on Monday.

### 02 · Context engineered

State lives in **files, not the chat**. Each agent loads only the slice it needs into its task
window, does the work, emits a machine-readable result — and the window is gone when the task ends.

- **Isolation** — each agent in its own window, each repo in its own worktree, so one stack's noise never pollutes another's.
- **Offloading** — the platform map, conventions, and decisions live on disk and are read on demand.
- **Compression** — long context is summarized and distilled into run reports, so the next step stays lean.

### 03 · Continuous learning

> **Every run makes the next one sharper.**

Feed a merged PR (or a run, or a diff) back, and PipeCrew proposes **tier-classified updates** to its
durable layer — repo, workspace, or plugin memory — which you approve per finding. The durable layer
lives in a **shared, GitHub-backed repo**, so everyone's crew benefits from what anyone's run learned.
Run #2 beats run #1.

---

## Install

```bash
claude plugin install https://github.com/pipecrew-ai/pipecrew
```

## Updating

PipeCrew ships new versions as [GitHub Releases](https://github.com/pipecrew-ai/pipecrew/releases). To pull the latest:

```
/plugin marketplace update pipecrew     # refresh the catalog from GitHub
/plugin install pipecrew@pipecrew        # re-fetch the plugin at the new version
/reload-plugins                          # activate it in the running session
```

Prefer hands-off updates? Enable auto-update once — `/plugin` → **Marketplaces** → `pipecrew` → **Enable auto-update** — and Claude Code will check at startup and prompt you to `/reload-plugins` when a new version lands. PipeCrew also nudges you in-session (at most once a day) when a newer release is available. See the [CHANGELOG](CHANGELOG.md) for what's new, and **Watch → Custom → Releases** on the repo to get notified.

## Quick start

### 1. Onboard your project — `/discover`

```bash
/discover /path/to/your/repos
```

Scans repos, detects tech stacks, asks a few domain questions, and **writes the durable layer once**
under `{workspace_root}/{slug}/` — workspace config, a `platform.md` map of your domain and topology,
per-repo `CLAUDE.md`, and domain-specialized agents. Run it once per project.

### 2. Ship a feature — `/deliver`

```bash
/deliver "publishers can choose contract type"
```

Seven phases run automatically — **the contract lands before any code is written**:

| Phase | What happens |
|------|---------------|
| **1 · Requirements** | `product-owner` extracts the FR/EC list |
| **2 · Architecture** | `solution-architect` designs endpoints, schemas, boundaries |
| **3 · Spec edit** | contract schemas (Avro / JSON Schema / Protobuf), then OpenAPI specs — per repo, you review the diffs |
| **4 · Plan** | implementation tasks as tracked files |
| **5 · Build** | parallel implementers: backend + frontend (with UX pass) + mock + infra, each in its own worktree |
| **5.5 · Review** | per-repo, stack-aware code review with findings + fix rounds |
| **6 · Assess** | cross-repo integration check + live in-browser verification |
| **7 · Report** | execution report, context refresh, optional PRs |

> A live dashboard at `http://localhost:5173` shows the crew queue up, build, and finish in real time.

### 3. Apply known changes — `/patch`

When the *what* is already decided — an audit finding, a one-line config fix, a codemod, a mechanical
migration — skip the full pipeline. `/patch` applies it from reusable **recipes** instead of re-running
a product-owner + architect + paired reviewers.

```bash
/patch --findings=F1,F2,F3                       # fix specific audit findings
/patch "externalize the hardcoded API key in auth"   # a described one-off change
/patch --recipe=deliteralize-aws-account-id --sweep  # codemod: a recipe finds its own work
/patch --from-troubleshoot=runs/.../report.md --commit
```

A **recipe** is both a fix template *and* a detector, so `--sweep` finds its own work with no findings
doc. Recipes live in your workspace, encode your team's conventions, and accumulate over time — so a
class of change gets cheaper to repeat. `/patch` bounces to `/deliver` the moment a change needs
requirements, UX, or a new cross-repo contract: it applies decisions, it doesn't make them.

### 4. Standalone skills

```bash
/review publisher-service --branch=feature/my-feature   # per-repo review against the contract
/assess --branch=feature/my-feature                     # cross-repo integration check
/context-refresh publisher-service --mode=audit         # audit/refresh agent-context
```

---

## Skills

The full pipeline is one command — but **every capability is also a standalone skill** you can run on demand.

| Skill | Purpose |
|-------|---------|
| `/discover` | One-time project onboarding — scans repos, detects stacks, generates context |
| `/deliver` | End-to-end feature pipeline — the full seven-phase run |
| `/patch` | Lightweight memory-backed fixes — audit findings, codemods, migrations via reusable recipes |
| `/review` | Standalone per-repo code review against the contract |
| `/assess` | Cross-repo integration check on a branch + live in-browser verification |
| `/learn` | Feed a merged PR / run / diff back — proposes tier-classified durable-context updates |
| `/context-refresh` | Audit or refresh a repo's agent-context |
| `/memory-sync` | Manage the workspace's shared, GitHub-backed memory — status, pull, publish |
| `/scaffold` | Greenfield project scaffolding from a brainstorm — repos, config, context |
| `/troubleshoot` | Read-only cross-repo incident triage → root cause at `file:line` |
| `/site-view` | Live browser dashboard of the crew — queued, building, done, in real time |

## Supported tech stacks

| Stack | Implementer | Reviewer | spec_policy |
|-------|------------|----------|-------------|
| Spring Boot | `spring-boot-implementer` | `spring-boot-reviewer` | `api-first` |
| React | `react-implementer` | `react-reviewer` | — (frontend) |
| Next.js | `nextjs-implementer` | `nextjs-reviewer` | — (frontend) |
| NestJS | `nestjs-implementer` | `nestjs-reviewer` | `api-first` |
| FastAPI | `fastapi-implementer` | `fastapi-reviewer` | `api-first` |
| Flask | `flask-implementer` | `flask-reviewer` | `api-first` / `code-first` |
| Django / DRF | `django-implementer` | `django-reviewer` | `api-first` / `code-first` |
| Python worker | `python-worker-implementer` | `python-worker-reviewer` | `no-api` (event-driven) |
| AWS CDK | `cdk-stack-implementer` | `cdk-reviewer` | — (infra) |
| Terraform | `terraform-implementer` | `terraform-reviewer` | — (infra) |
| Node mock | `mock-implementer` | — (reviewed via frontend tests) | — (mock) |
| Schemas | `schema-implementer` | — | — (contract repos, Phase 3a) |

> **Don't see your stack?** `/discover` auto-generates a tailored implementer for in-house or unusual
> stacks (Rails, Phoenix, Laravel, Go, .NET, Kotlin…) by reading your repo's conventions — no plugin
> change required. See [Extending PipeCrew](#extending-pipecrew).

## Agents

The crew is **33 specialized agents**. The orchestrator dispatches only the ones your workspace needs —
stack-specific implementers and reviewers run in parallel, while cross-cutting agents wrap around them.

### Orchestration &amp; planning

| Agent | Role |
|-------|------|
| `product-brainstormer` | Greenfield idea → structured `PROJECT_BRIEF` |
| `solution-architect` | Cross-repo technical design that drives all implementation |
| `task-planner` | Hydrates the architect's task skeleton into per-task files |
| `reporter` | Run report — waterfall timeline, per-agent tokens, trends |

### Discovery, context &amp; learning

| Agent | Role |
|-------|------|
| `repo-discoverer` | Profiles one repo (framework, entities, endpoints) during `/discover` |
| `architecture-mapper` | Infers cross-repo topology from the code → Mermaid diagrams |
| `context-manager` | Creates / refreshes agent-facing context (CLAUDE.md, `agent-context/`) |
| `feedback-learner` | Turns a merged PR / run / diff into durable-context updates |

### Contracts &amp; specs

| Agent | Role |
|-------|------|
| `openapi-spec-editor` | Applies the approved API design to OpenAPI spec files |
| `schema-implementer` | Applies contract changes — JSON Schema / Avro / Protobuf |

### Review &amp; advisory

| Agent | Role |
|-------|------|
| `security-consultant` | Security review of the design and of implementation diffs |
| `ux-consultant` | Produces an implementation-ready UX spec for frontend features |

### Stack implementers &amp; reviewers

One implementer — and, where applicable, one reviewer — per stack. See [Supported tech stacks](#supported-tech-stacks)
for each stack's `spec_policy`.

- **Implementers** — `spring-boot` · `react` · `nextjs` · `nestjs` · `fastapi` · `flask` · `django` · `python-worker` · `cdk-stack` · `terraform` · `mock`
- **Reviewers** — `spring-boot` · `react` · `nextjs` · `nestjs` · `fastapi` · `flask` · `django` · `python-worker` · `cdk` · `terraform`

> Plus any **auto-generated implementers** `/discover` creates for in-house or unusual stacks — see
> [Extending PipeCrew](#extending-pipecrew).

## The crew sizes itself

Phase detection is **config-driven** — the phases for repos you don't have simply never run. No flags
needed to skip irrelevant work.

| Your workspace | What happens |
|----------------|--------------|
| **1 backend API** | Only backend phases run. Cross-repo assessment skipped — the reviewer is enough. |
| **2 services** | Both get implementers + reviewers. Phase 6 checks cross-service wire shapes. |
| **Frontend + mock only** | Spec editing + backend skipped. UX + implementer + mock run. |
| **Full platform** | All phases run, in parallel where possible. |
| **Monorepo** (N services, 1 repo) | One worktree; tasks dispatch sequentially to avoid conflicts. |

<details>
<summary><b>Common flags</b></summary>

| Flag | Effect |
|------|--------|
| `--workspace=<slug>` | Workspace to use (auto-detects if only one config exists) |
| `--spec-ready` | Skip spec editing |
| `--backend-ready` | Skip spec editing + backend |
| `--frontend-only` / `--backend-only` | Run only that side of the pipeline |
| `--with-infra` | Force infra implementation |
| `--no-mock` | Skip mock server |
| `--no-review` | Skip code review |
| `--security-review` / `--no-security` | Force / skip security review |
| `--no-context-update` | Skip context refresh at Phase 7 |
| `--with-pr` | Auto-create PRs |
| `--resume` | Resume an interrupted pipeline |

</details>

---

## Architecture

A three-layer design keeps the plugin generic, your platform knowledge durable, and each run clean:

1. **Plugin layer** (this repo) — generic, installable, domain-agnostic.
2. **Workspace layer** (generated by `/discover`) — per-project config, domain agents, `platform.md`, and the shared memory the crew learns into.
3. **Pipeline layer** (ephemeral, per-run) — scratchpad, task files, outputs, checkpoints.

<details>
<summary><b>Extending PipeCrew — adding a tech stack</b></summary>

**Option A — Plugin-shipped** (for popular stacks every user should get):

1. Create `agents/{stack}-implementer.md` (and optionally `agents/{stack}-reviewer.md`).
2. Add the `type` to `VALID_TYPES` in `scripts/validate-config.js`.
3. Add the type → agent row to `skills/deliver/phases/dispatch-rules.md`.
4. Add sentinel-file detection to `/discover` Phase A.
5. Add an `anti-patterns/{stack}.md` checklist file.
6. Update the *Supported tech stacks* table and open a PR.

**Option B — Let `/discover` auto-generate per workspace** (for in-house or unusual stacks):

No plugin change needed. `/discover` detects the stack, reads the repo's `CLAUDE.md` + a few existing
features + build config, and writes a tailored `{workspace}/agents/{type}-implementer.md` that reflects
*your* repo's conventions, test framework, and gotchas. `/deliver` prefers workspace-local agents over
plugin defaults automatically.

**Pick A** if you're contributing back and multiple projects share the stack; **pick B** if the stack is
unique to your workspace, or as a quick bootstrap before hardening it for Option A.

</details>

<details>
<summary><b>Workspace agents vs plugin agents</b></summary>

**Plugin agents** live at `{plugin_dir}/agents/`, ship with the plugin, and are framework-agnostic
(e.g. `pipecrew:spring-boot-implementer`, `pipecrew:react-implementer`).

**Workspace agents** are generated per-workspace by `/discover` (`product-owner`, `assessor`,
`troubleshooter`). Each is stored both as a version-controlled canonical copy at
`{workspace_root}/{slug}/agents/{role}.md` and a published copy at `~/.claude/agents/{slug}-{role}.md`
so the `Agent` tool resolves `subagent_type: {slug}-assessor` directly. Naming is `{workspace-slug}-{role}`
(e.g. `dal-assessor`), so multiple workspaces coexist cleanly.

Refresh after hand-editing the canonical copy with `/discover --resume --workspace={slug}`.

</details>

<details>
<summary><b>Approval-free operation</b></summary>

`/discover` (Phase C) offers to write `{workspace_root}/{slug}/.claude/settings.local.json` with
pre-allow rules for the common patterns `/deliver` uses. It's per-workspace and opt-in — no global
permissions are granted without consent. Add it later with `/discover --resume --workspace={slug}`
or via `/update-config`.

</details>

---

## License

[Apache 2.0](LICENSE) · Learn more at **[pipecrew.ai](https://pipecrew.ai)**
