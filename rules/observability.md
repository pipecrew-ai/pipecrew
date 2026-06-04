# Observability — unified run directory + event schema

This is the **source of truth** for how every skill in the plugin records what it did. Every skill MUST emit events in this shape to the run's `checkpoints.jsonl`. The `reporter` agent reads this format; the `scripts/validate-checkpoints.js` validator enforces it; cross-skill trending depends on it.

## Run directory — one dir per run, everything inside

```
{workspace_root}/{slug}/runs/{skill}/{run_id}/
├── scratchpad.md              human-readable phase state (used by --resume)
├── checkpoints.jsonl          machine-readable event log (this doc)
├── outputs/                   phase artifacts consumed by later phases
│   └── phase-{n}-{name}.md
├── review/                    per-repo code-review reports (optional, /deliver only)
├── security-review.md         optional — if --force-security-review (or trigger) was passed
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
| `event` | enum | always | One of the 8 event types below |
| `skill` | enum | always | `"discover" \| "deliver" \| "learn" \| "review" \| "assess" \| "context-refresh"` |
| | | | Legacy runs may carry the pre-rename values `"onboard"` / `"feature"`; the validator accepts both for backcompat. |
| `run_id` | string | always | Matches the directory name |
| `phase` | string | phase-scoped events | Skill-specific phase identifier (e.g., `"B2"`, `"5a"`) |
| `stage` | string | phase-scoped events | Human-readable phase name (e.g., `"Architect Discovery"`) |

Fields that have no source data → **omit the key entirely**. Do not fabricate zero values. The validator rejects fabricated `0` for fields the caller couldn't have measured.

### Event types — the 8 canonical events

#### `run_start` — first line of every log

```json
{
  "ts": "2026-04-15T09:12:34Z",
  "event": "run_start",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "workspace_slug": "dal",
  "args": "--workspace=dal --greenfield"
}
```

Extra fields: `workspace_slug` (always), `args` (CLI args passed), `claude_code_version` (if detectable).

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
  "input_tokens": 23105,
  "output_tokens": 8942,
  "cache_read_tokens": 45780,
  "cache_write_tokens": 0,
  "total_tokens": 77922,
  "tool_uses": 28,
  "duration_ms": 242835,
  "status": "ok",
  "audit_findings_count": 3
}
```

Required: `agent_type`, `description`, `status`, `duration_ms`, and the token fields the `<usage>` block provided. Optional: `audit_findings_count` (only if the agent emitted a `## Audit Findings` section).

`status` enum: `ok` | `retry` | `failed` | `deferred`.

#### `orch_checkpoint` — orchestrator-overhead delta since last checkpoint

Captures the tokens the **orchestrator itself** burned between agent dispatches (reading files, approvals, scratchpad updates, tool-call overhead). Critical for attribution — on a typical run, orchestrator overhead is 20-40% of total cost and invisible without this event.

```json
{
  "ts": "2026-04-15T09:18:10Z",
  "event": "orch_checkpoint",
  "skill": "discover",
  "run_id": "2026-04-15-091234-dal",
  "phase": "B2",
  "stage": "Architect Discovery",
  "jsonl_offset": 284500,
  "orch_since_last": {
    "input_tokens": 1240,
    "output_tokens": 3100,
    "cache_read_tokens": 42000
  }
}
```

Required: `jsonl_offset` (byte offset into `~/.claude/projects/{project}/{session}.jsonl` at emission time), `orch_since_last` (delta from previous `orch_checkpoint` in this run).

How to compute `orch_since_last`: read the session JSONL from `previous_offset` to `current_offset`, sum `usage.{input_tokens,output_tokens,cache_read_input_tokens}` per line, then subtract any `agent_end` tokens that fell in this range (already accounted separately). First `orch_checkpoint` of a run uses `previous_offset = 0`.

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

## Parsing the `<usage>` block

Every `Agent` tool response ends with a footer:

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

If `<usage>` is absent (tool error before usage was reported), emit `agent_end` with `status: "failed"` and no token fields — but keep `agent_type`, `description`, `phase`, `stage`, `duration_ms` if you have them.

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
