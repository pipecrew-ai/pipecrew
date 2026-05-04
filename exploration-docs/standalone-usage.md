# Using PipeCrew components outside the `/deliver` pipeline

**Date**: 2026-04-28
**TL;DR**: 11 of 12 skills are explicitly designed for standalone use; every agent is invocable via the `Agent` tool. The plugin is a library, not just a pipeline.

The plugin was designed so almost every component can run outside `/deliver`. The pipeline is one (big) consumer of these parts, not the only consumer.

---

## Skills — outside-the-pipeline status

| Skill | Standalone? | What you need |
|------|:-:|---|
| `/discover` | ✓ Fully standalone | Bootstrap entry — runs *before* anything else exists. No prereqs. |
| `/review <pr-or-branch>` | ✓ Fully standalone | Explicitly built for "PR review or reviewing code **not** produced by `/deliver`." Works on any repo with a feature branch. |
| `/assess` | ✓ Standalone | "Use for verifying **manually-implemented** features or pre-merge validation." Needs feature branches that touched 2+ repos in a workspace. |
| `/learn` | ✓ Fully standalone | Takes a merged PR URL, a `/deliver` run id, a branch diff, or free-form text. None require the pipeline to have just run. |
| `/context-refresh` | ✓ Fully standalone | Audits or refreshes docs at three scopes (single repo / workspace / everything). Independent of `/deliver`. |
| `/troubleshoot "<symptom>"` | ✓ Fully standalone | Cross-repo incident triage with read-only enforcement. Takes a one-line symptom. No pipeline state needed. |
| `/scaffold` | ✓ Fully standalone | Two modes (`--from-scratch` or `--from-example`). Greenfield repo creation. Can also be called by `/discover --greenfield` but works independently. |
| `/simulate-run` | ✓ Fully standalone | Generates a demo workspace + spawns site-view. Zero agent cost. |
| `/site-view` | ✓ Fully standalone | Browser UI. Can run pointed at any workspace's run directory, including historical runs. |
| `/siteview-list`, `/siteview-cleanup` | ✓ Fully standalone | Pure ops utilities for managing running site-views. |
| `/deliver` | ✗ Pipeline-only | This IS the pipeline. Everything else is upstream-or-downstream of it. |

**Net**: 11 of 12 skills are designed to be invoked outside the pipeline. `/deliver` is the orchestrator that ties everything together; the rest are independently useful.

---

## Agents — outside-the-pipeline status

You can invoke any of these with the `Agent` tool from anywhere — `subagent_type: pipecrew:<agent-name>` — but they have varying levels of input expectations.

### Fully standalone (work cleanly with explicit inputs)

| Agent | Useful for |
|-------|-----------|
| `solution-architect` | Designing technical solutions. Inputs: workspace slug, requirements file or feature description. |
| `security-consultant` | Two modes: design review (reads tech design pre-implementation) or code review (reads diffs). |
| `ux-consultant` | Pre-implementation UX recommendations against any frontend repo's design system. |
| `product-brainstormer` | Greenfield brainstorming — interactive discovery before any repos exist. Pre-pipeline by design. |
| `reporter` | Reads any run dir + checkpoints + scratchpad and produces an execution report. Doesn't care if the run was complete, partial, or never finished. |
| `*-code-reviewer` (4) | Read-only diff review. Inputs: repo path, requirements list, endpoints implemented, spec files. Same call pattern `/review` uses internally. |

### Standalone-capable but with implicit prereqs

| Agent | Prereq the pipeline normally satisfies |
|-------|---------------------------------------|
| 12 implementers (`spring-boot-api-implementer`, `react-feature-implementer`, etc.) | Expect a **task file** at `~/.claude/dal-pipeline/tasks/{task-id}.md` per the canonical dispatch template. You'd hand-write one to use them solo. |
| `openapi-spec-editor` | Expects an `affected_services` list + `api_design` block from the architect's output. You'd construct these manually. |
| `schema-implementer` | Expects `affected_contracts` + `contract_design`. Same — hand-construct. |
| `mock-endpoint-implementer` | Expects spec files + endpoint list + seed-data hints. Easy to provide. |
| `feedback-learner` | Used internally by `/learn`. Direct invocation works; same shape as the slash command. |
| `context-manager` | Used internally by `/context-refresh` and Phase 7. Direct invocation works in five modes (`full`, `claude-only`, `init`, `refresh`, `audit`). |

### Workspace-published agents (require a workspace)

| Agent | What it needs |
|-------|--------------|
| `{slug}-product-owner` | Published by `/discover` to `~/.claude/agents/`. Needs the workspace slug to exist. |
| `{slug}-ux-consultant` | Same — workspace-specific UX consultant published by `/discover`. |
| `{slug}-assessor` | Same — workspace-specific cross-repo assessor. |

