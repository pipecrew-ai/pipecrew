## Dispatch & Tracking Rules

**Read this file once before Phase 4.5.** These rules apply from Phase 4.5 through Phase 7 — they govern how agents are dispatched, how execution metrics are tracked, and how task files are managed. They are extracted from the SKILL.md critical rules to keep the always-loaded index lean.

---

### Agent Dispatch (TYPE_TO_AGENT mapping)

All implementer work is launched via the `Agent` tool in the current session. **NEVER `claude -p`**. The agent `subagent_type` is selected dynamically from the repo's `type` field in the workspace config:

| Config `type` | Implementer agent | Reviewer agent | `spec_policy` support |
|--------------|-------------------|----------------|----|
| `spring-boot` | `spring-boot-implementer` | `spring-boot-reviewer` | `api-first` (recommended) \| `code-first` |
| `fastapi` | `fastapi-implementer` | `fastapi-reviewer` | `api-first` (recommended) \| `code-first` |
| `flask` | `flask-implementer` | `flask-reviewer` | `api-first` (recommended) \| `code-first` |
| `django` | `django-implementer` | `django-reviewer` | `api-first` (recommended) \| `code-first` |
| `nestjs` | `nestjs-implementer` | `nestjs-reviewer` | `api-first` (recommended) \| `code-first` |
| `python-worker` | `python-worker-implementer` | `python-worker-reviewer` | `no-api` (always) |
| `react` | `react-implementer` | `react-reviewer` | consumer (reads spec / inline contract) |
| `nextjs` | `nextjs-implementer` | `nextjs-reviewer` | consumer (reads spec / inline contract) |
| `node-mock` | `mock-implementer` | *(skip — mock not reviewed)* | consumer (mirrors spec) |
| `cdk` | `cdk-stack-implementer` | `cdk-reviewer` | `infra` (always) |
| `terraform` | `terraform-implementer` | `terraform-reviewer` | `infra` (always) |
| `schemas` | `schema-implementer` (dispatched in Phase 3a, not Phase 5) | — | n/a (event schemas, not OpenAPI) |
| `api-collections` | *(not dispatched — detect-only)* | — | n/a |
| `other` | *(resolve via fallback chain below)* | — | depends on resolved agent |

