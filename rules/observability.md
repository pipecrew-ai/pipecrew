# Observability — unified run directory + event schema

This is the **source of truth** for how every skill in the plugin records what it did. Every skill MUST emit events in this shape to the run's `checkpoints.jsonl`. The `reporter` agent reads this format; the `scripts/validate-checkpoints.js` validator enforces it; cross-skill trending depends on it.

## Run directory — one dir per run, everything inside

```
{workspace_root}/{slug}/runs/{skill}/{run_id}/
├── scratchpad.md              human-readable phase state (used by --resume)
├── checkpoints.jsonl          machine-readable event log (this doc)
├── outputs/                   phase artifacts consumed by later phases
│   └── phase-{n}-{name}.md
├── review/                    per-repo diffs + reviewer-written reports ({repo}.diff, {repo}-report.md; /deliver only)
├── security-review/           optional — per-repo security reports, if --force-security-review (or trigger) was passed
│                              (legacy runs may have a single security-review.md instead)
├── assessment.md              optional — /deliver Phase 6 output
├── fix-rounds/                optional — per fix-round outputs
└── report.md                  final run report (reporter agent output)
```

**Key property**: one dir = one complete run. Tar it, ship it, delete it, diff two of them side by side — all atomic.

### Stable workspace-level files (live at workspace root, NOT per-run)

```
{workspace_root}/{slug}/
├── config.json                the workspace contract
├── context/                   active context (read by orchestration-tier agents every dispatch)
│   ├── platform.md            updated by /discover and /context-refresh
│   ├── audit-findings.md      design-system.md is per-repo: {repo_path}/agent-context/design-system.md
│   ├── adrs/                  architecture decision records (INDEX.md + ADR-NNN-<slug>.md)
│   └── diagrams/              workspace architecture diagrams (architecture.mmd, architecture-overview.mmd, topic diagrams)
├── history/                   durable workspace history (NOT auto-loaded — humans + next /learn dedup)
│   └── learn-log.md           append-only — populated by /learn over time
├── agents/                    generated from templates at onboarding, stable
├── agent-memory/              thin private-notes scope (rare — most decisions go to context/adrs/)
│   └── solution-architect/    genuinely architect-private observations only
└── runs/                      per-run state (see above)
```

## `run_id` — uniqueness + traceability

Format: `{YYYY-MM-DD-HHMMSS}-{slug}`

- Slug = feature name for `/deliver`, workspace name for `/discover`, repo name for `/review` and `/assess`.
- Sortable: `ls runs/deliver/` is chronological.
- Human-readable: a glance tells you what and when.
- Collision policy: if two runs start in the same wall-clock second (rare), the second appends `-2`, `-3`, etc. at creation time.

Examples:
- `2026-04-15-091234-dal` (onboard)
- `2026-04-15-104502-book-upload` (feature)
- `2026-04-15-152200-publisher-service` (review)

## Event schema

Every line in `checkpoints.jsonl` is one JSON event on its own line. Append-only — never rewrite.

### Common fields (every event)

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | ISO8601 UTC | always | Emission time (e.g., `"2026-04-15T14:27:44Z"`) |
| `event` | enum | always | One of the 11 event types below |
| `skill` | enum | always | `"discover" \| "deliver" \| "learn" \| "review" \| "assess" \| "context-refresh"` |
| | | | Legacy runs may carry the pre-rename values `"onboard"` / `"feature"`; the validator accepts both for backcompat. |
| `run_id` | string | always | Matches the directory name |
| `phase` | string | phase-scoped events | Skill-specific phase identifier (e.g., `"B2"`, `"5a"`) |
| `stage` | string | phase-scoped events | Human-readable phase name (e.g., `"Architect Discovery"`) |
| `stage_group` | enum | optional | Canonical `/deliver` chapter — see below |

Fields that have no source data → **omit the key entirely**. Do not fabricate zero values. The validator rejects fabricated `0` for fields the caller couldn't have measured.

#### Canonical stage grouping (`stage_group`)

A `/deliver` run's phases group into six ordered chapters: **understand → contract → build → verify → ship → learn**. This grouping powers the site-view rail and cross-run trending.

`phase` is the **source of truth** — the chapter is *derived* from it (see `scripts/stages.js`, which all consumers — the site-view server, the reporter, this validator — share). `stage` stays a free-text human label for reports; do **not** repurpose it.

`stage_group` is an **optional, self-describing** echo of the derived chapter. Emit it only as hardening; when absent, consumers derive the chapter from `phase` (with role fallbacks, e.g. the feedback-learner runs in phase `8`/publish but belongs to `learn`). When present it MUST be one of the six enum values — the validator enforces membership. Because it is derived, never let an emitted `stage_group` be the authority over `phase`.

