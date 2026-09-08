# Changelog

All notable changes to the PipeCrew plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How to update

```
/plugin marketplace update pipecrew     # refresh the catalog from GitHub
/plugin install pipecrew@pipecrew       # re-fetch the plugin at the new version
/reload-plugins                         # activate it in the running session
```

Or enable hands-off updates once: `/plugin` → **Marketplaces** → `pipecrew` → **Enable auto-update**.
Watch the [repo Releases](https://github.com/pipecrew-ai/pipecrew/releases) (Watch → Custom → Releases) to be notified of new versions.

## [1.10.0] - 2026-09-08

### Added
- **Workspace registry — workspaces can live anywhere, and never get orphaned.**
  Replaces the single mutable `workspace_root` with a registry
  (`~/.claude/pipecrew/config.json` → `workspaces[]` + `current`) so you can onboard
  many workspaces, each next to its own repos, and switch between them by slug from
  anywhere. Onboarding a new workspace no longer hides ones under a different root.
  New `scripts/workspace-registry.js` with `--list` / `--resolve` / `--register` /
  `--set-current` / `--adopt=<dir>` / `--forget`. `/discover` and `/join` register the
  workspace they create; `/deliver`, `/memory-sync`, `/patch`, `/learn`, `/context-refresh`
  resolve via the registry. See `docs/design/workspace-registry.md`.
- **`--adopt=<dir>`** re-registers workspaces already on disk under a directory — the
  one-shot recovery for anyone who previously split workspaces across two roots.

### Changed
- **`scripts/workspace-root.js` is now a backward-compatible shim** over the registry:
  `--get [--workspace=<slug>]` returns the parent of the given/current workspace (so
  existing `{workspace_root}/{slug}` paths keep resolving wherever the workspace lives),
  `--check`/`--set`/`--config-path` unchanged. `--set` also adopts workspaces already
  under the given root.
- **Auto-migration (idempotent):** the first run after upgrading converts a legacy
  `workspace_root` string into the registry by scanning it once; nothing is moved or
  deleted. `$PIPECREW_WORKSPACE_ROOT` still overrides everything (ephemeral, non-persisted).

## [1.9.0] - 2026-09-07

### Added
- **`/join` — teammate onboarding from shared memory.** A teammate can now join an
  existing workspace with one command — `/pipecrew:join <memory-repo-url>` — instead
  of re-running `/discover`. It clones the private memory repo (`context/`, `agents/`,
  `history/`, `config.portable.json`), then rebuilds the machine-local `config.json`:
  for each repo it either clones from the new optional `repo_url` (into a
  `{slug}-repos/` sibling) or points at a copy the teammate already has. The inverse
  of what the owner publishes via `memory-sync`.
- **Optional `repo_url` per repo in `config.json`.** Machine-independent git clone URL
  that rides into `config.portable.json` (via the existing deep-copy — no sync-generator
  change) so `/join` can clone on another machine. `/discover` captures it (sanitized)
  at onboarding; absent ⇒ `/join` falls back to point-to-local. Fully backward compatible.
- **`scripts/rehydrate-config.js`** — deterministic, side-effect-free portable→local
  config transform (handles the Windows drive-root join case; `--map`/`--repos-root`/
  `--skip`), with a co-located round-trip test that closes the previously-untested
  portable↔local loop.

### Changed
- **`config` validator** now accepts `repo_url` and **hard-errors** if it embeds
  credentials (`user:token@`), which would otherwise leak into the committed
  `config.portable.json`.
- Fixed the stale `config.portable.json` note that pointed at a non-existent
  `/discover --rehydrate`; it now points at `/pipecrew:join`.

## [1.8.0] - 2026-09-04

### Changed
- **Site-view is now a single UI.** The pre-stage-flow page and the `/v1`
  (and `/v2`/`/index-v2.html`) routes were retired. The stage-flow UI — the
  default since it shipped — is now the only page: `index-v2.html` was renamed to
  `public/index.html`, the legacy `index.html` was removed, and the server serves
  one page at `/`. No change to what `/deliver` or `/simulate-run` open (they
  always used the stage-flow UI); this removes the divergent second UI that no
  longer received fixes and was a source of drift.

## [1.7.2] - 2026-09-04

### Fixed
- **Stage rail now shows intra-stage progress.** The 6-station stage rail
  previously advanced only at whole-stage granularity — a station sat on
  "active" until *every* agent in the stage finished, so during the long Build
  stage (4-6 implementers) the bar looked frozen even as agents completed one by
  one. The active station's connector now fills proportionally to `done/total`
  agents in that stage (a `--stage-progress` CSS variable set per update), and
  the lane header shows `done/total done · N working`, so progress moves
  agent-by-agent. (The `.lit` rail styling was already present but never wired;
  this uses the existing `done`/`active` states plus the new proportional fill.)

## [1.7.1] - 2026-09-03

### Added
- **Site-view completion celebration.** When a run finishes, the character crew
  now jumps and waves alongside the confetti — a short, staggered cheer fired
  once on the transition into the completed state. Respects
  `prefers-reduced-motion`. Applies to both `/deliver` and `/simulate-run`.

### Fixed
- **Completion now keys off `run_end`.** The server surfaces the terminal
  `run_end` status and the site-view treats `run_end: completed` as complete.
  Previously, optional roles (ux / security / feedback) that were never
  dispatched sat as queued preseeds, so their stages stayed pending and the run
  never read as complete — meaning neither the confetti nor the new cheer ever
  fired (notably in every `/simulate-run` demo). Only `completed` celebrates;
  `failed` / `aborted` do not.

## [1.7.0] - 2026-09-03

### Changed
- **`architecture.md` factual sections are now agent-updatable.** In the
  agent-context templates, the re-derivable sections of `architecture.md` —
  **Technology Stack**, **Key Directories**, **External Service Dependencies**
  (backend) and **Directory Structure** (frontend) — moved from `human-owned` to
  `agent-updatable`, so `/context-refresh` and `/deliver` keep them current
  automatically. The interpretive sections (System Overview, Architecture Style,
  Key Boundaries, Feature Decomposition Rules, Routing, What NOT to Do, …) stay
  `human-owned` and are only ever flagged as findings, never auto-edited.

### Added
- **Opt-in migration for existing docs (`scripts/migrate-architecture-markers.js`).**
  A deterministic, marker-only, idempotent codemod that upgrades an existing
  legacy `architecture.md` (single `human-owned` block) to the new split layout.
  It inserts marker comments only — section content is left byte-identical — and
  conservatively skips any hand-restructured or malformed file. `/context-refresh`
  now auto-detects the legacy layout and **offers** the migration (never runs it
  without an explicit yes).

### Backward compatibility
- **No existing file changes on upgrade.** The template edit is forward-only;
  already-generated `architecture.md` files behave exactly as before until a user
  opts into the migration. A new HARD RULE in the `context-manager` agent
  guarantees regeneration **never silently downgrades** a `human-owned` section to
  `agent-updatable` — the existing file's ownership always wins; the sanctioned
  downgrade path is the user-invoked codemod alone.

## [1.6.2] - 2026-09-03

### Fixed
- **Site-view: agent token counts, duplicate cards, and stuck phase status.**
  Four bugs surfaced from a live `/deliver` run, all rooted in the site-view
  over-relying on exact `description`-string matching between `checkpoints.jsonl`
  and the Claude session transcript.
  - The **product-owner** (and any agent whose checkpoint `description` drifts
    from the `description` param passed to the Agent tool) showed **0 tokens**.
    Token derivation now falls back to a `subagentType → role` match after the
    exact-description match, so tokens are recovered instead of silently dropped.
  - **Duplicate implementer cards** of the same type: an `agent_start` whose
    description drifted from its `agent_end` never paired, leaving a dangling
    instance that reconciliation spawned as a ghost repo-less twin. `agent_end`
    now falls back to pairing with the oldest open dispatch of the same
    `agent_type` and adopts the end event's repo-encoded fields.
  - The **"understand" stage never turned green** / the architect stayed
    "working" while build agents ran, because the same dangling `agent_start`
    downgraded a scratchpad-`COMPLETED` card. Group status now reflects the
    most-recent dispatch by timestamp; a completed dispatch's leftover start no
    longer masquerades as in-flight, while a genuine fix-round re-dispatch still
    flips back to working.
  - Clarified the **ORCHESTRATOR / AGENTS** header counters with tooltips
    explaining their source (main-loop overhead incl. cache-creation, cache-reads
    excluded) so the pre-agent, non-zero orchestrator figure reads as intended
    rather than "caching tokens from somewhere".

## [1.6.1] - 2026-08-29

### Added
- **`/brainstorm --technical` — technical-perspective brainstorming.** `/brainstorm`
  now works at two altitudes. The default **product** perspective dispatches the
  `product-brainstormer` as before (greenfield / feature); the new **technical**
  perspective (`--technical`, or `--product` to force the default) dispatches the
  `solution-architect` in a new **`MODE: brainstorm`** — the divergent, standalone
  counterpart to design mode. It diverges into 2–3 candidate approaches with
  pros/cons + complexity + key risk, recommends one, gives a high-level sketch, and
  offers (does not auto-write) an ADR. It stops at options: no `<!-- BEGIN … -->`
  design blocks, no FR/EC, no code.
- **Product-vs-technical disambiguation.** When a request's altitude is unclear
  (e.g. "restructure the durable memory in the best optimized way" reads as both a
  product goal and a technical one), `/brainstorm` asks a single
  `[p]roduct / [t]echnical` question before dispatching (Step 2a / EC-6). Requesting
  `--technical` with no onboarded workspace is refused with a pointer to `/discover`
  rather than a silent fallback (EC-5).

### Changed
- **`product-brainstormer` holds product altitude.** The agent is refocused on
  product thinking (users, value, problem space, options) and is barred from
  implementation mechanics — file formats, schemas, data structures, line numbers,
  code references — which now route to the `solution-architect`. It is encouraged to
  research prior art via `WebSearch` / `WebFetch`, and `Grep` / `Glob` were removed
  from its tools (keeping `Read` for `platform.md`) to structurally prevent
  code-spelunking. The feature-mode "diverge, don't design" guardrail and the option
  `scope` field now exclude implementation detail explicitly.

## [1.6.0] - 2026-08-27

### Added
- **Interactive custom-agent gate in `/discover` Phase C Step 3.25.** The step that
  generates workspace-local implementers for unsupported stacks is now an explicit
  per-type gate instead of a silent auto-generator. For each repo type with no
  plugin-shipped implementer, the user chooses: (a) **Generate** — auto-derive
  conventions from the repo's `CLAUDE.md` + build config and fill the
  `generic-implementer.md.template`; (b) **Hand-write** — skip generation and note
  it in the Phase D report + scratchpad so `/deliver`'s fallback chain warns
  appropriately; (c) **Map to an existing agent** — record the `subagent_type` in a
  new `agents/type-map.json` sidecar that `/deliver`'s resolution chain reads; (d)
  **Skip** — `/deliver` falls through to the generic fallback. EC-2: an
  unresolvable mapping re-prompts rather than being silently recorded.
- **Broader coverage: `role: other` and `role: contract` repos now included.** The
  selection rule for Step 3.25 previously filtered to five roles; it now covers all
  roles, so Claude Code plugin repos, schema repos, and other non-standard repos
  receive the same gate and generation offer.
- **CLAUDE.md-derived generation.** The generation dispatch prompt now instructs the
  generating agent to treat the repo's `CLAUDE.md` as the authoritative source for
  ORIENT / IMPLEMENT / TEST / anti-pattern placeholders, and to adapt for non-code
  repos (markdown plugins, schema repos) by not assuming a buildable stack. EC-4:
  repos with no `CLAUDE.md` receive a warning that quality may be lower and a
  recommendation to hand-write CLAUDE.md then re-generate.
- **Optional paired reviewer generation (FR-4).** After implementers are generated,
  the gate offers to also generate a paired workspace-local reviewer per type using
  the new `templates/agents/generic-reviewer.md.template`. Reviewers are published
  as `{slug}-{type}-reviewer`. Fully optional — declining skips the step.
- **`--auto-agents` flag for non-interactive / CI use.** Skips the gate and
  auto-generates implementers for every unsupported type (back-compat with prior
  silent behavior). Reviewer generation always requires explicit opt-in
  (`--auto-reviewers`). Documented in the flags table in `skills/discover/SKILL.md`.
- **Incremental-mode scoping (FR-7).** In incremental runs, Step 3.25 processes only
  new repos' unsupported types, and skips types already covered by an existing
  workspace-local agent from a prior run.
- **`type-map.json` sidecar + `/deliver` fallback chain step.** A new step 2 in the
  `/deliver` implementer-resolution chain reads `agents/type-map.json` (written by
  the "Map" gate option) to dispatch mapped agents before the generic fallback.

## [1.5.0] - 2026-08-27

### Added
- **`/brainstorm` — one ideation skill, two modes.** PipeCrew now has a single
  brainstorming entry point that handles BOTH a brand-new (greenfield) project
  AND ideating features for an already-onboarded workspace. The base
  `product-brainstormer` agent gained a `MODE:` line: `greenfield` (existing
  behavior — no repos yet, produces a `PROJECT_BRIEF`) and a new `feature` mode
  that reads the workspace's `context/platform.md` (+ `audit-findings.md` and
  platform.md § Open Questions when present) and **diverges** into a ranked set
  of distinct feature options — value prop, affected roles, rough scope,
  unknowns, dependencies, and a complexity signal per option — recommends 1–2,
  and hands off to the product-owner (it never writes FR/EC, API, or UX). The
  new standalone `/brainstorm` skill resolves the workspace root + slug (via the
  shared `scripts/workspace-root.js`), auto-detects the mode (no onboarded
  workspace or `--greenfield` → greenfield; an onboarded workspace → feature),
  asks a single confirm question only when it's genuinely ambiguous, then
  dispatches the brainstormer and presents the brief. `/discover --greenfield`
  is unchanged — it now passes `MODE: greenfield` explicitly, and the agent
  defaults to greenfield when no MODE is given, so back-compat is exact. Feature
  mode emits a new downstream-consumable `FEATURE_BRIEF` block
  (`templates/blocks/feature-brief.example.json`, registered in
  `block-schemas.md`) so the product-owner can seed requirements cleanly.

