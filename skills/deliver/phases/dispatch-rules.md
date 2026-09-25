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

1. **Workspace-local implementer** — check `{agents_dir}/{workspace_slug}-{type}-implementer.md`, where `{agents_dir}` is the harness user-level agents dir (`node {plugin_dir}/scripts/workspace-root.js --agents-dir` → `~/.claude/agents/` under Claude Code, `~/.cursor/agents/` under Cursor). If it exists, dispatch with `subagent_type: {workspace_slug}-{type}-implementer`. These are generated during `/discover` Phase C Step 3.25 (interactive gate, option (a) Generate) by filling `templates/agents/generic-implementer.md.template` with the repo's actual conventions, tailored to the workspace.
2. **Mapped agent** — if step 1 misses, check `{workspace_root}/{slug}/agents/type-map.json` (written by Phase C Step 3.25 when the user chose option (c) Map). If `type-map.json[{type}]` is set, dispatch with that `subagent_type`. This lets the user redirect an unsupported type to an existing agent without generating a new one.
3. **Plugin-shipped implementer** — already resolved via the table above. This step exists in the chain only for completeness.
4. **Hand-write noted** — if the `/discover` Phase C Step 3.25 scratchpad records decision `hand-write` for this type (check `## Custom-Agent Decisions` in the most recent discover scratchpad), emit a prominent warning:
   ```
   Warning: no implementer for type '{type}' — marked hand-write during /discover.
   An agent must be authored before this type can be dispatched.
   Place it at {agents_dir}/{workspace_slug}-{type}-implementer.md and re-run.
   ```
   Then fall through to step 5 only if the user explicitly confirms to continue anyway.
5. **Generic fallback** — dispatch `subagent_type: general-purpose` with a preamble that points the agent at:
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

### Return Contract — digests in, artifacts on disk

**Everything an agent returns becomes permanent orchestrator context, re-read on every turn until the run ends.** A return is rented for the rest of the run; a file is free until someone Reads it. So the universal contract for every dispatch, in every phase:

1. **The dispatch names a run-dir file for any heavyweight output** (report, design, spec, consultation — anything over roughly 1K tokens of narrative). The agent writes the full artifact there itself.
2. **The agent's final message is a digest**: the artifact path, a verdict/summary of 2–3 sentences, any machine-readable blocks the orchestrator parses (FINDINGS, counts, status), and any small must-carry sections (`## Notes for /learn`, `## Assumptions` — these stay in the digest because the orchestrator routes them). Target ≤ ~30 lines.
3. **The digest must be decision-sufficient.** Whatever the orchestrator's next action needs — gate presentation, fix routing, scratchpad fields (files changed, test result, status) — must be IN the digest. A digest so thin the orchestrator has to Read the artifact back defeats the purpose and is worse than a right-sized return.
4. **The orchestrator never reads the artifact back into context.** Downstream consumers (implementers, reviewers, the assessor, `/learn`, the reporter) receive the *path* and Read it themselves — subagent context is disposable, orchestrator context is not. When a slice of an artifact must enter a later dispatch prompt, extract just that block (`extract-block.js`), or better, pass the path.
5. **Small structured returns skip the ceremony.** A spec-editor diff summary or a "done, N handlers" is fine inline — don't create files for returns already digest-sized.
6. **No file path in the dispatch → legacy contract.** An agent asked for heavyweight output without a named artifact file returns it in full, as before. This keeps standalone skills (`/review`) and third-party dispatches working.

Who writes what today: reviewers → `review/{repo}-report.md`; architect → `outputs/phase-2-architecture.md`; product-owner → `outputs/phase-1-requirements.md`; ux-consultant → `outputs/phase-5b-ux-spec.md`; assessor → `assessment.md`; security-consultant → `security-review/{repo}.md`; implementers → `## Implementation Report` appended to their own task file (and fix-round reports to `fix-rounds/round-{N}/{repo}.md`); reporter → `report.md`.

---

### Execution Tracking (per phase, per agent dispatch, per task)

The scratchpad tracks duration and token usage at three granularities, all derived from one source: the **Agent Dispatch Log**.

**Per agent dispatch** — every time an Agent tool call returns, the orchestrator appends a dispatch-log row with what it can see (phase, agent, task, outcome). It does **not** record tokens/duration: those aren't visible to the orchestrator (Claude Code keeps them in `toolUseResult` metadata, not the tool-result content), so the site-view / reporter derive them from the session transcript. Leave token/duration cells as `—`. See `rules/observability.md`.
- Appends a row to `## Agent Dispatch Log` in the scratchpad: sequence number, phase, agent name, task ID (or `—`), duration (`Xm Ys`), tokens (`XK`), outcome (`COMPLETED`|`FAILED`|`PARTIAL`)

**Per phase** — the `## Phase Status` table rolls up dispatches per phase (sum of duration and tokens). For orchestrator-only phases (spec sync), duration is wall-clock and tokens are `—`.