### Event types — the 11 canonical events

#### `run_start` — first line of every log

```json
{
  "ts": "2026-04-15T09:12:34Z",
  "event": "run_start",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "workspace_slug": "dal",
  "args": "--workspace=dal --greenfield",
  "session_id": "2ed98d97-4d59-4e46-bc11-ae9ef54e1bd2"
}
```

Extra fields: `workspace_slug` (always), `args` (CLI args passed), `session_id` (the value of `$CLAUDE_CODE_SESSION_ID` — records which Claude session ran the orchestrator so orchestrator-overhead tokens can be derived from its transcript; see `orch_checkpoint` below), `claude_code_version` (if detectable).

#### `run_end` — last line of every log

```json
{
  "ts": "2026-04-15T09:28:47Z",
  "event": "run_end",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "status": "completed",
  "duration_ms": 933412
}
```

Extra fields: `status` (`completed` | `failed` | `aborted` | `resumed_later`), `duration_ms` (from `run_start`).

#### `phase_start` — entering a phase (before any work in it)

```json
{
  "ts": "2026-04-15T09:14:02Z",
  "event": "phase_start",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "phase": "B2",
  "stage": "Architect Discovery"
}
```

#### `phase_end` — phase complete, scratchpad updated, before the "phase done" chat line

```json
{
  "ts": "2026-04-15T09:18:05Z",
  "event": "phase_end",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "phase": "B2",
  "stage": "Architect Discovery",
  "duration_ms": 242835
}
```

Extra fields: `duration_ms` (computed from matching `phase_start`).

#### `agent_start` — immediately before every `Agent` tool call

```json
{
  "ts": "2026-04-15T09:14:05Z",
  "event": "agent_start",
  "skill": "deliver",
  "run_id": "2026-04-15-104502-book-upload",
  "phase": "5a",
  "stage": "Backend implementation",
  "agent_type": "spring-boot-implementer",
  "description": "Backend implementer — publisher-service"
}
```

Required: `agent_type`, `description`. Optional: `task` (the task-file id, when the dispatch is task-scoped). Like all phase-scoped events it also carries `phase` + `stage`.

**Lifecycle rule — emit `agent_start` before EVERY `Agent` dispatch, background and inline alike.** This explicitly includes the agents the orchestrator runs inline (product-owner, solution-architect, openapi-spec-editor, ux-consultant), not just the parallel background dispatches. The matching `agent_end` closes it; the pair is matched on `agent_type` + `description` (and `task` when present). Without a preceding `agent_start`, the live site-view has no "working" interval to render — the agent only ever appears once it has already finished, and its tokens attach only at completion. For agents that run per-repo (implementers, reviewers), the `description` MUST encode the repo (e.g. `Code review — publisher-service`) so the view keys each instance to its own repo instead of collapsing them into a single "cross-repo" card.

#### `agent_end` — every `Agent` tool call returns (success or failure)

```json
{
  "ts": "2026-04-15T09:17:58Z",
  "event": "agent_end",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "phase": "B2",
  "stage": "Architect Discovery",
  "agent_type": "solution-architect",
  "description": "Architect discovery for Digital Arabic Library",
  "status": "ok",
  "audit_findings_count": 3
}
```

Required: `agent_type`, `description`, `status`. Optional: `task` (task-file id), `audit_findings_count` (only if the agent emitted a `## Audit Findings` section).

**No token or duration fields** — current Claude Code gives the orchestrator no inline visibility into per-agent usage, so it MUST NOT emit (or fabricate) `total_tokens` / `input_tokens` / `duration_ms` here. Consumers (site-view, reporter) derive them from the session transcript via `scripts/orch-tokens.js` — see "Per-agent tokens & duration" below. Legacy logs from older Claude Code versions may carry `<usage>`-derived token fields on `agent_end`; consumers still honor them when present.

`status` enum: `ok` | `retry` | `failed` | `deferred`.

#### Orchestrator overhead — derived from the session transcript (not hand-emitted)

The tokens the **orchestrator itself** burns (loading skills, reading files/specs, scratchpad updates, approval gates, and reading agent RESULTS) are 20-40% of total run cost and must be attributed.

**This is now DERIVED, not hand-computed.** The old approach — the orchestrator inline byte-offset-diffing its own session JSONL and emitting an `orch_checkpoint` per phase — was too complex and was skipped in practice (real runs emitted empty `orch_checkpoint`s, so overhead showed as 0). Instead:

