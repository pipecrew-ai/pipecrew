---
name: site-view
description: PipeCrew site-view — a live browser UI of the construction site where the agent crew works. Opens at http://127.0.0.1:5173 showing characters as queued / working / done, pyramid tiers rising as agents complete, fed by the current run's scratchpad + checkpoints + awaiting-input flag over Server-Sent Events. Auto-started at Pre-flight by the /deliver skill. Full reference at docs/site-view.md.
---

# /site-view

Live visualizer for a `/deliver` run — the crew's work site. One character per pipeline role animates from queued → working → done as the orchestrator progresses; the pyramid's tiers rise as work completes. A yellow banner surfaces whenever the orchestrator is paused for user input.

Auto-started by `/deliver` at Pre-flight. Run manually with `/site-view` or `node server.js …`.

## Usage

```
/site-view [--workspace=<slug>] [--run-id=<id>] [--port=5173]
```

**Flags**:
- `--workspace=<slug>` — workspace name. Auto-detected when only one exists under `{workspace_root}/`.
- `--run-id=<id>` — specific feature run to watch. Defaults to most-recent run under `runs/feature/`.
- `--port=<n>` — initial port. Auto-increments up to 10 on `EADDRINUSE`.

## Instructions

When the user invokes `/site-view`:

1. Resolve the plugin directory (typically `~/.claude/plugins/marketplaces/local/pipecrew/`).
2. Launch the server via Bash with `run_in_background: true`:
   ```bash
   node {plugin_dir}/skills/site-view/server.js --workspace={slug} [--run-id={id}] [--port={n}]
   ```
3. Report the URL: "PipeCrew site-view running at http://127.0.0.1:{port}". The server auto-opens the browser.

## Full reference

All details — data sources, character roster, gate contract, multi-run handling, state shape, troubleshooting — are in `{plugin_dir}/docs/site-view.md`. Consult that doc for anything beyond the basic launch flow.