**Per task** — each task file's YAML frontmatter holds cumulative metrics:
- `cumulative_duration_ms`, `cumulative_total_tokens`, `invocation_count`, `last_worked_by`

The task body has a `## Work Log` section. After every dispatch, append one line:
```
- {ISO-8601} · {subagent_type} · {Xm Ys} · {N}K tokens · {outcome note}
```

**Sequence per agent return**:
1. Append the Agent Dispatch Log row (phase, agent, task, outcome). Do **not** try to read tokens/duration — they aren't visible to the orchestrator; the site-view / reporter derive them from the session transcript (see `rules/observability.md`). Scratchpad token/duration cells stay `—`.
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

### Learning notes capture (`run-notes.md`)

Some dispatched agents (the product-owner, solution-architect, ux-consultant, and assessor) surface **durable observations** that aren't part of the feature they're producing — a gap in `platform.md`, a domain rule the user corrected, a recurring clarification, a cross-cutting design-system delta, a recurring cross-repo integration gap class, a convention worth recording. Those used to scroll past in chat and get lost. Now each such agent ends its output with an optional `## Notes for /learn` section.

**After any dispatch whose returned output contains a `## Notes for /learn` section, append that section's bullets to `{run_dir}/run-notes.md`** (create it on first write; one bullet per observation, prefixed with the source agent + phase, e.g. `- [product-owner / Phase 1] …`). Do not act on them mid-run — they are candidate learnings, applied (or discarded) at the end-of-run `/learn` offering in Phase 8.6, which reads this file. This is the write half of continuous learning; the read half is each agent mining `platform.md` § Established Patterns at the start of its run.

---

### Checkpoint event emission

All events go to `{run_dir}/checkpoints.jsonl` in the unified schema defined at `{plugin_dir}/rules/observability.md`. The schema is shared with `/discover`, `/review`, and `/assess` so the reporter can consume every skill the same way.

**Agent dispatches** → emit `agent_start` **immediately before** every `Agent` tool call, then `agent_end` after it returns. This applies to **every** dispatch — the parallel background agents (Phase 5a/5c/5d implementers, Phase 5.5 reviewers) *and* the agents the orchestrator runs inline (Phase 1 product-owner, Phase 2 solution-architect, Phase 3 openapi-spec-editor, Phase 5b ux-consultant). Without the leading `agent_start` the live site-view never shows the agent in its "working" state — it appears only after it has already finished, and its tokens attach only at completion.
- `agent_start`: include `agent_type`, `description`, `phase`, `stage` (and `task` when task-scoped). For per-repo agents the `description` MUST encode the repo (e.g. `Backend implementer — publisher-service`, `Code review — publisher-service`) so the view keys each instance to its repo instead of collapsing them into one "cross-repo" card.
- `agent_end`: emit the **structure** the orchestrator knows — `agent_type` (never bare `agent`), the **same** repo-encoded `description` as the `agent_start` (+ `task` if it carried one) so consumers can match it, `phase`/`stage`, and `status`. Do **not** include token/duration fields — they aren't visible to the orchestrator; the site-view / reporter derive them from the session transcript, matched by `description` (see `rules/observability.md`).

See `rules/observability.md` for the exact shape of both events.

**Retries** → emit `retry` between a failed `agent_end` and the redispatch.

**Phase boundaries** → emit `phase_start` on entry and `phase_end` on exit (with `duration_ms`).

**Slow bash commands** (> 5000 ms) → emit `bash_slow` with `duration_ms` and `cmd_summary` (first 60 chars).

**Approval gates** → no manual emission needed. `scripts/gate.js open`/`close` (which you already call to drive the site-view banner — CRITICAL RULE 5) now also appends `gate_open` / `gate_close` events to `checkpoints.jsonl`, so every gate the run paused at is in the audit trail and the reporter can show gate wait-times.

**Orchestrator overhead tracking** — the orchestrator itself consumes tokens (loading skills, reading files, approval gates, scratchpad updates, and reading agent results): 20-40% of total run cost. **You no longer hand-compute this.** Byte-offset diffing was too error-prone and got skipped (empty `orch_checkpoint`s → overhead showed as 0). Instead:

1. **Record `session_id` on `run_start`** (Pre-flight Step 4) from `$CLAUDE_CODE_SESSION_ID`. That's the only orchestrator responsibility.
2. Overhead is then **derived deterministically** from the session transcript by `scripts/orch-tokens.js` (sum of the session's own `assistant` `message.usage`; sub-agent tokens are in separate transcripts, so nothing to subtract). The site-view and the Phase-7 `reporter` compute it from `session_id` — no offset math, no per-phase `orch_checkpoint` emission required.

```bash
# What consumers run (you don't need to — informational):
node {plugin_dir}/scripts/orch-tokens.js --run-dir={run_dir}   # or --session=$CLAUDE_CODE_SESSION_ID
```

Emitting `orch_checkpoint` events is now **optional/legacy** (consumers still sum any `orch_since_last` deltas as a fallback for runs lacking `session_id`). See `rules/observability.md` → "Orchestrator overhead".
