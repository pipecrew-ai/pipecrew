# PipeCrew Context Map

**What `/discover` creates, and which agents read what.**

This doc is the canonical reference for the workspace's information architecture. Use it when:
- Adding a new agent (decide what tier of context it needs)
- Adding a new artifact (decide which tier it belongs in)
- Debugging "why didn't agent X know Y?" — start by checking whether X reads the artifact that holds Y
- Reasoning about token economy (which artifacts get loaded per dispatch)

---

## What `/discover` creates

Eleven distinct artifacts, three tiers.

### Tier 1 — Workspace context (one copy per workspace, under `{workspace_root}/{slug}/`)

| Artifact | Path | Contents | Created by |
|---|---|---|---|
| **config.json** | `config.json` | repo paths + types + roles + services + spec files + spec_copies + domain (entities, user_roles, languages, RTL, auth_type) | Phase C step 1 |
| **platform.md** | `context/platform.md` | Domain · Architecture Diagram pointer · Entities & Ownership · User Roles & Permissions · Status Lifecycles · Service Map · Tech Stack · Integration Patterns · Infrastructure Topology · **Established Patterns** · OBSERVABILITY block · Known Constraints · Open Questions · Architect Guidance | Phase B2 (architect synthesizes from B2.0 profiles) + Phase B2.6 inserts OBSERVABILITY |
| **audit-findings.md** | `context/audit-findings.md` | Real bugs / code smells aggregated from every repo profile, grouped by severity (CRITICAL / HIGH / MEDIUM / LOW) and by repo | Phase B2 (architect aggregates from each profile's `audit_findings[]`) |
| **architecture-overview.mmd** | `context/diagrams/architecture-overview.mmd` | High-level C4-style block diagram, ~10 nodes in 4 subgraphs (Frontends / Backend services / Queues / Data sources) | Phase B2 |
| **architecture.mmd** | `context/diagrams/architecture.mmd` | Detailed topology — every service, DB, queue, Lambda, with edge labels | Phase B2 |
| **learn-log.md** | `history/learn-log.md` | Initialized empty; populated by `/learn` over time as a durable history of what the workspace has learned from feedback. Lives under `history/` (NOT `context/`) so it isn't auto-loaded into agent context windows. | Phase C (creates the empty file) |
| **{slug}-product-owner.md** | `agents/{slug}-product-owner.md` | Workspace-tailored requirements agent (knows domain entities, user roles, business rules) | Phase C step 3 from `templates/agents/product-owner.md.template` |
| **{slug}-ux-consultant.md** | `agents/{slug}-ux-consultant.md` | Workspace-tailored UX agent (knows i18n languages, RTL policy, design system path) | Phase C step 3 |
| **{slug}-assessor.md** | `agents/{slug}-assessor.md` | Workspace-tailored cross-repo verifier (knows entity map, integration patterns) | Phase C step 3 |
| **{slug}-troubleshooter.md** | `agents/{slug}-troubleshooter.md` | Workspace-tailored read-only triage agent (knows OBSERVABILITY routing) | Phase C step 3 |

### Tier 2 — Per-repo context (one copy per repo, under `{repo}/`)

| Artifact | Path | Contents | Created by |
|---|---|---|---|
| **CLAUDE.md** | `{repo}/CLAUDE.md` | Project summary · Stack/Role · Build & run commands · Must-know guidelines · Quick facts · Deep context (index pointing at agent-context/) | Phase C step 4 (parallel per repo) |
| **agent-context/** | `{repo}/agent-context/` | architecture.md · AGENT_INDEX.md (feature catalog) · api-conventions.md · common/{TESTING.md, AWS_INTEGRATION.md, …} · features/{feature}.md | Phase C step 5 (opt-in per repo, parallel) |
| **DESIGN_SYSTEM.md** | `{repo}/agent-context/common/DESIGN_SYSTEM.md` (frontend repos only) | Component library · Token system · Established UI patterns · Known Inconsistencies · DON'T examples | Phase B3 (when frontend signals found) |

### Tier 1.5 — Per-run intermediate artifacts (under `{run_dir}/outputs/`, ephemeral per run)

Not durable workspace context but worth noting because they're cross-agent communication channels created during a single run:

| Artifact | Path | Contents | Created by · Consumed by |
|---|---|---|---|
| **repo-profiles/{repo_key}.json** | `{run_dir}/outputs/repo-profiles/{repo_key}.json` | Per-repo REPO_PROFILE: framework + version, entities, endpoints, integrations, auth pattern, persistence, tests, key conventions, audit findings, frontend_signals (frontends), infra_signals (cdk/terraform). ~3 KB per file. | `/discover` Phase B2.0 — `repo-discoverer` agent writes one per repo (parallel Sonnet) · `solution-architect` reads ALL of them in B2 (synthesis input) |
| **outputs/blocks/*.json** (`/deliver` runs) | `{run_dir}/outputs/blocks/*.json` | Per-block side files materialized by `scripts/split-design.js` from the architect's `phase-2-architecture.md`: `affected-services`, `affected-contracts`, `api-design`, `contract-design`, `data-model`, `infrastructure-impact`, `task-skeleton`, `findings-summary` | `/deliver` Phase 2 (architect via SA's emission + split script) · Consumed by `task-planner` in 4.5, `schema-implementer` + `openapi-spec-editor` in 3a/3b |

These artifacts live in run dirs (not the workspace `context/` tier) because they're regenerated every run — the source of truth is the architect's design output for that run, and they're materialized for cheap downstream consumption.

### Tier 3 — Published artifacts

| Artifact | Path | Source | Created by |
|---|---|---|---|
| **`~/.claude/agents/{slug}-{role}.md`** | user-level agents directory | Copy of `{workspace_root}/{slug}/agents/{role}.md` | Phase C step 3 publishes copies so Claude Code's `subagent_type` resolves the workspace-tailored agents |

---

## Access matrix — who reads what

Rows = artifact. Columns = agent. ✓ = primary read. • = optional / conditional. — = not read.

| Artifact | repo-discoverer | architect | task-planner | implementers | reviewers | UX consultant | assessor | feedback-learner | context-manager | troubleshooter | reporter | product-owner |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **config.json** | • (passes repo_key + path in dispatch) | ✓ | ✓ | • | • | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| **platform.md** | — | ✓ | ✓ (§ Established Patterns) | — | — | ✓ | ✓ | ✓ | ✓ | ✓ (OBSERVABILITY block) | — | • |
| **audit-findings.md** | (writes its own slice into its profile) | ✓ (aggregates from every profile, writes the file) | ✓ (filters → injects into task file Known Pitfalls) | (via task file) | (via task file) | — | • | • | • | — | — | — |
| **outputs/repo-profiles/{key}.json** (per-run, B2.0) | ✓ (it IS this agent — writes one per dispatch) | ✓ (reads ALL profiles in B2 — primary input for synthesis) | — | — | — | — | — | — | — | — | — | — |
| **architecture.mmd / architecture-overview.mmd** | — | • (cross-check) | — | — | — | — | — | — | — | — | — | — |
| **learn-log.md** | — | — | — | — | — | — | — | ✓ | — | — | — | — |
| **{slug}-product-owner.md** | — | — | — | — | — | — | — | — | — | — | — | (it IS this agent) |
| **{slug}-ux-consultant.md** | — | — | — | — | — | (it IS this agent) | — | — | — | — | — | — |
| **{slug}-assessor.md** | — | — | — | — | — | — | (it IS this agent) | — | — | — | — | — |
| **{slug}-troubleshooter.md** | — | — | — | — | — | — | — | — | — | (it IS this agent) | — | — |
| **{repo}/CLAUDE.md** | ✓ (the discoverer reads CLAUDE.md first if present, before sampling code) | ✓ (selective cross-check) | ✓ | ✓ (R1) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | • |
| **{repo}/agent-context/** | ✓ (architecture.md if present) | ✓ (selective) | ✓ (selective) | ✓ (selective; CLAUDE.md indexes) | ✓ (selective) | ✓ (selective) | ✓ | ✓ | ✓ | • | — | — |
| **{repo}/agent-context/common/DESIGN_SYSTEM.md** | — | ✓ (B3 reads what was discovered) | ✓ (when sub-task is frontend) | ✓ (frontend implementers only) | ✓ (frontend reviewers only) | ✓ | • | ✓ (frontend findings target this) | ✓ (refreshes this) | — | — | — |

---

## What each agent loads — by-agent view

If you flip the matrix and ask "what does THIS agent read?":

### Heavy readers (orchestration tier)

These agents synthesize across the workspace. They load multiple artifacts and reason cross-cutting.

**solution-architect** (Phase 2 design + Phase B2 discovery)
- config.json (repos in scope)
- **In B2 discovery mode**: reads every per-repo profile from `{run_dir}/outputs/repo-profiles/*.json` (the primary input — replaces direct repo walks). Optionally cross-checks against each repo's CLAUDE.md. Reads raw source ONLY when a profile flagged ambiguity. Writes platform.md + audit-findings.md (aggregated from profiles) + the two diagrams.
- **In design mode** (`/deliver` Phase 2): own prior platform.md output, each affected repo's CLAUDE.md + `agent-context/architecture.md`, spec files, `agent-context/features/*` for prior-feature lookups when relevant.

**task-planner** (Phase 4.5)
- `outputs/blocks/task-skeleton.json` (architect's coarse skeleton)
- `outputs/blocks/affected-services.json`, `api-design.json`, `data-model.json`, `infrastructure-impact.json`
- `outputs/phase-1-requirements.md` (FR/EC narrative)
- config.json (resolve repo paths/types)
- platform.md § Established Patterns (workspace-wide policies)
- Each affected repo's CLAUDE.md (just the slice the task targets)
- audit-findings.md (filters per repo)
- `{plugin_dir}/docs/pitfalls/{type}.md` (per affected stack — pre-injects into task files)

**ux-consultant** (`{slug}-ux-consultant`, Phase 5b)
- platform.md (domain, user roles, i18n languages)
- Frontend repo's CLAUDE.md + agent-context
- Frontend repo's DESIGN_SYSTEM.md
- The feature's FR/EC list + endpoints to integrate

**assessor** (`{slug}-assessor`, Phase 6 + `/assess`)
- platform.md (entity map, integration patterns, Established Patterns)
- config.json (repo list)
- The Phase 3 spec diffs + Phase 5.5 review report
- Each touched repo's git diff
- Each affected service's spec file (verifies wire shapes)

**feedback-learner** (`/learn`)
- platform.md (especially Established Patterns — the proposed-update target)
- Each implicated repo's CLAUDE.md + agent-context
- Frontend repos' DESIGN_SYSTEM.md (when relevant)
- learn-log.md (cross-reference past findings)
- The feedback signal (PR comments / run outputs / branch diff / free text)

**context-manager** (Phase 7 refresh + `/context-refresh`)
- platform.md (audits Entities & Ownership, Service Map, Established Patterns currency, Known Constraints)
- Each repo's CLAUDE.md + agent-context (audits + refreshes)
- DESIGN_SYSTEM.md per frontend repo
- The repo's actual code (to detect drift)

### Light readers (implementation / scan tier)

These agents work primarily from one repo at a time. They don't load workspace-wide context — their input is bounded to the repo in front of them plus a single task file or dispatch payload.

**repo-discoverer** (`/discover` Phase B2.0 — one dispatch per repo, parallel Sonnet)
- The dispatch's `repo_path` (the only repo it touches; R8 boundary)
- That repo's `CLAUDE.md` + `agent-context/architecture.md` (when present)
- Dependency manifest (pom.xml / package.json / pyproject.toml / requirements.txt / cdk.json / *.tf)
- Entry-point file + a sample of controllers/services/components for convention scanning
- Spec file (api-services with api-first policy)
- **Writes** its REPO_PROFILE JSON to `{run_dir}/outputs/repo-profiles/{repo_key}.json` (~3 KB). Reads no sibling repos and no workspace docs.

**Implementers** (12 stack-specific agents — `spring-boot-api-implementer`, `react-feature-implementer`, etc.)
- Their **task file** at `{run_dir}/tasks/{task-id}.md` (R0 — primary input)
- The **repo's CLAUDE.md** + agent-context docs it points to (R1)
- 1-2 existing analog files in the repo (R10)
- Sibling repos of the same type if no analog locally (R10)
- Spec files (api-first services) or contract repos (no-api workers)

> Implementers do **not** load platform.md directly — what they need from it is pre-injected into their task file's `## Architecture context`, `## Known Pitfalls`, and `## Out of Scope` sections by the task-planner.

**Reviewers** (4 stack-specific agents — `spring-boot-code-reviewer`, `react-code-reviewer`, etc.)
- The git diff (the only material the reviewer truly inspects)
- The **repo's CLAUDE.md** + agent-context (for convention checks)
- The OpenAPI spec (api-first) or architect's inline contract (code-first)
- The IMPLEMENTATION_SPEC from the UX consultant (frontend reviewers)
- The task file's FR/EC list + Out of Scope + Known Pitfalls (cross-checks)

**troubleshooter** (`{slug}-troubleshooter`, `/troubleshoot`)
- platform.md (specifically the OBSERVABILITY block — log destinations, trace header, dashboards, runbooks)
- config.json (repo list + slug for log queries)
- User-supplied evidence (HAR, log paste) when given

**schema-implementer / openapi-spec-editor** (Phase 3a / 3b)
- Architect's CONTRACT_DESIGN / API_DESIGN block (passed in the dispatch prompt)
- Each contract / spec repo's CLAUDE.md (R1)
- The actual schema / spec files being edited

**product-owner** (`{slug}-product-owner`, Phase 1)
- platform.md (some — for domain vocabulary)
- The user's feature description
- For `--from-deferred` runs: the deferred follow-up file

### Operational tier

**reporter** (Phase 7 of `/deliver` + `/discover` Phase D summary)
- The run's `scratchpad.md`
- The run's `checkpoints.jsonl`
- `~/.claude/stats-cache.json` (daily token aggregates)
- Sibling run dirs (trend comparison)
- **Does NOT read platform.md or repo docs** — purely operational telemetry.

---

## Pattern observations

1. **Two access tiers**: heavy readers (architect, planner, UX, assessor, learner, context-manager — load most workspace context) vs. light readers (implementers, reviewers, schema-implementer, openapi-spec-editor — work primarily from their task file + the repo in front of them).

2. **The task file is the bottleneck input for implementers + reviewers.** Phase 4.5's task-planner pre-injects everything the implementer needs (FR/EC list, Architecture Context, Contract Reference, Known Pitfalls, Out of Scope) so per-dispatch input stays under ~5K tokens. This is the central design choice that lets the system scale to many repos without exploding token cost.

3. **CLAUDE.md is the most-read artifact.** Every agent that touches a repo reads it. It's the per-repo source of truth; deep dives are indexed from its `## Deep context` section into `agent-context/`.

4. **Cross-repo artifacts (config.json, platform.md, audit-findings.md) are read by the orchestration tier**, mostly invisible to the implementation tier. Implementation-tier agents see workspace-wide context only as already-filtered task-file content.

5. **Diagrams (`*.mmd`) are for humans + the site-view UI**, not agents. The architect can cross-check them during design but typically uses platform.md instead.

6. **Workspace-level agent files (`{slug}-*.md`) are read once by Claude Code at dispatch time** to resolve `subagent_type` — they aren't loaded as data by other agents.

7. **`learn-log.md` is uniquely append-only**. Only `/learn` writes it; only `feedback-learner` reads it. It's the workspace's institutional memory.

8. **The reporter is the only orchestration-tier agent that doesn't read platform.md** — it's pure telemetry. This confirms the "task file separation" principle: operational data is intentionally separate from domain context.

9. **`/learn` is the bridge between observed reality and durable docs**. It's the one mechanism that updates platform.md after `/discover` finishes the bootstrap. That's why dropping the per-stack docs (B2.5) tightened the system: there's now a single durable workspace doc to maintain, not a fan-out.

10. **Generic stack-conventional knowledge lives in the plugin** (`{plugin_dir}/docs/pitfalls/{type}.md`), not the workspace. The task-planner injects the relevant bullets per repo type into per-task files. The workspace doesn't redundantly carry stack knowledge.

---

## Conclusions — design rules synthesized from the map

| # | Conclusion | Why it holds | What to do when extending the system |
|---|---|---|---|
| 1 | **Per-dispatch token budget for implementers ≈ task file + repo CLAUDE.md.** Not platform.md. | Task-planner pre-filters workspace context into the task file. Implementers never load `platform.md` directly. | Don't put hot-path implementation details in platform.md. Don't add per-stack convention docs (proven by the B2.5 removal). New per-task hints belong in the task-planner's injection logic, not in a new workspace doc. |
| 2 | **CLAUDE.md is the per-repo identity. Keep it lean.** | Every agent that touches a repo reads it. Bloat compounds across dispatches. | Keep CLAUDE.md ≤ ~5K tokens. Push deep-dive material into `agent-context/` and link via the `## Deep context` index. New conventions belong here when they're repo-specific. |
| 3 | **Workspace-wide patterns belong in platform.md § Established Patterns.** | This is the single durable workspace tier. Read by ~6 orchestration-tier agents. | Cross-cutting decisions (auth strategy, observability, ORM choice if uniform across repos) go here. Stack-specific traps go in plugin pitfalls. Per-repo deviations go in that repo's CLAUDE.md. |
| 4 | **Generic stack knowledge belongs in the plugin, not the workspace.** | Universal traps don't change per workspace. Maintaining N copies invites drift. | New stack-conventional pitfalls go in `{plugin_dir}/docs/pitfalls/{type}.md`. The task-planner auto-injects the relevant ones. |
| 5 | **Workspace-tailored agents (`{slug}-*.md`) inherit context once at creation, not per dispatch.** | Phase C bakes domain into their system prompt at agent-publish time. | Domain-specific reasoning that's load-bearing for product-owner / UX / assessor / troubleshooter goes in their template files. Hand-edits to `{workspace_root}/{slug}/agents/{role}.md` persist; re-running `/discover` Phase C would overwrite them — back up first. |
| 6 | **`/discover` produces context. `/deliver` consumes it. `/learn` updates it. `/context-refresh` keeps it current.** | Each skill has a defined role in the lifecycle. | Don't have `/deliver` mutate workspace docs (only `/learn` and `/context-refresh` do). Don't have `/learn` write code (only `/deliver` does — fix-round dispatches notwithstanding). Respect the boundaries. |
| 7 | **R10 (Inherit, don't invent) is the implementer's prime discipline.** | Once stacks/{type}.md was dropped, R10 became the explicit version of what those docs implicitly enforced. Reviewers gate-check it via the Pattern Adherence pass. | New implementers MUST cite R10 + its enforcement (find analog → follow). New reviewers MUST include the Pattern Adherence pass. Without these, conventions drift across runs. |
| 8 | **Diagrams are visual reference, not agent input.** | `architecture.mmd` is rendered for humans; agents read platform.md's text instead. | Don't write logic that depends on agents parsing Mermaid. Use the diagrams as docs that humans + the site-view UI consume. |
| 9 | **`learn-log.md` is the system's institutional memory.** | Append-only; only feedback-learner reads it. | New `/learn` runs should always append to the log even on rejected findings. Future feedback-learner dispatches cross-reference it to spot recurring patterns. |
| 10 | **Discovery is the bottleneck for all downstream skills.** | All 11 artifacts feed into `/deliver`, `/learn`, `/review`, `/assess`, `/context-refresh`, `/troubleshoot`. | Optimizing `/discover` (when sensible — see `discover-enhancement.md`) compounds across every future feature run. But adding new artifacts in `/discover` adds maintenance burden everywhere — apply the question "does this need to be created at onboarding, or can `/learn` evolve it?" before introducing new tier-1 docs. |

---

## See also

- [`PIPECREW-DISCOVERY.md`](../PIPECREW-DISCOVERY.md) — overview of the plugin
- [`rules/implementer-common.md`](../implementer-common-rules.md) — R1–R10, the implementer contract
- [`templates/blocks/block-schemas.md`](../../templates/blocks/block-schemas.md) — schema reference for structured blocks (TASK_SKELETON, OBSERVABILITY, etc.)
- [`docs/exploration-docs/discover-enhancement.md`](./discover-enhancement.md) — performance enhancement plan for `/discover` (Win #1 was rejected; Wins #2-6 remain)
