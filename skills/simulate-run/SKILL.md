---
name: simulate-run
description: Dry-run harness for the pipeline-view UI. Creates a fake feature run directory, steps through a realistic timeline (Phase 1 → 7 with parallel Phase 5, retries, and approval gates), and optionally launches the UI pointed at the simulated run. Zero agent cost. Full reference at docs/site-view.md.
---

# /simulate-run

Fabricates a full `/deliver` run on disk so the pipeline-view UI can be exercised end-to-end without burning agent tokens. Useful for:

- UI regression checks after editing `server.js` or the HTML
- Demoing the tool without running a real feature
- Onboarding new teammates to the pipeline-view

## Usage

```
/simulate-run [--workspace=<slug>] [--step-ms=<n>] [--launch-ui] [--port=<n>] [--cleanup-on-exit] [--feature-name=<slug>]
```

**Common flags**:
- `--launch-ui` — spawn the pipeline-view server as a child process pointed at the simulated run (browser auto-opens)
- `--step-ms=<n>` — milliseconds between timeline steps (default 1500; use 150 for fast headless runs)
- `--cleanup-on-exit` — delete the simulated run dir when done

Full flag reference in `{plugin_dir}/docs/site-view.md` → "Testing — the simulate-run harness".

## Instructions

When the user invokes `/simulate-run`:

1. Resolve the plugin directory.
2. Pass through every CLI flag the user provided to the Node script.
3. Launch via Bash:
   - With `--launch-ui`: `run_in_background: true` so the child server keeps serving.
   - Without: foreground — the script exits itself after the timeline completes.
4. Report: "Simulated run started at `{run_dir}`. UI at http://127.0.0.1:{port}" (if `--launch-ui`).

## Full reference

`{plugin_dir}/docs/site-view.md` → "Testing — the simulate-run harness" covers the full timeline, flag defaults, safety guarantees, and concurrent-use notes.