The `spec_policy` column reflects what each implementer ACCEPTS (and `code-first` was added to spring-boot / fastapi / nestjs in PR #30). The actual policy per service is set in `config.services[svc].spec_policy` at `/discover` time — see `{plugin_dir}/rules/spec-policy-modes.md` for the full mode reference, who decides, and what each downstream phase does per mode.

### Implementer resolution — fallback chain for unsupported types

When the table above does NOT list a plugin-shipped implementer for a type (e.g., `type: rails`, `type: phoenix`, `type: go`, `type: other`, or any future stack the user declares in their config), resolve the implementer via this chain, in order:

1. **Workspace-local implementer** — check `~/.claude/agents/{workspace_slug}-{type}-implementer.md`. If it exists, dispatch with `subagent_type: {workspace_slug}-{type}-implementer`. These are generated during `/discover` Phase C Step 3.25 by filling `templates/agents/generic-implementer.md.template` with the repo's actual conventions, and they're tailored to the workspace.
2. **Plugin-shipped implementer** — already resolved via the table above. This step exists in the chain only for completeness.
3. **Generic fallback** — dispatch `subagent_type: general-purpose` with a preamble that points the agent at:
   - the task file
   - the repo's `CLAUDE.md`
   - 2-3 existing features to match conventions
   - the Known Anti-Patterns section in the task body

   This is a last resort — quality is lower than a workspace-local agent. Log a warning to the scratchpad and suggest the user run `/discover --resume --workspace={slug}` to publish a per-workspace agent for this type.

**When a workspace-local agent exists for a type that ALSO has a plugin agent** (e.g., the user generated `dal-spring-boot-implementer` to override some default behavior): prefer the workspace-local one. Workspace customization wins over plugin defaults. Log the override so the user can audit.

The orchestrator:
1. **Creates the worktree itself** with `Bash` before dispatching: `cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} -b feature/{feature-slug}`.
2. **Launches the agent** via `Agent` tool with `subagent_type` set to the resolved agent (per the fallback chain above) and a prompt pointing at the task file + worktree path.
3. **Runs multiple agents in parallel** by issuing multiple `Agent` tool calls in a single message (only for tasks targeting different repos — same-repo tasks run sequentially).
4. **All changes MUST land in the feature worktree**, never on the main branch.

---

### Execution Tracking (per phase, per agent dispatch, per task)

The scratchpad tracks duration and token usage at three granularities, all derived from one source: the **Agent Dispatch Log**.

**Per agent dispatch** — every time an Agent tool call returns, the orchestrator:
- Parses `duration_ms` and `total_tokens` from the `<usage>` block in the agent result
- Appends a row to `## Agent Dispatch Log` in the scratchpad: sequence number, phase, agent name, task ID (or `—`), duration (`Xm Ys`), tokens (`XK`), outcome (`COMPLETED`|`FAILED`|`PARTIAL`)

**Per phase** — the `## Phase Status` table rolls up dispatches per phase (sum of duration and tokens). For orchestrator-only phases (spec sync), duration is wall-clock and tokens are `—`.

**Per task** — each task file's YAML frontmatter holds cumulative metrics:
- `cumulative_duration_ms`, `cumulative_total_tokens`, `invocation_count`, `last_worked_by`

The task body has a `## Work Log` section. After every dispatch, append one line:
```
- {ISO-8601} · {subagent_type} · {Xm Ys} · {N}K tokens · {outcome note}
```

**Sequence per agent return**:
1. Parse `duration_ms` and `total_tokens` from `<usage>` block
2. Append row to `## Agent Dispatch Log`
3. If agent worked on a task: Edit task file (bump frontmatter metrics, append to Work Log)
4. Edit Implementation Tasks table row (refresh Duration and Tokens)
5. Edit Phase Status row (sum phase total)

Phase 7 reporter compiles these into: Phase Execution Report, Per-Task Breakdown, Per-Agent Breakdown.

---

### Task Management — Context-Lean Contract

Starting at Phase 4.5, implementation sub-tasks and reviewer findings are persisted as **markdown files** under `{run_dir}/tasks/{task-id}.md`.

**Task ID format**: `{feature-slug}-{6-hex-chars}` (e.g., `book-content-upload-a1f2-b3c4d5`).

**Frontmatter fields**:
- `id`, `feature`, `title`
- `status` (`todo` | `in_progress` | `done` | `blocked` | `wont_fix`)
- `phase` (`4.5` | `5.5` | `6` | `7`)
- `severity` (Phase 5.5 findings only)
- `repo`, `requirement_refs`, `file_refs`
- `created_at`, `updated_at`
- `cumulative_duration_ms`, `cumulative_total_tokens`, `invocation_count`, `last_worked_by`

**Body**: free-form markdown with `## Work Log` section at the end (initialized empty).

**Operations**:
- **Create**: Write tool → `{run_dir}/tasks/{task-id}.md`. Generate 6-hex suffix via `openssl rand -hex 3`.
- **Read**: Read tool → `{run_dir}/tasks/{task-id}.md`.
- **Update status**: Edit tool → replace `status:` and `updated_at:` lines.
- **List**: Glob `{run_dir}/tasks/{feature-slug}-*.md`, then Read selectively.

**Context rules**:
- Hold **task IDs** in context indefinitely. The scratchpad Implementation Tasks table holds IDs + status only — never bodies.
- Never hold **task bodies** across turns. Read once, consume immediately, don't re-quote.

---

### Checkpoint event emission

All events go to `{run_dir}/checkpoints.jsonl` in the unified schema defined at `{plugin_dir}/rules/observability.md`. The schema is shared with `/discover`, `/review`, and `/assess` so the reporter can consume every skill the same way.

**Agent dispatches** → emit `agent_start` **immediately before** every `Agent` tool call, then `agent_end` after it returns. This applies to **every** dispatch — the parallel background agents (Phase 5a/5c/5d implementers, Phase 5.5 reviewers) *and* the agents the orchestrator runs inline (Phase 1 product-owner, Phase 2 solution-architect, Phase 3 openapi-spec-editor, Phase 5b ux-consultant). Without the leading `agent_start` the live site-view never shows the agent in its "working" state — it appears only after it has already finished, and its tokens attach only at completion.
- `agent_start`: include `agent_type`, `description`, `phase`, `stage` (and `task` when task-scoped). For per-repo agents the `description` MUST encode the repo (e.g. `Backend implementer — publisher-service`, `Code review — publisher-service`) so the view keys each instance to its repo instead of collapsing them into one "cross-repo" card.
- `agent_end`: parse the `<usage>` block from the tool result, copy the token (`total_tokens` + the per-type counts) / `tool_uses` / `duration_ms` fields into the event, and reuse the **same** `agent_type` + `description` (+ `task` if the `agent_start` carried one) so the two pair up. Include `status`.

See `rules/observability.md` for the exact shape of both events.

**Retries** → emit `retry` between a failed `agent_end` and the redispatch.

**Phase boundaries** → emit `phase_start` on entry and `phase_end` on exit (with `duration_ms`).

**Slow bash commands** (> 5000 ms) → emit `bash_slow` with `duration_ms` and `cmd_summary` (first 60 chars).

**Orchestrator overhead tracking** — the orchestrator itself consumes tokens (loading skills, reading files, approval gates, scratchpad updates). Capture this with the `orch_checkpoint` event at every phase boundary:

1. **Record the session JSONL byte-offset**:
   ```bash
   wc -c < "~/.claude/projects/{project}/{sessionId}.jsonl"
   ```
   Store as `jsonl_offset`.

2. **Compute `orch_since_last`** — the orchestrator-only delta since the previous `orch_checkpoint`:
   - Read the session JSONL from `previous_offset` to `current_offset`.
   - Sum the per-line `"usage"` fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`.
   - Subtract any agent-dispatch tokens that landed in this range (already captured in `agent_end` events for this phase).
   - The remainder is orchestrator overhead.

3. **Emit the event**:
   ```json
   {
     "ts": "2026-04-15T14:27:44Z",
     "event": "orch_checkpoint",
     "skill": "deliver",
     "run_id": "2026-04-15-142744-book-upload",
     "phase": "2",
     "stage": "Architecture",
     "jsonl_offset": 284500,
     "orch_since_last": { "input_tokens": 1240, "output_tokens": 3100, "cache_read_tokens": 42000 }
   }
   ```

**Finding the session JSONL path**: the current session's JSONL is the most recently modified `.jsonl` under `~/.claude/projects/`:
```bash
ls -t ~/.claude/projects/*/*.jsonl | head -1
```
Cache this path at Pre-flight — it won't change during the run.

**First `orch_checkpoint`** of the run: emit at Pre-flight completion with `previous_offset = 0`. This captures the baseline before any agents run.

**Update the Phase Status table** in the scratchpad alongside each `orch_checkpoint` — include `Orch Tokens` so humans see the overhead too. The `reporter` agent reads both scratchpad and checkpoints.jsonl at Phase 7 but checkpoints is the authoritative source.

**Why this matters**: on a typical pipeline run, the orchestrator consumes 50-100K tokens (reading specs, loading phase files, approval conversations) — 20-40% of the total run cost. Without `orch_checkpoint` events, optimization efforts focus only on agent prompts while the orchestrator's overhead grows silently.
