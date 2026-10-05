# PipeCrew cheatsheet

Every skill, flag, agent, stack, and phase on one page. The [README](../README.md) gets you
started; this is the reference you come back to.

- [Skills](#skills)
- [The `/deliver` pipeline](#the-deliver-pipeline)
- [Common flags](#common-flags)
- [Supported tech stacks](#supported-tech-stacks)
- [Agents](#agents)
- [Testing](#testing)
- [Team workflows](#team-workflows)
- [Multiple workspaces](#multiple-workspaces)
- [Observability & cost](#observability--cost)
- [Watching the crew](#watching-the-crew)
- [Updating](#updating)
- [Cursor notes](#cursor-notes)
- [Architecture](#architecture)

## Skills

The full pipeline is one command — but **every capability is also a standalone skill** you can run on demand. Twenty in all:

**Ideate & onboard**

| Skill | Purpose |
|-------|---------|
| `/brainstorm` | What to build (greenfield or feature options) — or how, with `--technical` |
| `/scaffold` | Greenfield project scaffolding from a brainstorm — repos, config, context |
| `/discover` | One-time project onboarding — scans repos, detects stacks, generates context |
| `/join` | Onboard a teammate onto an existing workspace from its shared memory repo — clone/rehydrate `config.json`, no re-`/discover` |

**Ship**

| Skill | Purpose |
|-------|---------|
| `/deliver` | End-to-end feature pipeline — the full eight-phase run |
| `/patch` | Lightweight memory-backed fixes — audit findings, codemods, migrations via reusable recipes |
| `/review` | Standalone per-repo code review against the contract |
| `/assess` | Cross-repo integration check on a branch + live in-browser verification |

**Verify & learn**

| Skill | Purpose |
|-------|---------|
| `/design-tests` | Author feature-level acceptance cases into a durable regression suite |
| `/run-regression` | Execute the suite against an environment — regression, UAT sign-off, or prod smoke |
| `/troubleshoot` | Read-only cross-repo incident triage → root cause at `file:line` |
| `/learn` | Feed a merged PR / run / diff back — proposes tier-classified durable-context updates |

**Context & memory**

| Skill | Purpose |
|-------|---------|
| `/context-refresh` | Audit or refresh a repo's agent-context |
| `/draw-diagram` | Generate or refresh a workspace's architecture diagrams — canonical Mermaid files, or a focused `--topic` view |
| `/memory-sync` | Manage the workspace's shared, GitHub-backed memory — status, pull, publish |

**Watch**

| Skill | Purpose |
|-------|---------|
| `/site-view` | Live browser dashboard of the crew — queued, building, done, in real time |
| `/siteview-fleet` | Machine-wide fleet dashboard of **every** Claude Code session at once (via the standalone `pipecrew-siteview`) |
| `/siteview-list` | List every site-view server running on localhost — port, PID, workspace, run-id, and which are awaiting input |
| `/siteview-cleanup` | Kill stale site-view servers (`--keep-latest`, `--keep-port`, `--dry-run`; defaults to a safe dry-run) |
| `/simulate-run` | Generate a full demo workspace with realistic run artifacts — see everything, spend nothing |

### `/patch` — apply known changes

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

### Other standalone invocations

```bash
/review publisher-service --branch=feature/my-feature   # per-repo review against the contract
/assess --branch=feature/my-feature                     # cross-repo integration check
/troubleshoot "uploads 500 since yesterday"             # read-only incident triage → file:line
/context-refresh publisher-service --mode=audit         # audit/refresh agent-context
```

## The `/deliver` pipeline

```bash
/deliver "publishers can choose contract type"
```

Eight phases run automatically — **the contract lands before any code is written**:

| Phase | What happens |
|------|---------------|
| **1 · Requirements** | `product-owner` extracts the FR/EC list |
| **2 · Architecture** | `solution-architect` designs endpoints, schemas, boundaries |
| **3 · Contracts & specs** | contract schemas (Avro / JSON Schema / Protobuf), then OpenAPI specs — per repo, you review the diffs |
| **4 · Plan** | `task-planner` turns the design into tracked task files with a context budget |
| **5 · Build** | parallel implementers: backend + frontend (with UX pass) + mock + infra, each in its own worktree |
| **5.5 · Review** | per-repo, stack-aware code review with findings + fix rounds — plus a security review when the feature warrants it |
| **6 · Assess** | cross-repo integration check + live in-browser verification |
| **7 · Report** | execution report with real token + dollar cost, context refresh |
| **8 · Publish** | draft PRs in every repo (`--with-pr`), cross-linked, with provenance trailers |

### The crew sizes itself

Phase detection is **config-driven** — the phases for repos you don't have simply never run. No flags
needed to skip irrelevant work.

| Your workspace | What happens |
|----------------|--------------|
| **1 backend API** | Only backend phases run. Cross-repo assessment skipped — the reviewer is enough. |
| **2 services** | Both get implementers + reviewers. Phase 6 checks cross-service wire shapes. |
| **Frontend + mock only** | Spec editing + backend skipped. UX + implementer + mock run. |
| **Full platform** | All phases run, in parallel where possible. |
| **Monorepo** (N services, 1 repo) | One worktree; tasks dispatch sequentially to avoid conflicts. |

## Common flags

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
| `--with-pr` | Publish draft PRs at Phase 8 (`--publish-despite-blockers` to override the assess gate) |
| `--auto-approve` | Hands-off run — a hook auto-approves safe tool calls, never risky ones |
| `--resume` | Resume an interrupted pipeline |

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
> change required. See [Extending PipeCrew](#extending-pipecrew--adding-a-tech-stack).

## Agents

The crew is **35 specialized agents**. The orchestrator dispatches only the ones your workspace needs —
stack-specific implementers and reviewers run in parallel, while cross-cutting agents wrap around them.

### Orchestration & planning

| Agent | Role |
|-------|------|
| `product-brainstormer` | Greenfield idea → structured `PROJECT_BRIEF`; feature mode → ranked `FEATURE_BRIEF` |
| `solution-architect` | Cross-repo technical design that drives all implementation |
| `task-planner` | Hydrates the architect's task skeleton into per-task files |
| `reporter` | Run report — waterfall timeline, per-agent tokens, real dollar cost, trends |

### Discovery, context & learning

| Agent | Role |
|-------|------|
| `repo-discoverer` | Profiles one repo (framework, entities, endpoints) during `/discover` |
| `architecture-mapper` | Infers cross-repo topology from the code → Mermaid diagrams |
| `context-manager` | Creates / refreshes agent-facing context (AGENTS.md, `agent-context/`) |
| `feedback-learner` | Turns a merged PR / run / diff into durable-context updates |

### Contracts & specs

| Agent | Role |
|-------|------|
| `openapi-spec-editor` | Applies the approved API design to OpenAPI spec files |
| `schema-implementer` | Applies contract changes — JSON Schema / Avro / Protobuf |

### Quality & advisory

| Agent | Role |
|-------|------|
| `security-consultant` | Security review of the design and of implementation diffs |
| `ux-consultant` | Produces an implementation-ready UX spec for frontend features |
| `test-designer` | Authors the durable acceptance suite — from a run's FR/EC or a baseline sweep |
| `regression-runner` | Executes the suite against an environment with honest per-case verdicts |

### Stack implementers & reviewers

One implementer — and, where applicable, one reviewer — per stack. See [Supported tech stacks](#supported-tech-stacks)
for each stack's `spec_policy`.

- **Implementers** — `spring-boot` · `react` · `nextjs` · `nestjs` · `fastapi` · `flask` · `django` · `python-worker` · `cdk-stack` · `terraform` · `mock`
- **Reviewers** — `spring-boot` · `react` · `nextjs` · `nestjs` · `fastapi` · `flask` · `django` · `python-worker` · `cdk` · `terraform`

> Plus any **auto-generated implementers** `/discover` creates for in-house or unusual stacks.

### Workspace agents vs plugin agents

**Plugin agents** live at `{plugin_dir}/agents/`, ship with the plugin, and are framework-agnostic
(e.g. `pipecrew:spring-boot-implementer`, `pipecrew:react-implementer`).

**Workspace agents** are generated per-workspace by `/discover` (`product-owner`, `assessor`,
`troubleshooter`). Each is stored both as a version-controlled canonical copy at
`{workspace_root}/{slug}/agents/{role}.md` and a published copy at `~/.claude/agents/{slug}-{role}.md`
so the `Agent` tool resolves `subagent_type: {slug}-assessor` directly. Naming is `{workspace-slug}-{role}`
(e.g. `dal-assessor`), so multiple workspaces coexist cleanly.

Refresh after hand-editing the canonical copy with `/discover --resume --workspace={slug}`.

## Testing

The features the crew ships (and the ones you already had) become a **durable acceptance suite**
under `{workspace}/testcases/` — Given/When/Then cases at the feature's outermost surface, never
unit-granular:

```bash
/design-tests                          # baseline: characterize the features you already have
/design-tests --run=<run_id>           # cases for a feature a /deliver run just shipped
/run-regression --env=staging          # full regression against an environment
/run-regression --scope=feature:<slug> # UAT first-pass — the report doubles as the sign-off sheet
```

The runner gives an **honest per-case verdict** — `pass` / `fail` / `consistent` / `unverifiable` —
and never claims `pass` without runtime evidence. Against a production environment it runs
read-only `prod_safe` cases only, and it never executes a mutating step there. UI cases drive a
real browser when the chrome-devtools MCP is connected.

## Team workflows

PipeCrew's cross-repo knowledge — `platform.md`, diagrams, tuned agents, accumulated
learnings, the test suite — is a per-workspace **shared memory** that can live in a private
GitHub repo. The owner turns it on once:

```bash
/memory-sync enable        # bootstrap a private {slug}-memory repo + first sync
```

From then on every `/discover` / `/deliver` / `/learn` / `/context-refresh` run pulls the
team's latest at pre-flight and syncs changes back automatically. A teammate joins with a
single command — no re-onboarding, no code analysis:

```bash
/join git@github.com:acme/acme-saas-memory.git   # clone shared memory, wire up config.json
```

Run `/join` **from the directory the project should live in**: it clones the memory repo
there, then either clones each code repo beside it (from the `repo_url` recorded at
onboarding) or points at copies the teammate already has, and rebuilds their machine-local
`config.json` — ending with the same repos-plus-workspace layout the owner has. They
immediately run `/deliver` against the same shared platform context. Day-to-day,
`/memory-sync status | pull | sync` keeps everyone level. See
[`design/github-memory.md`](design/github-memory.md).

> Each workspace also carries a **stable domain identity** (`domain_<ULID>` in `config.json`) and
> can declare `external_dependencies` edges to the domains it consumes — the groundwork for memory
> that survives across workspaces and teams. Mint one for an existing workspace with
> `node <plugin>/scripts/mint-domain-id.js`. See
> [`design/domain-durable-memory.md`](design/domain-durable-memory.md).

## Multiple workspaces

You can onboard as many workspaces as you like — one per project/platform — and each
lives **where its repos live**: `/discover` and `/join` create the workspace folder in the
project directory they're run from, beside the code (a workspace is a self-contained
folder). PipeCrew tracks them all in a **registry** (`~/.claude/pipecrew/config.json`),
so onboarding a new one never hides the others.

Which workspace a command means is resolved **per session**, so parallel sessions on
different workspaces never interfere: an explicit `--workspace=<slug>` wins; else a
`$PIPECREW_WORKSPACE` env pin (slug or path); else the session's **working directory** —
a session inside a workspace folder or any of its repos targets that workspace
automatically; else the configured default. Manage the registry with:

```bash
node <plugin>/scripts/workspace-registry.js --list                 # every workspace (default marked *)
node <plugin>/scripts/workspace-registry.js --set-default=<slug>   # the fallback when no session context decides
node <plugin>/scripts/workspace-registry.js --adopt=<dir>          # register workspaces already on disk under <dir>
```

Upgrading from an older version auto-migrates your single `workspace_root` into the
registry on first run — nothing to do (a legacy `current` key becomes `default_workspace`,
and `--set-current` keeps working as an alias). If you previously kept workspaces under
more than one root, `--adopt=<that-root>` brings the rest back into view. See
[`design/workspace-registry.md`](design/workspace-registry.md).

## Observability & cost

A crew of 35 agents is only trustworthy if you can see what it did and what it cost:

- **Real dollars, not vibes.** Every run's report leads with the cost split — orchestrator vs
  agents, cache-read share, per-agent token breakdown, waterfall timeline. Rates come from a
  `pricing.json` rate card shipped as data (override with `--pricing=<json>`); unknown models
  are flagged, never silently priced.
- **Context gauge + reset gates.** The site-view header shows the orchestrator's live context
  window (amber past 500k tokens, red past 750k). Long runs get an explicit gate suggesting a
  clean stop and `/deliver --resume` instead of degrading quietly.
- **Provenance on every commit.** Pipeline commits carry `PipeCrew-Run-Id:` and
  `PipeCrew-Version:` trailers, so `git log` answers "which run touched this?" and `/learn`
  partitions history by run precisely.

## Watching the crew

`/site-view` shows one `/deliver` run in depth — a live dashboard at `http://localhost:5173`
with the crew queued, building, done, in real time. When you're juggling several runs
(or want to watch a plain Claude Code session that has no PipeCrew run at all),
`/siteview-fleet` opens a **machine-wide** dashboard: one card per live session
with its token usage, sub-agents, and a **"needs approval"** badge — click any
card for its agent-dispatch tree and activity timeline. PipeCrew `/deliver`
sessions render with the same pharaoh crew icons you see in `/site-view`.

It's powered by **[`pipecrew-siteview`](https://github.com/pipecrew-ai/pipecrew-siteview)**,
a standalone zero-dependency tool that also works outside PipeCrew. Install once:

```
npm install -g pipecrew-siteview     # then /siteview-fleet, or run: pipecrew-siteview
pipecrew-siteview --install-hooks     # optional: "needs approval" desktop notifications
```

`/siteview-fleet` finds your install automatically (`$PIPECREW_SITEVIEW_DIR` → a
`~/pipecrew-siteview` clone → a global install). If it isn't installed, the skill
**asks first** and, on your OK, runs `npm install -g pipecrew-siteview` for you —
it never installs silently.

## Updating

PipeCrew ships new versions as [GitHub Releases](https://github.com/pipecrew-ai/pipecrew/releases). To pull the latest:

```
/plugin marketplace update pipecrew     # refresh the catalog from GitHub
/plugin install pipecrew@pipecrew        # re-fetch the plugin at the new version
/reload-plugins                          # activate it in the running session
```

Prefer hands-off updates? Enable auto-update once — `/plugin` → **Marketplaces** → `pipecrew` →
**Enable auto-update** — and Claude Code will check at startup and prompt you to `/reload-plugins`
when a new version lands. PipeCrew also nudges you in-session (at most once a day) when a newer
release is available. See the [CHANGELOG](../CHANGELOG.md) for what's new, and
**Watch → Custom → Releases** on the repo to get notified.

## Cursor notes

PipeCrew is a dual-target plugin (Cursor v2.5+) — the same repo installs in Cursor, which
auto-discovers the shared `skills/` and `agents/`.

```bash
# Team marketplace / git install (recommended):
#   Cursor → Customize → Plugins → /add-plugin → paste the repo URL
#   github.com/pipecrew-ai/pipecrew

# Local dev against a clone:
cursor-agent --plugin-dir /path/to/pipecrew
```

**What ships to Cursor today:** all 20 skills and the full 35-agent crew, dispatched via Cursor's
Task-tool subagents. The lifecycle **hooks** (update nudge, `/troubleshoot` read-only guard,
`/deliver --auto-approve`, and the site-view "needs approval" banner) are Claude-Code-only for
now — a Cursor `hooks.json` port is tracked as a follow-up. Nothing else differs.

## Architecture

A three-layer design keeps the plugin generic, your platform knowledge durable, and each run clean:

1. **Plugin layer** (this repo) — generic, installable, domain-agnostic.
2. **Workspace layer** (generated by `/discover`) — per-project config, domain agents, `platform.md`, the test suite, and the shared memory the crew learns into.
3. **Pipeline layer** (ephemeral, per-run) — scratchpad, task files, outputs, checkpoints.

### Extending PipeCrew — adding a tech stack

**Option A — Plugin-shipped** (for popular stacks every user should get):

1. Create `agents/{stack}-implementer.md` (and optionally `agents/{stack}-reviewer.md`).
2. Add the `type` to `VALID_TYPES` in `scripts/validate-config.js`.
3. Add the type → agent row to `skills/deliver/phases/dispatch-rules.md`.
4. Add sentinel-file detection to `/discover` Phase A.
5. Add an `anti-patterns/{stack}.md` checklist file.
6. Update the *Supported tech stacks* table and open a PR.

**Option B — Let `/discover` auto-generate per workspace** (for in-house or unusual stacks):

No plugin change needed. `/discover` detects the stack, reads the repo's `AGENTS.md` + a few existing
features + build config, and writes a tailored `{workspace}/agents/{type}-implementer.md` that reflects
*your* repo's conventions, test framework, and gotchas. `/deliver` prefers workspace-local agents over
plugin defaults automatically.

**Pick A** if you're contributing back and multiple projects share the stack; **pick B** if the stack is
unique to your workspace, or as a quick bootstrap before hardening it for Option A.

### Approval-free operation

`/discover` (Phase C) offers to write `{workspace_root}/{slug}/.claude/settings.local.json` with
pre-allow rules for the common patterns `/deliver` uses. It's per-workspace and opt-in — no global
permissions are granted without consent. Add it later with `/discover --resume --workspace={slug}`
or via `/update-config`.