These are **per-workspace customizations** of the generic plugin agents. They carry domain-specific instructions discovered during onboarding. You can use the **plugin-shipped fallbacks** (`pipecrew:product-brainstormer`, `pipecrew:ux-consultant`) without a workspace.

---

## Concrete patterns — "I want to do X without `/deliver`"

### "Just review this PR/branch"
```
/review <pr-url>
# or
/review --repo /path/to/repo --base main
```
The `/review` skill dispatches the right reviewer agent based on the repo's `type` and produces a structured report. Same reviewer that runs in Phase 5.5 of `/deliver`.

### "Just check cross-repo wiring"
```
/assess
```
Runs the Phase 6 assessor logic standalone. Useful before merging a feature branch that was implemented manually.

### "Just figure out what's wrong"
```
/troubleshoot "users see 401 after refresh"
```
Read-only investigation across the workspace's logs and recent diffs. Independent of any feature work.

### "Just refresh docs that have drifted"
```
/context-refresh --workspace mybiz       # workspace + every repo
/context-refresh --repo /path/to/repo    # single repo
/context-refresh --audit                 # report only, no writes
```

### "Just learn from a PR I already shipped"
```
/learn <pr-url>
# or
/learn --run <run-id>
# or
/learn --text "feedback I want to capture"
```
Updates the durable context docs without touching the pipeline.

### "Just dispatch an architect for one design question"
You can do this from any Claude Code session:
```
Use the pipecrew:solution-architect agent to design a notification queue
for {workspace-slug}. Read {workspace_root}/{workspace-slug}/config.json
and {workspace_root}/{workspace-slug}/context/platform.md first.
```
The agent self-loads workspace context and produces a technical design without `/deliver` orchestrating.

### "Just run an implementer on one task"
Slightly more setup — you'd write a minimal task file:
```yaml
---
id: my-task
phase: manual
repo: my-repo
status: todo
---

# Add user export endpoint
{feature summary, FR/EC list, sub-tasks, ...}
```
Then dispatch:
```
Use the pipecrew:react-feature-implementer agent. Task file:
~/.claude/dal-pipeline/tasks/my-task.md. Worktree: /path/to/worktree.
```

This is rarely worth doing manually — `/deliver` exists precisely because the input setup is tedious. But it's possible.

---

## Common gotchas if you go standalone

1. **Implementers expect their task file to exist.** R0 (HARD RULE in `docs/implementer-common-rules.md`) is "task file is your source of truth." Without one, they'll error out or produce thin output.

2. **`{plugin_dir}` references inside agent prompts** assume the plugin is installed. If you copy-paste an agent prompt elsewhere, you'd need to substitute paths. Inside Claude Code with the plugin installed, this resolves automatically.

3. **Workspace agents are slug-specific.** Outside the workspace they were published for, fall back to the generic `pipecrew:product-brainstormer` / `pipecrew:ux-consultant` versions.

4. **Reviewers in haiku mode + `effort: high`** (per the recent change) — they're fast and cheap, but if you call them for a particularly subtle review (dense type-system drift, distributed-systems edge cases), consider overriding to sonnet at invocation time.

5. **The eval harness, troubleshooter bash-guard, simulate-run** all expect to find files relative to the plugin install path. They work standalone but assume the plugin layout.

6. **Site-view auto-starts only with `/deliver`** — if you want to watch a `/review` or `/troubleshoot` run, start it manually with `/site-view`.

---

## TL;DR

- **Skills**: 11 of 12 are explicitly designed for standalone use. Only `/deliver` is the pipeline.
- **Agents**: every one is invocable via the `Agent` tool. The implementers and contract editors expect inputs the pipeline normally constructs, so they're easier to use *through* `/deliver` than alone — but it's possible.
- **The plugin's value-add is not just `/deliver`.** It's a library of typed agents + spec-aware skills + observability tooling that you can compose any way you want.

Practical heuristic: **if you have a workspace already onboarded (`/discover` has run), every other skill works standalone.** If you don't, run `/discover` first and the rest light up.

---

## Cross-references

- [`pipecrew-vs-agent-teams.md`](./pipecrew-vs-agent-teams.md) — comparison with Claude Code's experimental Agent Teams feature
- [`context-engineering.md`](./context-engineering.md) — design principles for the agents and dispatches
- [`README.md`](./README.md) — the plugin's primary entry point
- [`docs/implementer-common-rules.md`](./docs/implementer-common-rules.md) — R0–R9 that implementers follow regardless of caller
- [`docs/file-formats.md`](./docs/file-formats.md) — structured-block schemas the agents emit/consume
