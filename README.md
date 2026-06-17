# pipecrew

Multi-repo feature pipeline plugin for [Claude Code](https://claude.ai/claude-code). Orchestrates the full lifecycle of a feature across backend services, frontend, mock servers, and infrastructure — from requirements to merged code.

## Install

```bash
claude plugin install https://github.com/pipecrew-ai/pipecrew
```

## Quick start

### 1. Onboard your project

```bash
/discover /path/to/your/repos
```

Scans repos, detects tech stacks, asks 4 domain questions, generates everything under `{workspace_root}/{slug}/`:

```
{workspace_root}/{slug}/
├── config.json              ← workspace config
├── context/platform.md      ← domain architecture context
├── agents/                  ← domain-specific agents
├── pipeline/                ← scratchpad, tasks, outputs, history
└── agent-memory/            ← persistent agent memory
```

Plus `CLAUDE.md` in each repo and optional `agent-context/` for complex repos.

### 2. Build a feature

```bash
/deliver "publishers can choose contract type" --workspace=dal
```

7 phases run automatically:

```
Phase 1: Requirements ──── product-owner analyzes + produces FR/EC list
Phase 2: Architecture ──── architect designs endpoints, schemas, boundaries
Phase 3: Spec Edit ─────── 3a: contract schemas (Avro/JSON Schema/Protobuf); 3b: OpenAPI specs
Phase 4: Plan ──────────── implementation tasks as tracked files
Phase 5: Build ─────────── parallel: backend + frontend + mock + infra
Phase 5.5: Review ──────── per-repo code review with findings
Phase 6: Assess ────────── cross-repo integration check
Phase 7: Report ────────── execution report, context refresh, optional PRs
```

Live dashboard at `http://localhost:5173` shows the crew in real time.

### 3. Patch small changes (lightweight)

When the *what* is already known — an audit finding, a one-line config fix, a codemod, a
mechanical migration — skip the full pipeline. `/patch` applies it from reusable **recipes**
instead of re-running a product-owner + architect + paired reviewers.

```bash
# Fix specific audit findings from context/audit-findings.md
/patch --findings=F1,F2,F3,F4

# A described one-off change (no findings file needed)
/patch "externalize the hardcoded API key in auth application.properties"

# Codemod: run a recipe's match pattern across every repo and fix each hit
/patch --recipe=deliteralize-aws-account-id --sweep

# Apply a /troubleshoot report's root cause, and commit each repo
/patch --from-troubleshoot=runs/troubleshoot/2026-06-12-…/report.md --commit

# Preview only — match + plan + intended diff, then stop
/patch --findings=F3 --dry-run
```

Findings and flags are just the entry points — a patch can be fed from many sources:

| Feeder | Example on your repos |
|--------|----------------------|
| Direct request | "bump Spring Boot to 3.3 across all services", "change every prod log level to INFO", "add the `X-Request-Id` header to all controllers" |
| A recipe, run proactively (sweep) | "apply `no-new-objectmapper` everywhere" — the recipe's match pattern is the finder; no findings doc required |
| A review/PR comment | apply reviewer feedback as a standalone patch round (the fix-round, decoupled from `/deliver`) |
| A remembered convention | "bring abvi-backoffice in line with our error-handling convention" — `platform.md` / `CLAUDE.md` is the spec |
| A `/troubleshoot` report | troubleshoot finds root cause at `file:line` (read-only) → `/patch` applies the fix. Natural producer→consumer pair |
| Memory as a work queue | "apply the ops follow-ups I recorded last run", or the deferred items from a `Minimum only` gate |
| Mechanical migration | "stage-guard every `RemovalPolicy.DESTROY`", "field-injection → constructor-injection" |

It runs a short, cheap loop with a single approval gate:

```
Load recipes (context/recipes/) → match items → apply (1 implementer per repo)
  → read-only verify (grep / compile / cdk synth) → record + grow the recipe library
```

A **recipe** is both a fix template *and* a detector — so `--sweep` finds its own work with
no findings doc. Recipes live in the **workspace** (`{workspace}/context/recipes/*.yml`), encode
your team's conventions, and accumulate over time, so a class of change gets cheaper to repeat.
Example shipped after one run on the dal-platform workspace:

```yaml
# context/recipes/externalize-committed-secret.yml
name: externalize-committed-secret
summary: A credential/key/password literal is committed to source config.
match:
  globs: ["**/*.properties", "**/*.yml", "**/*.yaml"]
  pattern: "(api[-_]?key|password|secret|token)\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-]{16,}"
  tags: [security, secret, credential]
fix: >
  Replace the literal with ${ENV_VAR}, NO committed default (fail-closed). grep the
  literal repo-wide and fix EVERY copy (caller side + prod/regional twin profiles).
verify:
  - "grep -r '<literal>' src/ returns zero hits"
  - "module compiles (mvn -q -DskipTests compile)"
follow_up:
  - "Inject ENV_VAR into prod (+ -eu twin) task defs before deploy."
  - "Rotate the leaked value — it remains in git history."
decided_in: ADR-001
```

`/patch` bounces to `/deliver` the moment a change needs requirements, UX, or a cross-repo
contract — it's for applying decisions, not making them. See `skills/patch/SKILL.md` and
`skills/patch/recipe-schema.md`.

### 4. Standalone tools

```bash
/review publisher-service --branch=feature/my-feature
/assess --branch=feature/my-feature
/context-refresh publisher-service --mode=audit
```

## Supported tech stacks

| Stack | Implementer | Reviewer | spec_policy |
|-------|------------|---------|-------------|
| Spring Boot | `spring-boot-implementer` | `spring-boot-reviewer` | `api-first` |
| React | `react-implementer` | `react-reviewer` | — (frontend) |
| Next.js | `nextjs-implementer` | `nextjs-reviewer` | — (frontend) |
| NestJS | `nestjs-implementer` | `nestjs-reviewer` | `api-first` |
| FastAPI | `fastapi-implementer` | — | `api-first` |
| Flask | `flask-implementer` | — | `api-first` or `code-first` |
| Django / DRF | `django-implementer` | — | `api-first` or `code-first` |
| Python worker | `python-worker-implementer` | — | `no-api` (event-driven) |
| AWS CDK | `cdk-stack-implementer` | — (verified by `cdk synth`) | — (infra) |
| Terraform | `terraform-implementer` | — (plan is the review artifact) | — (infra) |
| Node mock | `mock-implementer` | — (reviewed via frontend tests) | — (mock) |
| Schemas | `schema-implementer` | — | — (contract repos, Phase 3a) |

## Skills

| Skill | Purpose |
|-------|---------|
| `/discover` | One-time project setup |
| `/deliver` | End-to-end feature pipeline |
| `/patch` | Lightweight memory-backed fixes (audit findings, codemods, migrations) via reusable recipes |
| `/review` | Standalone code review |
| `/assess` | Cross-repo integration check |
| `/context-refresh` | Agent-context audit/refresh |
| `/site-view` | Live browser dashboard |

## Cross-cutting agents

| Agent | Model | Role |
|-------|-------|------|
| `security-consultant` | Opus | Design + code security review |
| `context-manager` | Sonnet | CLAUDE.md and agent-context lifecycle |
| `reporter` | Haiku | Execution report with token analysis |

## Flags

| Flag | Effect |
|------|--------|
| `--workspace=<slug>` | Workspace to use (auto-detects if only one config exists) |
| `--spec-ready` | Skip spec editing |
| `--backend-ready` | Skip spec editing + backend |
| `--frontend-only` | Only frontend pipeline |
| `--backend-only` | Only backend |
| `--with-infra` | Force infra implementation |
| `--no-mock` | Skip mock server |
| `--no-review` | Skip code review |
| `--security-review` | Force security review |
| `--no-security` | Skip security review |
| `--no-context-update` | Skip context refresh at Phase 7 |
| `--with-pr` | Auto-create PRs |
| `--resume` | Resume interrupted pipeline |

## Works at any scale

The pipeline adapts to your workspace — no flags needed to skip irrelevant phases:

| Scale | What happens |
|-------|-------------|
| **1 backend API** | Only backend phases run. Phase 6 (cross-repo) skipped — reviewer is sufficient. |
| **2 services** | Both get implementers + reviewers. Phase 6 checks cross-service wire shapes. |
| **Frontend + mock only** | Spec editing + backend skipped. UX + implementer + mock run. |
| **Full platform** | All phases run in parallel where possible. |
| **Monorepo** (N services, 1 repo) | 1 worktree, tasks dispatch sequentially to avoid conflicts. |

Phase detection is config-driven: if your workspace config has no frontend repo, frontend phases never run — no `--backend-only` flag required.

## Architecture

Three-layer design:

1. **Plugin layer** (this repo) — generic, installable, domain-agnostic
2. **Workspace layer** (generated by `/discover`) — per-project config, domain agents, platform context
3. **Pipeline layer** (ephemeral, per-run) — scratchpad, task files, outputs, checkpoints

## Live dashboard

Runs automatically with the pipeline. Characters queue up, walk to the work zone, hammer while working, move to done. Building grows block by block.

Token usage monitoring during a run:
```
/loop 2m "tail checkpoints.jsonl and report one-line status"
```

## Adding a tech stack

Two options depending on who should benefit:

### Option A — Plugin-shipped (for popular stacks you want every user to get)

1. Create `agents/{stack}-implementer.md` following existing patterns
2. Optionally create `agents/{stack}-reviewer.md`
3. Add `type` to `VALID_TYPES` in `scripts/validate-config.js`
4. Add type → agent mapping row to `skills/deliver/phases/dispatch-rules.md` (the `TYPE_TO_AGENT` table)
5. Add sentinel file detection to `/discover` Phase A (`skills/discover/phases/phase-a-repo-discovery.md`)
6. Add a `anti-patterns/{stack}.md` file — Phase 4.5 injects a subset into every task file for that stack, and Phase 5.5 reviewers use it as a checklist
7. Update the "Supported tech stacks" table in this README
8. Open a PR

### Option B — Let `/discover` auto-generate per workspace (for in-house or unusual stacks)

For stacks not in the plugin's catalog (Rails, Phoenix, Laravel, Go, .NET, Kotlin, etc.), you don't need to change the plugin. Just run `/discover` against your repos:

1. `/discover` Phase A detects the sentinel files and flags the type — if unknown, you can correct the detected type in the Step 6 confirmation prompt (e.g., "repo 3 is type `rails`")
2. Phase C Step 3.25 reads the template at `templates/agents/generic-implementer.md.template`, reads the repo's `CLAUDE.md` + 2-3 existing features + build config, and writes `{workspace}/agents/{type}-implementer.md` tailored to that repo's conventions
3. The agent is published to `~/.claude/agents/{workspace-slug}-{type}-implementer.md` so `Agent` tool can resolve it
4. `/deliver` dispatch-rules fallback chain prefers workspace-local agents over plugin defaults — your workspace uses the generated agent automatically

The generated agent ships with the same structure as plugin agents (Invariants / Process / Things that will bite you / You are not done until) but the content reflects YOUR repo's actual conventions, test framework, migration tool, and spotted gotchas. Hand-edit `{workspace}/agents/{type}-implementer.md` whenever you want; re-running `/discover` prompts before overwriting.

**When to pick which**: Option A if you're contributing back and expect multiple projects to share the stack. Option B if the stack is unique to your workspace, OR as a quick bootstrap before you harden the rules enough for Option A.

## Workspace agents vs plugin agents

The pipeline dispatches two kinds of agents via the `Agent` tool's `subagent_type`:

**Plugin agents** live at `{plugin_dir}/agents/` and ship with the plugin. They are framework-agnostic and loaded into Claude Code at install time. Examples: `pipecrew:spring-boot-implementer`, `pipecrew:react-implementer`, `pipecrew:openapi-spec-editor`. Pipeline phases that dispatch these reference them by their plugin-qualified name.

**Workspace agents** are generated per-workspace by `/discover` from templates in `{plugin_dir}/templates/agents/`. Three roles are produced: `product-owner`, `assessor`, `troubleshooter`. (The UX consultant is **not** workspace-generated — it uses the rich base `pipecrew:ux-consultant`, like the `solution-architect`, since it reads the workspace's design system at dispatch time.) The filled files live at two paths:

1. **Canonical copy**: `{workspace_root}/{slug}/agents/{role}.md` — version-controlled alongside workspace config; hand-editable between onboardings.
2. **Published copy**: `~/.claude/agents/{slug}-{role}.md` — published by Phase C Step 3 of `/discover` so Claude Code's `Agent` tool resolves `subagent_type: {slug}-assessor` directly.

Pipeline phases that dispatch these use the slug-prefixed published name (`dal-assessor`, `acme-product-owner`). If the published copy is missing (old onboarding), phases fall back to the `general-purpose` agent with a preamble that reads the canonical copy. Both scopes coexist cleanly.

**To refresh workspace agents after hand-editing the canonical copy**: re-run `/discover --resume --workspace={slug}` — the publish step re-copies and conflict-checks.

**Naming convention**: `{workspace-slug}-{role}` — e.g., `dal-assessor`, `dal-product-owner`, `dal-troubleshooter`. This keeps multiple workspaces non-conflicting under one user's `~/.claude/agents/` dir.

## Approval-free operation

Onboarding Phase C Step 3.5 offers to write `{workspace_root}/{slug}/.claude/settings.local.json` with pre-allow rules for the common patterns `/deliver` uses. This is per-workspace and opt-in — no global permissions are granted without consent.

If you skipped it during onboarding and want to add it later:
- Re-run `/discover --resume --workspace={slug}` and say `yes` at Step 3.5, or
- Ask `/update-config` to add the allow rules manually

## License

MIT