- **`run_start` records `session_id`** (`$CLAUDE_CODE_SESSION_ID`).
- **`scripts/orch-tokens.js`** computes overhead deterministically = the sum of the session transcript's own `assistant` `message.usage` (`input` + `output` + `cache_creation`). Sub-agent tokens live in **separate** `subagents/agent-*.jsonl` transcripts, so they are NOT in the parent session's usage — **no subtraction**. cache-read is excluded from the headline `total` (it counts re-reads of the growing context, not new tokens) but **included in every `costUSD`** at the cache-read rate — on long orchestrator sessions cache reads are the dominant token class, so a cost figure that drops them badly under-counts. The script also emits per-agent `usage` breakdowns + `costUSD` (from the sub-transcripts) and run `totals` incl. `orchestratorCostShare`; a `null costUSD` means unmeasured — consumers report it as such, never estimate.
- The **site-view** and **reporter** call it (keyed on `session_id`) — no orchestrator math required.

`orch_checkpoint` events remain **optional/legacy**: consumers still sum any `orch_since_last` deltas as a fallback for runs with no `session_id`, but new runs should rely on `session_id` + `orch-tokens.js` rather than hand-emitting them.

```json
{
  "ts": "2026-04-15T09:18:10Z", "event": "orch_checkpoint", "skill": "discover",
  "run_id": "2026-04-15-091234-dal", "phase": "B2", "stage": "Architect Discovery",
  "orch_since_last": { "input_tokens": 1240, "output_tokens": 3100, "cache_creation_tokens": 900 }
}
```

#### `bash_slow` — any Bash call with `duration_ms > 5000`

```json
{
  "ts": "2026-04-15T09:15:20Z",
  "event": "bash_slow",
  "skill": "deliver",
  "run_id": "2026-04-15-104502-book-upload",
  "phase": "5a",
  "stage": "Backend implementation",
  "duration_ms": 8420,
  "cmd_summary": "mvn clean verify -DskipITs"
}
```

Required: `duration_ms`, `cmd_summary` (first 60 chars of the command, trimmed). Do NOT emit `bash_start`/`bash_end` pairs for every shell call — only slow ones.

#### `retry` — between a failed `agent_end` and its retry dispatch

```json
{
  "ts": "2026-04-15T09:16:01Z",
  "event": "retry",
  "skill": "deliver",
  "run_id": "2026-04-15-104502-book-upload",
  "phase": "5a",
  "stage": "Backend implementation",
  "agent_type": "spring-boot-implementer",
  "description": "Publisher backend — book content upload",
  "retry_reason": "529 overloaded"
}
```

Required: `agent_type`, `description`, `retry_reason`. The subsequent retry produces its own `agent_end` event with `status` = `ok` (retry succeeded) or `deferred` (retry also failed).

#### `gate_open` — a user-approval / clarification gate is shown

```json
{
  "ts": "2026-04-15T09:18:30Z",
  "event": "gate_open",
  "skill": "deliver",
  "run_id": "2026-04-15-104502-book-upload",
  "phase": "3",
  "gate": "approval",
  "question": "Approve these spec changes to continue to Phase 4?"
}
```

