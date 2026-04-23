---
name: siteview-list
description: List every PipeCrew site-view server currently running on localhost. Probes ports 5173-5195 via the /state endpoint and reports port, PID, workspace, run-id, character count, and whether any server is awaiting user input. Use when you've started multiple runs and need to see what's alive, or before killing a stale server.
---

# /siteview-list

Quick inventory of every PipeCrew site-view server currently running.

Useful when:
- You've started multiple runs and lost track of which port hosts which.
- Old servers from prior sessions may still be running — this shows them.
- Before killing a process, verify by port + run-id what it's serving.

## Usage

```
/pipecrew:siteview-list
```

No arguments. Scans localhost ports 5173–5195; any server responding to `/state` with a PipeCrew-shaped payload is reported.

## Instructions

When the user invokes `/siteview-list`:

1. Run the scan script via Bash:
   ```bash
   node {plugin_dir}/skills/sites/scan.js
   ```
2. Relay the output to the user verbatim — it's a pre-formatted table.
3. If no servers are running, suggest `/pipecrew:site-view` to start one.
4. If stale servers are found (run-ids that don't match the user's current active run), offer to kill them by PID.

## Output example

```
3 site-view server(s) running:

PORT  PID     WORKSPACE  RUN ID                                           CHARS  INPUT  FEATURE
----  ------  ---------  ------------------------------------------------  -----  -----  -------
5173  20828   dal        2026-04-16-114907-simulated-demo                  10     no     simulated-demo
5177  16352   dal        2026-04-16-122519-book-content-upload             16     no     book-content-upload
5178  13252   dal        2026-04-17-024620-simulated-demo                  15     no     simulated-demo
```

## Full reference

Scan range + probe details documented in `{plugin_dir}/skills/sites/scan.js` header.
