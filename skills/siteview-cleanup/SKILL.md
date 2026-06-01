---
name: siteview-cleanup
description: Kill stale PipeCrew site-view servers. Discovers every running site-view via the same probe as /sites, then kills their PIDs. Supports --keep-port, --keep-run, --keep-latest, and --dry-run to preview before killing. Defaults to --dry-run for safety.
---

# /siteview-cleanup

Kill stale site-view servers. Often you end up with 3–6 servers running after restarting Claude or re-launching the UI during a session; this skill clears them.

## Usage

```
/pipecrew:siteview-cleanup [--keep-port=<N>] [--keep-run=<run-id>] [--keep-latest] [--all] [--dry-run]
```

**Default: `--dry-run`** — prints what WOULD be killed and exits without touching any process. Opt in to actually kill with one of the explicit flags.

**Flags**:
- `--keep-port=<N>` — preserve the server on port N; kill the rest.
- `--keep-run=<run-id>` — preserve all servers serving this run-id; kill the rest.
- `--keep-latest` — keep the server on the highest-numbered port; kill the rest.
- `--all` — kill every PipeCrew site-view server found.
- `--dry-run` (default if no kill flag set) — preview only.

## Instructions

When the user invokes `/siteview-cleanup`:

1. Run the cleanup script via Bash, passing through the user's flags verbatim:
   ```bash
   node {plugin_dir}/skills/siteview-cleanup/cleanup.js [user's flags]
   ```
2. Relay the output to the user verbatim — it's a pre-formatted report.
3. If the user didn't specify a kill flag, **remind them the default is dry-run** and suggest the best flag for their intent:
   - Cleaning up after a session → `--keep-latest`
   - Keeping one specific run alive → `--keep-run=<run-id>`
   - Wiping the slate → `--all`

## Safety

- The script ONLY kills processes whose port responds with a PipeCrew site-view shape. Non-site-view processes on the scan range are ignored.
- `--dry-run` is the default — there's no way to accidentally kill by invoking without flags.
- After kill, the script waits 200 ms and re-probes each killed port to confirm it's gone.

## Full reference

Flag semantics + exit codes documented in `{plugin_dir}/skills/siteview-cleanup/cleanup.js` header.
