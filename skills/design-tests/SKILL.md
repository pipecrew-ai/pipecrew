---
name: design-tests
description: "Author feature-level acceptance test cases for a workspace and maintain them as a durable regression suite under {workspace_root}/{slug}/testcases/. Wraps the pipecrew:test-designer agent's draft → user gate → persist protocol. Default: baseline mode — characterization cases for the workspace's EXISTING features (from platform.md + repo profiles/specs). With --run=<run_id>: cases for the feature a past /deliver run shipped (from its FR/EC + technical design, zero code reads). 'status' renders the suite index. Standalone — does not touch /deliver or /discover."
---

## Usage
```
/design-tests [--workspace=<slug>] [--only=<feature,...>]     # baseline: existing features
/design-tests --run=<run_id> [--workspace=<slug>]             # cover a past /deliver run's feature
/design-tests status [--workspace=<slug>]                     # show the suite index
```

### Flags
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--workspace` | no | auto-detect | Workspace slug — resolved via the registry |
| `--run` | no | — | A past `/deliver` run id; switches the designer to `deliver` mode, sourcing that run's FR/EC + technical design |
| `--only` | no | all features | Baseline mode only — comma-separated feature subset to cover |

### Examples
```
/design-tests                                   # baseline suite for every feature platform.md names
/design-tests --only=book-upload,contract-types
/design-tests --run=2026-10-02-141530-bulk-status-change
/design-tests status
```

## Instructions

### CRITICAL RULES

1. **Read-isolation.** The suite under `{workspace_root}/{slug}/testcases/` is consumed ONLY by the test-designer and the (future) regression runner. Never add pointers to it in platform.md, AGENTS.md, repo context docs, or routing files, and never load case files into context beyond what the user explicitly asks to see. `status` shows INDEX.md only.
2. **Gate before persist.** The durable suite is only ever written by the agent's `persist` phase, and `persist` is only ever dispatched after the user approved the draft at the gate below. No exceptions, including re-runs.
3. **Never hand-edit the suite.** All writes to `testcases/` go through the agent (supersede-with-retire semantics live there). If something looks wrong in a persisted file, re-run this skill — don't patch the file inline.

### Step 1: Resolve workspace + mode

Resolve the workspace from the registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json` (add `--workspace=<slug>` if passed) → `{slug}`, `{workspace_root}`. If it exits 3 with several candidates, ask which; with none, tell the user to run `/discover` first and stop.

Mode:
- `status` argument → **Step 5** only.
- `--run=<run_id>` → **deliver mode**. Verify `{workspace_root}/{slug}/runs/deliver/{run_id}/outputs/phase-1-requirements.md` and `outputs/phase-2-architecture.md` exist — if not, list the run ids under `runs/deliver/` and ask the user to pick (or stop if none). Derive `{feature_slug}` from the run's scratchpad / requirements output; take `{feature_summary}` from the requirements doc's summary paragraph.
- otherwise → **baseline mode** (honor `--only=`).

Set `{draft_dir}` = `{workspace_root}/{slug}/runs/design-tests/{YYYY-MM-DD-HHMMSS}/` and create it (`runs/` is local-only — never synced).

### Step 2: Dispatch the draft

**Tool**: `Agent` · **subagent_type**: `pipecrew:test-designer` · **description**: `"Draft test cases — {feature_slug or 'baseline'}"`

Prompt (deliver mode):
```
mode: deliver
phase: draft
workspace_root: {workspace_root}
slug: {slug}
draft_dir: {draft_dir}
run_dir: {workspace_root}/{slug}/runs/deliver/{run_id}
feature_slug: {feature_slug}
feature_summary: {feature_summary}
```

Prompt (baseline mode):
```
mode: baseline
phase: draft
workspace_root: {workspace_root}
slug: {slug}
draft_dir: {draft_dir}
{if a recent /discover run dir with REPO_PROFILE JSONs exists under runs/discover/: discover_run_dir: {path}}
{if --only: feature_scope: {list}}
```

If the agent reports platform.md is too stale/thin to enumerate features from, relay its message (run `/context-refresh` first) and stop — do not let it re-analyze repos.

### Step 3: Gate

Show the agent's draft summary (case counts, prod-safe counts, supersede plan, features skipped, and EVERY `assumption:` — in baseline mode the assumptions list is where a latent bug would get enshrined as "expected behavior", so surface it prominently) plus the drafted cases themselves:

```
Acceptance test cases — draft ({N} cases, {M} prod-safe{, K features} )
{draft summary + cases}

Persist to {slug}/testcases/? (yes / adjust / no)
  yes    → write the durable suite (+ INDEX.md)
  adjust → tell me what to change; the designer re-drafts, then I re-ask
  no     → discard the draft (nothing durable is written)
```

On `adjust`: collect the pushback verbatim, re-dispatch `phase: draft` with all accumulated adjustments appended to the prompt, re-gate. On `no`: stop — the draft stays in `{draft_dir}` for reference, nothing else happens.

### Step 4: Persist + sync offer

On `yes`, dispatch `pipecrew:test-designer` again with the same mode plus:
```
phase: persist
draft_path: {draft file (deliver) or draft dir (baseline)}
adjustments: {accumulated gate pushback, or "none"}
```

Relay its report (per-feature `written | superseded (K kept / R retired / A added)`, total active cases).

Then, if `config.workspace.memory.enabled` is true, offer (don't auto-run):
```
Sync the updated test suite to the team memory repo now?  (yes / no)
yes → node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} --message "design-tests: {feature_slug or 'baseline'}" --checkpoint=design-tests
no  → it rides the next sync automatically (testcases/ is in the allow-list)
```

### Step 5: status

Read `{workspace_root}/{slug}/testcases/INDEX.md` and render it as-is (one line per feature: active/prod-safe counts, surfaces, authored, last_verified). If it doesn't exist: `No test suite yet — run /design-tests to create one.` Open an individual case file ONLY if the user names a specific feature afterwards.

## Notes
- **Relationship to the agent**: this skill is the front door; `pipecrew:test-designer` holds the case format, sizing rule (3–8 per feature), outermost-surface rule, and supersede semantics. Direct agent dispatch remains possible but this skill is preferred — it guarantees the gate.
- **Regression execution is NOT this skill.** Running the suite (UAT first-pass, staging release gate, production prod-safe smoke) is the deferred `/pipecrew:run-regression` — see `docs/design/test-cases.md`.
- **Pipelines untouched.** `/deliver` and `/discover` do not invoke this; integration into those flows is a recorded follow-up in the same design doc.
