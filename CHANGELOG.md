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

[1.3.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.3.0
[1.2.1]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.2.1
[1.2.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.2.0
[1.1.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.1.0
[1.0.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.0.0
