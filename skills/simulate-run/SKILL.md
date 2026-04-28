---
name: simulate-run
description: Generate the demo workspace at {workspace_root}/simulate-run-demo/ with full /discover + /deliver + /learn artifacts following the latest plugin schema (Phase 8 PR publish, pr_urls.json, learn runs, stacks docs, architecture diagrams). Each invocation wipes and recreates the workspace in place — fixed run IDs are reused, so no timestamped run dirs accumulate. Spawns the site-view pointed at the demo by default; pass --no-ui for headless generation. Zero agent cost.
---

# /simulate-run

Fabricates a fully-populated demo workspace AND spawns the site-view so the project drawer can be exercised end-to-end without spending agent tokens. Useful for:

- UI regression checks after editing `site-view/server.js` or `index.html`
- Demoing the plugin to teammates without running real features
- Onboarding to the pipeline-view tooling

## Usage

```
/simulate-run [--no-ui] [--port=<n>] [--keep] [--step-ms=<n>]
```

**Flags**:
- `--no-ui` — generate the demo workspace files only; do NOT spawn the site-view. Use this for headless regression tests or scripted setup.
- `--launch-ui` — explicit form of the default. Kept for backwards compatibility — it's a no-op now since UI launch is the default.
- `--port=<n>` — initial port for the UI (default 5173; the server auto-increments if busy).
- `--keep` — skip the wipe step. Useful for incremental edits to specific files between runs.
- `--step-ms=<n>` — milliseconds between timeline steps for the active `/deliver` run (deliver_a / "Bulk Upload"). Default: `1500` when the UI is on (the default), `0` when `--no-ui` is set. Set `--step-ms=0` to force static mode (write the completed run all at once); set `--step-ms=150` for fast headless tests.

## Modes

**Live mode** (default — UI on, `--step-ms` defaults to `1500`): the historical artifacts (`/discover`, `/learn` runs, `deliver_b`) are written all at once, but the active `/deliver` run (`deliver_a` — Bulk Upload) is initialized in PENDING state. The script then steps through ~22 timeline events — phase starts/ends and parallel implementation/review tasks — appending to `checkpoints.jsonl` and rewriting `scratchpad.md` on each step. The site-view's `fs.watch` triggers an SSE broadcast on every change, so the browser animates forward in real time.

**Static mode** (default with `--no-ui`, or any `--step-ms=0`): every artifact is written all at once with backdated timestamps. If the UI is launched in this mode (e.g. `/simulate-run --step-ms=0`), it mounts on a fully-COMPLETED run.

## Behavior

Each invocation:

1. Wipes `{workspace_root}/simulate-run-demo/` (unless `--keep`).
2. Generates the workspace skeleton: `config.json`, `context/platform.md`, `context/audit-findings.md`, `context/stacks/{spring-boot,react,node-mock,cdk}.md`, `context/architecture.mmd`, `context/architecture-overview.mmd`, `context/learn-log.md`.
3. Generates 1 fixed `/discover` run with checkpoints, scratchpad, and report.
4. Generates 2 fixed `/deliver` runs (one with Phase 8 PRs + `pr_urls.json`, one without).
5. Generates 2 fixed `/learn` runs (PR-based + run-based source modes).
6. **If a real workspace exists** with a recent `/deliver` run, copies that run's `scratchpad.md` / `report.md` / `pr_urls.json` / `checkpoints.jsonl` into the demo as a third run (with run_id renamed) — so the demo reflects realistic feature output when available, fully synthesized when not.
7. Fixed run IDs (e.g. `2026-04-25-110000-bulk-upload`) are reused on every invocation, so the demo workspace never accumulates timestamped junk.

## Instructions

When the user invokes `/simulate-run`:

1. Pass through every CLI flag the user provided to the Node script.
2. Launch via Bash:
   - **Default (UI on)**: `run_in_background: true` so the spawned site-view keeps serving. The script writes the historical runs immediately, then steps the live `deliver_a` run for ~33 seconds (22 events × 1500ms) so the browser animates.
   - With `--no-ui`: foreground — the script generates files and exits.
3. Report the demo workspace path, the URL the site-view is serving on, and which artifacts were produced.

```bash
node {plugin_dir}/scripts/simulate-run.js [--no-ui] [--port=<n>] [--keep] [--step-ms=<n>]
```

## What gets exercised in site-view

After running (default — UI on), opening the project drawer should show every section populated:

- Workspace info + repos (4 demo repos)
- Audit summary with critical/high/medium/low pills
- Last discover run + per-phase token breakdown
- Delivered features (2 or 3) with PR links on the published one
- Learnings captured (2) with finding counts
- Architecture diagrams (Mermaid)
- Platform context (rendered markdown)

The site-view's lazy loaders are also exercised: the deliver-run detail and learn-run detail endpoints are hit when the user expands a row.

## Cleanup

The demo workspace persists between runs. To remove it:

```bash
rm -rf {workspace_root}/simulate-run-demo/
```

Or rerun `/simulate-run` and just don't use it.