## [1.4.0] - 2026-07-09

### Added
- **Shared, committed refresh baseline for `/context-refresh`.** The fast-path
  baseline — *"these docs were verified as of commit X"* — used to live in a
  machine-local file, so it was never shared (every teammate re-audited
  independently) and a fresh `/discover` left none (the first refresh re-read the
  whole codebase). It now lives in a committed **`agent-context/.refresh-state.json`**
  "bookmark" inside each repo, so it travels with the docs across clones,
  branches, and merges. `/discover` seeds it, `/context-refresh` reads it to pick
  **skip / fast / full** and advances it after a refresh, and `/deliver` advances
  it alongside the feature. Merge conflicts on the file are left to engineers to
  resolve in git (it's a regenerable bookmark); an unresolved conflict safely
  degrades to one full re-scan. New engine `scripts/refresh-state.js`. See
  `docs/design/refresh-state.md`.

### Changed
- **One `PreToolUse` hook instead of two.** The `/troubleshoot` read-only guard
  and the `/deliver --auto-approve` helper were separate `PreToolUse` hooks that
  both fired on every Bash dispatch. They're now a single
  `scripts/pretooluse-dispatch.js` that reads the payload once and routes by
  marker, so a Bash call spawns one Node process instead of two. Behavior is
  unchanged — both scripts keep their standalone CLIs and full test suites.
- **`context-manager` preserves human-owned context.** Regenerations (including
  "recreate from scratch") now extract and graft `<!-- human-owned -->` blocks
  verbatim (recovering from git HEAD if the directory was deleted) rather than
  overwriting them, and ground inventory/shape claims in the code instead of
  inferring from naming. The repo `CLAUDE.md` templates gain a mechanical
  "new thing" test for how much context to read plus a required `Context read:`
  declaration line.

## [1.3.0] - 2026-07-05

### Added
- **`/siteview-fleet` — a machine-wide fleet dashboard.** Where `/site-view`
  shows one `/deliver` run in depth, `/siteview-fleet` opens a live view of
  **every** Claude Code session on the machine at once — one card per session
  with its token usage, sub-agents, and a "needs approval" badge; click any card
  for its agent-dispatch tree and activity timeline. PipeCrew `/deliver` sessions
  render with the same pharaoh crew icons as `/site-view`. It's backed by the
  standalone, zero-dependency [`pipecrew-siteview`](https://github.com/pipecrew-ai/pipecrew-siteview)
  tool; the skill locates an existing install
  (`$PIPECREW_SITEVIEW_DIR` → `~/pipecrew-siteview` clone → global bin) and hands
  off. It never installs silently — if the tool is missing, the skill asks first
  and, on your opt-in, runs `npm install -g pipecrew-siteview` (`launch.js
  --install`).

## [1.2.1] - 2026-07-04

### Fixed
- **Per-agent token tracking in the site-view.** A run whose agent events used a
  bare `agent` / `tokens` field (instead of canonical `agent_type` /
  `total_tokens`) had its entire per-agent breakdown silently vanish; the view
  now normalizes both field names. The per-stage / drawer token aggregations also
  now accept `tokens` and `completed` statuses, so they no longer compute to zero
  for those runs.
- **Per-agent tokens under current Claude Code — now consumer-derived.** The
  orchestrator can no longer read per-agent token counts: they live in
  `toolUseResult` metadata (and the sub-agent transcript), which is **not** in
  the tool-result content the orchestrator model receives — so it can't emit
  them, and new runs recorded 0. The site-view now **derives** per-agent
  tokens/duration from the session transcript (resolved via `run_start.session_id`)
  and matches them to `agent_end` events by `description` — covering both
  synchronous (`toolUseResult`) and async (sub-agent transcript) dispatches. The
  observability contract + dispatch rules were corrected to reflect this
  (the orchestrator emits structure only; tokens are filled downstream).
- **Orchestrator overhead was always 0.** The `orch_checkpoint` mechanism (the
  orchestrator inline byte-offset-diffing its own session JSONL) was never done
  in practice — real runs emitted empty checkpoints — so the site-view
  under-reported total run cost by the orchestrator's 20-40% share. Runs now
  record `session_id` on `run_start`, and orchestrator overhead is derived
  deterministically from the session transcript by the new `scripts/orch-tokens.js`
  (verified end-to-end: 0 → ~19.6M on a real session). The old `orch_checkpoint`
  offset math is deprecated to an optional fallback.
- **Approval banners at more gates.** Phases 2 (architecture), 3 (spec/contract),
  and 5b (UX) now call `gate.js`, so the site-view "awaiting" banner lights at
  those gates — not only at phases 1 / 4.5 / 5.5.
- **Stuck-banner guards.** The awaiting-input (24h) and Claude-approval (1h) flags
  now expire if a `close`/`clear` is missed, so a crashed run or misfired hook
  can't leave a banner up forever.
- **Approval-notification scoping + hardening.** `notify-hook.js` writes the
  Claude-approval flag to the single most-recently-active run (no false banner on
  a concurrent `/deliver`), fixes a stale doc comment, and gains unit-test
  coverage.

## [1.2.0] - 2026-07-01

### Added
- **Per-stage token totals** in the site-view v2 swimlane headers — see cost
  distribution across Understand → Contract → Build → Verify → Ship → Learn at a
  glance (reconciles to the header's total).
- **`/deliver` commits per Phase-5 task.** Each repo's feature branch is now
  built as one logical commit per implementation task (plus a `fix()` commit per
  Phase-5.5 fix round), so a large single-repo change is reviewable
  commit-by-commit without splitting the feature into multiple PRs. Also fills a
  gap where the pipeline never committed at all.
- **Empty-diff review guard.** Reviewers diff committed history, so an
  uncommitted task would leave them reviewing nothing. `write-review-diff.js`
  now emits a loud `EMPTY DIFF` signal and Phase 5.5 skips that repo's reviewer
  with an actionable warning instead of failing silently.

## [1.1.0] - 2026-07-01

### Added
- **Site-view v2 — stage-flow pipeline UI (now the default).** The live pipeline
  view is reorganized around the six chapters a `/deliver` run moves through —
  **Understand → Contract → Build → Verify → Ship → Learn** — with a rail that
  lights station-by-station, swimlanes grouping each stage's crew, running
  token + wall-clock totals, and a pharaoh-themed monument pyramid that builds a
  tier per completed stage. Served at `/`; the original UI stays at `/v1` for
  rollback.
- **Canonical pipeline-stage vocabulary (`scripts/stages.js`).** A single shared
  source of truth mapping `phase` → stage, consumed by the site-view server, the
  checkpoint validator, and future reporting. Adds an optional, validated
  `stage_group` enum to the checkpoint schema (`phase` remains the source of
  truth; no change required to how the orchestrator emits checkpoints).
- **`/learn` — Claude Code session as a feedback source.** Learn from a session
  transcript (or free-form text) with no prior `/deliver` run, plus a
  first-class "no update recommended" advisory outcome.
- **Website brand logo** in the site-view header (matches pipecrew.ai).
- **Update-available notice.** A once-per-day, fail-silent SessionStart hook that
  tells you when a newer PipeCrew release is out and how to update.

### Fixed
- **Workspace memory sync** no longer publishes non-durable run-local files and
  no longer redacts ordinary file paths as if they were secrets.

## [1.0.0]

Initial release — multi-repo agent crew for Claude Code: `/discover`, `/deliver`,
`/review`, `/assess`, `/learn`, `/context-refresh`, `/memory-sync`, with a live
site-view and support for Spring Boot, React, Next.js, NestJS, FastAPI, Flask,
Django, Python workers, AWS CDK, Terraform, and Node mock stacks.

[1.6.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.6.0
[1.5.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.5.0
[1.4.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.4.0
[1.3.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.3.0
[1.2.1]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.2.1
[1.2.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.2.0
[1.1.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.1.0
[1.0.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.0.0
