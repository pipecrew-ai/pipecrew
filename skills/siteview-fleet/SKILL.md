---
name: siteview-fleet
description: Launch the machine-wide PipeCrew fleet dashboard — a live view of EVERY Claude Code session on this machine (not just the current /deliver run), each card showing token usage, sub-agents, and a "needs approval" badge. PipeCrew /deliver sessions render with the same pharaoh crew icons as /site-view. Backed by the standalone `pipecrew-siteview` tool (npm); this skill just finds and starts it. Use to watch several sessions/runs at once, or a plain Claude Code session with no PipeCrew run.
---

# /siteview-fleet

The **fleet view** — one dashboard for *every* Claude Code session running on your
machine, not just the current `/deliver` run. Complements the per-run
`/site-view`:

- `/site-view` → one `/deliver` run in depth (6 stages, crew, pyramid, gates).
- `/siteview-fleet` → **all** sessions at a glance (tokens, sub-agents, "needs
  you" badges), click any card for its agent-dispatch tree + activity timeline.

PipeCrew `/deliver` sessions show up here with the **same pharaoh crew icons** as
`/site-view` (bruno, crit, archie, …); plain Claude Code sessions get a distinct
desert-expedition cast.

This is powered by the standalone **`pipecrew-siteview`** tool (a separate npm
package), so it also works outside PipeCrew. The skill just locates your install
and starts it.

## Usage

```
/pipecrew:siteview-fleet [--port=<n>] [--projects-dir=<path>] [--demo]
```

**Flags** (passed straight through to `pipecrew-siteview`):
- `--port=<n>` — starting port (default 5174; auto-increments if busy).
- `--projects-dir=<path>` — Claude projects root (default `~/.claude/projects`).
- `--demo` — serve a fabricated, self-animating fleet (no real sessions, zero tokens).

## Instructions

When the user invokes `/siteview-fleet`:

1. Launch via Bash with `run_in_background: true` (the server keeps serving):
   ```bash
   node {plugin_dir}/skills/siteview-fleet/launch.js [--port={n}] [--projects-dir={p}] [--demo]
   ```
   `launch.js` resolves `pipecrew-siteview` in this order and hands off to the
   first real install: `$PIPECREW_SITEVIEW_DIR` → `~/pipecrew-siteview` clone →
   a global install on PATH. (It does **not** silently install or `npx`-fetch.)
2. Report the URL it prints (default `http://127.0.0.1:5174/`). The tool
   auto-opens the browser.
3. **If it exits non-zero ("not installed")**, offer the opt-in install: ask the
   user *"Install the fleet view now with `npm install -g pipecrew-siteview`?"*
   - On **yes**, re-run the launcher WITH `--install` (it runs the global
     install, then launches):
     ```bash
     node {plugin_dir}/skills/siteview-fleet/launch.js --install [--port={n}] [--projects-dir={p}] [--demo]
     ```
   - On **no**, relay the manual options: `npm install -g pipecrew-siteview`,
     clone to `~/pipecrew-siteview`, or set `$PIPECREW_SITEVIEW_DIR`.

   Do NOT pass `--install` on the first attempt — only after the user opts in.

## Notifications (needs-approval badges)

The fleet view can badge a session (and pop an OS notification) the moment it's
waiting on you. That's driven by a Claude Code hook the standalone installs:

```bash
pipecrew-siteview --install-hooks     # idempotent; merges alongside PipeCrew's own hooks
```

Restart Claude Code afterward so the hook loads. See the `pipecrew-siteview`
README for the full notification / sound options.

## Relationship to the plugin's own site-view

`/siteview-fleet` does **not** replace `/site-view`, `/siteview-list`, or
`/siteview-cleanup` — those manage per-run PipeCrew servers driven by
`checkpoints.jsonl` + the scratchpad. The fleet view is a higher, machine-wide
layer that reads Claude Code session transcripts directly and needs no run dir.