Required: `phase`, `gate`, `question`. `gate` enum: `approval` | `clarify` | `fix-round`. Optional: `context_summary`. Emitted by `scripts/gate.js open` (it derives `skill` + `run_id` from the run-dir path) so the **audit trail** records every gate the run paused at — the live banner comes from the `awaiting_input.json` flag the same script writes; this event is the replayable record the reporter reads. (Claude Code's own permission prompts are surfaced via `awaiting_claude_approval.json` by `notify-hook.js` and are **not** checkpoint events — they're not the pipeline's gates.)

#### `gate_close` — the gate was answered / dismissed

```json
{
  "ts": "2026-04-15T09:19:05Z",
  "event": "gate_close",
  "skill": "deliver",
  "run_id": "2026-04-15-104502-book-upload",
  "duration_ms": 35000
}
```

Required: none beyond the common fields. Optional: `duration_ms` (how long the gate was open — `gate.js close` computes it from the open flag's `since`). Pairs with the preceding `gate_open`.

## Per-agent tokens & duration

> **Current Claude Code (v2.1.x+): the orchestrator can't capture these — skip to
> "consumer-DERIVED" below.** The `<usage>`-footer path here is **legacy** (older
> CC only) and is documented for backward-compat with historical logs.

**(Legacy)** older `Agent` tool responses ended with a footer the orchestrator could parse:

```
agentId: a692490f10491aee9 (use SendMessage with to: 'a692490f10491aee9' to continue this agent)
<usage>total_tokens: 77922
tool_uses: 28
duration_ms: 242835</usage>
```

Newer Claude Code versions include additional lines: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.

Parse with:

```
/<usage>([\s\S]*?)<\/usage>/
```

Split the captured body by newlines, parse each `key: value` pair, coerce numeric values to integers. Copy whatever keys are present into the `agent_end` event (normalize key names to snake_case).

> **Token field name:** emit the grand total as `total_tokens` (the name the `<usage>` block uses). Some older logs carry it as bare `tokens`; consumers (e.g. the site-view) MUST accept either `total_tokens` or `tokens` so per-agent and total token counts populate regardless of the producer's vintage. **Likewise always emit the agent identity as `agent_type`** (never bare `agent`) — a run that writes `agent` makes its whole per-agent breakdown vanish in strict consumers.

### The orchestrator can NO LONGER read per-agent tokens — they are consumer-DERIVED

Current Claude Code (v2.1.x+) does **not** put a `<usage>` footer in the `Agent` tool result content. The real numbers live in a `toolUseResult` object (`totalTokens`, `totalDurationMs`, `agentId`, `prompt`, …) — but that object is **metadata on the transcript JSONL line, NOT in the tool-result content the orchestrator model receives.** So the orchestrator **cannot** parse per-agent tokens/duration inline (same limitation that made `orch_checkpoint` unreliable). Do not instruct it to.

Therefore per-agent tokens/duration are **derived by consumers** (the site-view and the `reporter`) from the session transcript — exactly like orchestrator overhead. Each `Agent` dispatch's `toolUseResult.totalTokens` / `totalDurationMs` is read from `~/.claude/projects/{project}/{session}.jsonl` (resolved via the `session_id` on `run_start`) and matched to the run's `agent_end` events by `description`.

What the orchestrator still emits in `agent_end`: the **structure** it knows — `agent_type` (never bare `agent`), `description` (repo-encoded, so consumers can match it), `phase`, `stage`, `status`, and `task` when present. It does **not** emit `total_tokens` / `duration_ms` — those aren't visible to it; consumers fill them from the transcript. (Older logs may carry `<usage>`-derived token fields on `agent_end`; consumers still honor them when present, but nothing produces them now.) A missing token field is **not** a failure — only emit `status: "failed"` when the agent genuinely errored.

## Retry interaction

On a 529 / 503 / 429 / network error:

1. Emit `agent_end` with `status: "failed"` and whatever usage was returned (often none).
2. Emit `retry` with `retry_reason` set to the error code.
3. Wait per the skill's transient-failure rules (30 s / 60 s / `retry-after`).
4. Re-dispatch the agent with the same prompt.
5. Emit a fresh `agent_end` on return with `status: "ok"` (success) or `status: "deferred"` (retry also failed; do not retry again).

## Resume semantics (`--resume`)

A resumed run **appends to the existing `runs/{skill}/{run_id}/checkpoints.jsonl`**. Same `run_id`, same dir. At resume:

1. Emit an event with `event: "phase_start"` for the phase the resume is entering.
2. The scratchpad keeps its prior content; new work appends.
3. If the resume starts a phase that previously ran partially, the old `phase_end` for it is absent — the new `phase_end` closes the pair.

There is no `resume_point` event — the reporter can derive resume boundaries by spotting a gap in `ts` values greater than (for example) 1 hour. Keeps the schema smaller.

## Reporter consumption

The `reporter` agent produces two kinds of reports:

**Per-run report** (`runs/{skill}/{run_id}/report.md`): one report per run, emitted at `run_end`. Shape is skill-specific but the input schema is the same.

**Cross-run report** (`scripts/report.js --workspace={slug} [--skill=feature] [--last=N]`): aggregates across `runs/*/*/checkpoints.jsonl`. Joins on `run_id` — never merges numbers from different runs. Useful for trend analysis (e.g., "median `/deliver` token cost this month vs last").

## Validator

`scripts/validate-checkpoints.js {path-to-checkpoints.jsonl}` exits:
- `0` — clean
- `1` — schema violation (missing required field, wrong type, unknown event type, forbidden fabricated value)
- `2` — soft warning (e.g., missing `run_start` or `run_end`, non-monotonic `ts` within a run)

Run the validator in CI on fixture logs; run it once as a post-run sanity check at the end of every skill.

## Examples — what a complete run log looks like

See `tests/fixtures/observability/` for end-to-end example logs covering: clean onboard, feature with retry, review with slow bash, resumed onboard. Each fixture is validated in CI.

## Schema revision policy

This schema is versioned via the plugin's semver. Any change that:
- Adds a new event type → minor version bump.
- Adds an optional field to an event → minor version bump.
- Renames a field, changes a field type, removes an event type → major version bump (unlikely; avoid).

The JSON Schema file at `templates/checkpoints-event.schema.json` is the machine-readable companion and must move in lockstep.
