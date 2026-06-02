# Pipeline View — UI tool reference

Consolidated reference for the live pipeline visualizer: the server, the UI, the gate contract, and the simulator. This is the single source of truth for anything relating to the UI tool. The `pipeline-view` and `simulate-run` skill manifests are kept short and point at this doc.

## Table of contents

1. [What it is](#what-it-is)
2. [Starting it](#starting-it)
3. [Data sources](#data-sources)
4. [URL structure + HTTP surface](#url-structure--http-surface)
5. [Character roster + agent-name mapping](#character-roster--agent-name-mapping)
6. [Awaiting-input banner (user-gate contract)](#awaiting-input-banner-user-gate-contract)
7. [Multi-run handling (parallel `/deliver` invocations)](#multi-run-handling-parallel-feature-invocations)
8. [Testing — the simulate-run harness](#testing--the-simulate-run-harness)
9. [Extending / modifying](#extending--modifying)
10. [Troubleshooting](#troubleshooting)

---

## What it is

A local HTTP + SSE server at `{plugin_dir}/skills/site-view/server.js` that watches one feature run's scratchpad and streams state to a browser-based animated queue scene.

**Purpose**: live visibility into `/deliver` runs — which agents are queued, which are working, which are done, how many tokens each consumed, and (critically) when the orchestrator is paused waiting for user input.

**Zero dependencies** — pure Node stdlib (`http`, `fs`, `path`, `os`, `child_process`). Works on Windows / macOS / Linux.

**Auto-started** by `/deliver` at Pre-flight, or manually via `/site-view` or `node server.js …`.

---

## Starting it

### Via slash skill

```
/site-view --workspace=<slug> [--run-id=<id>] [--port=5173]
```

- `--workspace` auto-detects when exactly one workspace exists under `{workspace_root}/`.
- `--run-id` picks a specific run. When omitted, the server locks onto the most recently modified run under `{workspace_root}/{slug}/runs/deliver/`.
- `--port` is the initial port. Auto-increments up to 10 times on `EADDRINUSE`.

### Via Node directly

```bash
node {plugin_dir}/skills/site-view/server.js \
  --workspace=dal \
  --run-id=2026-04-15-200215-contract-view-and-list
```

### Auto-start from `/deliver`

Pre-flight Step 6 launches the server in the background with `run_in_background: true`, passing `--run-id={run_id}` so each parallel run's server locks onto its own run rather than drifting to "most recent".

---

## Data sources

The server reads **three files** per run and merges them into a single state JSON. All live under `{workspace_root}/{slug}/runs/deliver/{run_id}/`.

| File | Primary / Secondary | Role |
|------|---------------------|------|
| `scratchpad.md` | Primary | The already-reduced "current state" view — Phase Status table, Implementation Tasks table, Agent Dispatch Log table |
| `checkpoints.jsonl` | Enrichment | Orchestrator-overhead tokens + retry markers |
| `awaiting_input.json` | Presence-only flag | Drives the yellow "waiting for input" banner |

### Why scratchpad is primary (not checkpoints)

Scratchpad is the orchestrator's in-flight state summary — tables already aggregate per-phase and per-task. Checkpoints are the raw event stream (append-only) which would require event replay to compute the same view. Replay is lossier (no worktree paths, no "files changed" columns) and more complex. Scratchpad stays primary.

### What the server pulls from checkpoints.jsonl

Only two things the scratchpad doesn't carry:

1. **Orchestrator overhead tokens** — sum of `orch_since_last.{input_tokens, output_tokens, cache_read_tokens}` across every `orch_checkpoint` event. Surfaces in the header's ORCHESTRATOR counter.
2. **Retry indicators** — `retry` events that have no matching follow-up `agent_end` with `status: ok` flag the affected character as `retrying: true`.

### What the server pulls from awaiting_input.json

File presence alone → orchestrator is paused. File body (parsed as JSON) populates the banner:

```json
{
  "since":           "2026-04-16T11:30:00Z",
  "phase":           "3",
  "gate":            "approval",
  "question":        "Approve these spec changes to continue to Phase 4?",
  "context_summary": "2 specs edited: +321/-20 on contract-api"
}
```

All fields optional except `since` and `gate`. See [Awaiting-input banner](#awaiting-input-banner-user-gate-contract) for the orchestrator-side contract.

---

## URL structure + HTTP surface

```
http://127.0.0.1:{port}/
  ├── /                 serves public/index.html (with INITIAL_STATE inlined for first paint)
  ├── /state            parsed state JSON (same shape as each SSE event payload)
  ├── /state.json       alias for /state
  └── /events           Server-Sent Events stream (broadcast on every file change)
```

State shape:

```js
{
  workspace:         "dal",
  runId:             "2026-04-15-200215-contract-view-and-list",
  featureName:       "contract-view-and-list",
  scratchpadPath:    "…/scratchpad.md",
  updatedAt:         "2026-04-16T11:30:00.000Z",
  characters:        [ { id, role, phase, agent, repo, status, tokens, duration, dispatches, retrying }, … ],
  orchestratorTokens: 45230,
  totalAgentTokens:   980000,
  awaitingInput:      null | { since, phase, gate, question, context_summary }
}
```

Empty-state variants:

- `noRun: true` — run directory doesn't exist yet. Returns a placeholder 4-character roster (pip, archie, yara, judge).
- `noScratchpadYet: true` — run dir exists but scratchpad not yet written. Returns empty `characters: []`.

---

## Character roster + agent-name mapping

One character per pipeline role. The agent's reported name (from scratchpad's Agent column + Agent Dispatch Log) is pattern-matched against this roster:

| Role | Character | Matches names containing |
|------|-----------|--------------------------|
| Pip | Product Owner | `product-owner`, `product-brainstormer`, `dal-product-owner`, `acme-product-owner`, … |
| Archie | Architect | `solution-architect` |
| Yara | Spec Editor | `openapi-spec-editor`, `spec-editor` |
| Shield | Security Consultant | `security-consultant`, `security-reviewer`, `security-auditor` |
| Tya | UX Consultant | `ux-consultant`, `ux-reviewer`, `ux-designer`, `dal-ux-consultant` |
| Bruno | Backend Implementer | `spring-boot-api-implementer`, `nestjs-implementer`, `fastapi-implementer`, … |
| Pixel | Frontend Implementer | `react-feature-implementer`, `nextjs-implementer`, `frontend-implementer` |
| Echo | Mock Implementer | `mock-endpoint-implementer`, `node-mock-implementer` |
| Stratos | Infra Implementer | `cdk-stack-implementer`, `cdk-implementer`, `infra-implementer` |
| Crit | Code Reviewer | `spring-boot-code-reviewer`, `react-code-reviewer`, `nestjs-reviewer`, `nextjs-reviewer`, `fastapi-reviewer`, `flask-reviewer`, `django-reviewer`, `python-worker-reviewer` |
| Judge | Assessor | `assessor`, `dal-assessor`, `acme-assessor` |
| Scribe | Reporter | `reporter` (Phase 7 summary author) |
| Sage | Context Manager | `context-manager` (Phase 7 history distiller) |
| Loop | Feedback Learner | `feedback-learner` (Phase 8 — only fires if the user opts in to feedback at Step 8.6; closing the pyramid is keyed on Loop reaching `done`) |

**Note**: `Shield` and `Tya` are listed before the implementers in `ROLE_PATTERNS` so the more-specific `*-consultant` suffix wins over a hypothetical fuzzier substring match. Order matters in `agentToRole()` — first match wins.

**Matching rules** (in `agentToRole()`):
- Exact match on any pattern → role
- Ends with `-{pattern}` → role (so workspace-published agents like `dal-assessor` resolve)
- Ends with `:{pattern}` → role (so plugin-qualified names like `pipecrew:spring-boot-api-implementer` resolve)
- Substring match → role (fallback)

Characters whose status is `skipped` are omitted from the UI. When multiple characters share a role (e.g., two backend services → two Bruno cards), IDs are suffixed: `bruno`, `bruno-2`, `bruno-3`, …

---

## Awaiting-input banner (user-gate contract)

When the orchestrator pauses for a user answer — any approval gate or clarifying question — it **must** surface the wait to the UI.

### Phase status vs gate state — two orthogonal signals

Before reading this section, internalise this: **phase status and gate state are separate signals, tracked in separate files, rendered in separate UI elements.** Do not double-encode one inside the other.

| Signal | Source file | Allowed values | What it answers | UI surface |
|--------|-------------|----------------|-----------------|------------|
| **Phase status** | `scratchpad.md` phase table | `PENDING` / `IN_PROGRESS` / `COMPLETED` / `SKIPPED` / `FAILED` (literal — nothing else) | "Is the agent for this phase running, done, or skipped?" | Per-phase pill colour (queued / working / done / skipped / failed) |
| **Gate state** | `awaiting_input.json` (via `gate.js open/close`) | Present or absent | "Is the orchestrator paused waiting for me?" | Yellow banner + `⏸` tab-title prefix |

A phase row can be `IN_PROGRESS` **and** have an open gate at the same time — that's the expected combination for "agent finished its deliverable, orchestrator is now blocked on user approval before it can flip the row to `COMPLETED`." Do NOT invent a new phase-status literal like `AWAITING_APPROVAL` to express this — the UI parser does not recognise it (maps to `queued`) and the gate banner already conveys the wait.

**Rule of thumb for orchestrators:**
- Flip the phase row to `IN_PROGRESS` *before* dispatching the phase's agent.
- Open the gate via `gate.js open` *after* the agent returns but *before* asking the user.
- On user approval: close the gate via `gate.js close`, then flip the phase row to `COMPLETED`.
- On rejection: close the gate, decide whether to re-dispatch (row stays `IN_PROGRESS`) or abandon (row flips to `FAILED`).

If a phase has no user-facing gate (e.g., Phase 4 spec sync), skip the gate calls entirely — the phase row alone drives the UI.

### What the UI shows

A yellow pulsing banner under the header:

```
⏸  WAITING FOR YOUR INPUT   phase 3 · approval   waiting 1m 42s
    Approve these spec changes to continue to Phase 4 (spec sync)?
```

A 1-second ticker updates the "waiting Xs" counter even when no state push arrives. The browser tab title gets a `⏸` prefix so you can see the waiting state in your tab list without switching focus to the UI.

### Orchestrator-side contract

Use `{plugin_dir}/scripts/gate.js` to keep open/close clean:

```bash
# Before asking the user
node {plugin_dir}/scripts/gate.js open \
  --run-dir={run_dir} \
  --phase=3 \
  --gate=approval \
  --question="Approve these spec changes?" \
  --context="2 specs edited: +321/-20 on contract-api"

# Immediately after receiving the answer
node {plugin_dir}/scripts/gate.js close --run-dir={run_dir}
```

Under the hood, `gate.js open` writes `{run_dir}/awaiting_input.json` with a `since` timestamp; `gate.js close` deletes it.

### Gate labels in use

| `--gate` value | Used by |
|----------------|---------|
| `approval` | Phase 1, Phase 2, Phase 3, Phase 4.5, Phase 5b UX |
| `fix-round` | Phase 5.5 (only if critical findings) |
| `clarify` | Product-owner clarifying questions mid-Phase 1 |

### Forgot to close?

The banner stays up forever and the tab title keeps its `⏸` prefix. On the next state update (any scratchpad change), the UI refreshes it. Subsequent real `/deliver` runs on the same terminal will look "paused" in the UI even though they're not. Treat open/close as mandatory bracketing — the critical rule in `/deliver` SKILL.md #5 enforces this.

---

## Multi-run handling (parallel `/deliver` invocations)

Each feature run has its own server instance watching its own run directory. Parallel UIs are disambiguated three ways:

1. **Browser tab title** — `{workspace} · {feature-name}` (feature-name is the human-readable slug from the `run_id`, e.g. `contract-view-and-list`). Your tab list shows one entry per run.
2. **Header in the UI** — large feature-name + small monospaced `run_id` below it.
3. **Port** — each server binds its own port. If `5173` is taken, the next server auto-increments through `5174`, `5175`, …, up to ten retries.

### Pre-flight auto-start

`/deliver` pre-flight launches each server with `--run-id={run_id}` (not just `--workspace`). Each parallel run's server locks onto its own run at startup and never drifts.

### Manual parallel start

```bash
# First run
node {plugin_dir}/skills/site-view/server.js \
  --workspace=dal --run-id=2026-04-15-200215-contract-view-and-list

# Second run (different terminal, port auto-increments)
node {plugin_dir}/skills/site-view/server.js \
  --workspace=dal --run-id=2026-04-16-091234-next-feature
```

Both open browser tabs with distinguishable titles. When `--run-id` is omitted, the server picks the most recently modified run — fine for a single-run workflow, but **always pass `--run-id` in parallel-run scenarios** so each UI is locked to its intended run.

---

## Testing — the simulate-run harness

The script at `{plugin_dir}/scripts/simulate-run.js` (exposed as the `/simulate-run` slash skill) fabricates a full feature-pipeline run on disk so the UI can be exercised end-to-end without spending any agent tokens.

### What it validates

- Scratchpad parsing (Phase Status + Implementation Tasks + Agent Dispatch Log tables)
- Checkpoint enrichment (orchestrator tokens + retry markers)
- Awaiting-input banner (both open and close)
- File watching + SSE broadcast + browser update
- Tab-title updates (workspace · feature-name, `⏸` prefix when paused)
- Parallel-run port auto-increment

### Timeline covered

1. `run_start` event + initial scratchpad skeleton
2. Phase 1 (product-owner) → finishes → opens a 4-step approval gate
3. Phase 2 (architect) → finishes
4. Phase 3 (openapi-spec-editor) → finishes
5. Phase 4 (spec sync) marked COMPLETED in one step
6. Phase 5 parallel fan-out — 4 tasks (publisher + backoffice + frontend + mock) IN_PROGRESS simultaneously; `retry` event on backoffice; staggered completion
7. Phase 5.5 code review — 3 reviewer dispatches + second `fix-round` gate
8. Phase 6 assessor
9. Phase 7 summary + `run_end`

### Usage

```bash
# Headless smoke test — ~6s, cleans up after itself
node {plugin_dir}/scripts/simulate-run.js --step-ms=150 --cleanup-on-exit

# Interactive demo — launches the UI, runs until Ctrl+C
node {plugin_dir}/scripts/simulate-run.js --step-ms=1500 --launch-ui
```

### Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--workspace=<slug>` | auto-detect | Pick the target workspace |
| `--step-ms=<n>` | 1500 | Milliseconds between timeline steps |
| `--launch-ui` | off | Spawn `server.js` as a child pointed at the simulated run |
| `--port=<n>` | 5173 | Initial UI port (auto-increments if busy) |
| `--cleanup-on-exit` | off | Delete the run dir on Ctrl+C / timeline-end |
| `--feature-name=<slug>` | `simulated-demo` | Human slug used in the run_id |

### When to use

- After editing `server.js` or `public/index.html` to confirm nothing broke
- To demo the UI to new teammates without burning tokens
- As a regression check before shipping plugin changes
- To show the banner flow (gates open, banner appears, tab title updates, gate closes, banner hides)

The simulator writes only to the fabricated run dir. Safe to run concurrently with real `/deliver` sessions.

---

## Extending / modifying

### Add a new character role

1. Add an entry to `ROLE_PATTERNS` in `server.js` — `{ role: 'newid', patterns: ['agent-name-1', 'agent-name-2'] }`
2. Add the role to `PHASE_TO_ROLE` if it's phase-level (one per phase) rather than task-level
3. Add the default name to `DEFAULT_AGENT_NAME`
4. Add a character sprite in `public/index.html`'s CSS (look for the `.char-{id}` classes)
5. Restart the server

### Change what the banner shows

The banner lives in `public/index.html` under `<div id="awaiting-input">`. State comes from `state.awaitingInput` in the SSE payload. To add fields (e.g. estimated remaining time), extend both:
- `server.js:readAwaitingInput()` — the JSON parser
- `public/index.html:applyState()` — the banner renderer
- `scripts/gate.js` — the CLI helper that writes the file

### Change data sources

If you want the server to consume a new file (e.g. `agent-dispatch.jsonl`):
1. Add the path helper in `server.js` (mirror `awaitingInputPath()`)
2. Add a reader function (mirror `readAwaitingInput()`)
3. Wire it into `getState()`
4. Add the filename to the `fs.watch` filter in `startWatching()`

---

## Troubleshooting

### Server starts but browser shows "CONNECTING" forever

- Check `/events` manually: `curl http://127.0.0.1:5173/events`. Should hold open with a `data: {...}` line.
- Verify the run directory exists — server logs `[watch] waiting for workspace dir: …` if not.
- Check firewall / localhost restrictions.

### Characters all show as `queued` even mid-run

- Likely the scratchpad's `## Phase Status` / `## Implementation Tasks` tables are empty (orchestrator discipline issue — orchestrator isn't updating them after agent dispatches per rule #13).
- Verify: `head -40 {run_dir}/scratchpad.md` — tables should have data rows.
- Workaround: the orchestrator must follow the dispatch-log protocol in `phases/dispatch-rules.md`.

### Orchestrator tokens always 0

- No `orch_checkpoint` events in `checkpoints.jsonl`. Orchestrator isn't emitting them at phase boundaries (optional per observability.md but the UI consumes them if present).
- To verify emission: `grep orch_checkpoint {run_dir}/checkpoints.jsonl`

### Banner stuck after answer received

- Orchestrator forgot to call `gate.js close`. Delete the file manually:
  ```bash
  rm {run_dir}/awaiting_input.json
  ```
- Root-cause the missing close call — it's a process discipline issue.

### Multiple UIs on same port

- Server auto-increments up to 10 retries. Check the launch log line `Live at http://127.0.0.1:{actual-port}` — it may differ from the `--port` you passed.
- If you need to kill a stuck server: find it by port (`netstat -ano | findstr :5173` on Windows, `lsof -i:5173` on macOS/Linux) and kill the PID.

### Node complains about JSDoc / syntax errors

- Check for `*/` inside JSDoc block content (e.g., in URL paths like `runs/deliver/*/scratchpad.md`). The sequence closes the comment early. Escape with HTML entities (`&lt;`) or reword the path.

---

## File manifest

```
{plugin_dir}/
├── docs/
│   └── site-view.md                ← this file
├── scripts/
│   ├── gate.js                         ← open/close awaiting_input.json
│   └── simulate-run.js                 ← test harness
└── skills/
    ├── pipeline-view/
    │   ├── SKILL.md                    ← thin manifest, points here
    │   ├── server.js                   ← HTTP + SSE + file watcher
    │   └── public/
    │       └── index.html              ← chibi queue scene + banner
    └── simulate-run/
        └── SKILL.md                    ← thin manifest, points here
```
