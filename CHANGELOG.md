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

[1.1.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.1.0
[1.0.0]: https://github.com/pipecrew-ai/pipecrew/releases/tag/v1.0.0
