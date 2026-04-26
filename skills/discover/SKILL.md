---
name: discover
description: "Discover a new project for the PipeCrew. Inspects repos, interrogates the domain, generates workspace config + platform.md + CLAUDE.md files + domain-specific agents. Run once per project, then use /deliver to ship features."
---

## Description

One-time workspace initialization. Scans parent directories for repos, detects tech stacks, asks domain questions, generates all workspace-layer files that the `/deliver` pipeline needs.

After `/discover` completes, you have:
- `{workspace_root}/{slug}/config.json` — workspace config
- `{workspace_root}/{slug}/context/platform.md` — domain architecture context
- `{workspace_root}/{slug}/agents/` — domain-specific agents (product-owner, assessor, ux-consultant)
- `CLAUDE.md` in each repo (generated or pre-existing)
- Optional `agent-context/` in repos where complexity warrants it

## Usage
```
/discover [parent_dir] [parent_dir2] ...
/discover --resume [--workspace=<slug>]
```

### Arguments
- `parent_dir`: one or more directories containing repos to discover (default: current working directory)

### Flags
| Flag | Effect |
|------|--------|
| `--resume` | Resume an interrupted onboarding from the scratchpad |
| `--workspace=<slug>` | Required with `--resume` and `--refresh-stacks` if multiple workspaces exist |
| `--greenfield` | Skip repo scan, start with brainstorm + scaffold (see Phase Greenfield) |
| `--skip-divergences` | Phase B2.5 still produces `stacks/{type}.md`, but skips the platform.md divergence write. Useful for fast iteration or when divergences are hand-curated. |
| `--refresh-stacks` | Run only Phase B2.5 against an existing workspace — refreshes both `stacks/{type}.md` docs and the platform.md divergence subsection from a fresh code scan. Combine with `--skip-divergences` to refresh stacks only. Requires `--workspace=<slug>` if more than one workspace exists. Skips Phase A/B1/B2/B3/C/D. |

### Examples
```
/discover C:/ABVI
/discover /home/dev/projects/my-saas /home/dev/projects/my-saas-infra
/discover --resume
/discover --resume --workspace=my-saas
/discover --refresh-stacks --workspace=my-saas
/discover --refresh-stacks --workspace=my-saas --skip-divergences
```

## Instructions

### CRITICAL RULES

1. **Never overwrite existing CLAUDE.md files** without asking. If a repo already has one, read it and skip generation. The user may have hand-curated it.
2. **Never overwrite an existing workspace config** without asking. If `{workspace_root}/{slug}/config.json` exists, warn and offer to update or abort.
3. **CLAUDE.md is required for every repo** that will participate in the pipeline. Agents read it first. No exceptions.
4. **Agent-context is optional.** Recommend it for complex repos. Skip for simple ones.
5. **Domain agents are templates.** The plugin ships template files; `/discover` fills in placeholders and writes finished agents to the workspace's `agents/` directory.
6. **The solution-architect does the heavy lifting in Phase B2.** It reads actual code, not just filenames. This produces a high-quality platform.md that all coordinating agents rely on.
7. **Track progress in a scratchpad.** Onboarding has 6 phases — any of them can fail (context limit, network error, user interruption). The scratchpad at `{workspace_root}/{slug}/runs/discover/{run_id}/scratchpad.md` tracks which phases completed and stores intermediate results so `/discover --resume` can pick up where it left off.
8. **Update the scratchpad after every phase completes** — before starting the next phase. Write the phase status AND any outputs produced (discovered repos, domain answers, etc.).
9. **Emit a one-line phase-done status in chat** — immediately after updating the scratchpad at the end of each phase, print exactly one line to the user in the format:

    ```
    [phase {CODE} ✔] {what-was-produced} ({metrics})
    ```

    Examples:
    - `[phase A ✔] 7 repos discovered, 3 api-services, 1 frontend (0:42)`
    - `[phase B2 ✔] platform.md generated — 11 entities, 7 patterns (4:03, 78k tokens)`
    - `[phase B2.5 ✔] 2 repos diverged from baseline (0:58, 41k tokens)`
    - `[phase C ✔] 2 CLAUDE.md + 2 agent-context generated, 3 domain agents written (6:12, 186k tokens)`

    This gives users a consistent, greppable progress signal without forcing them to open the scratchpad. Keep it to one line per phase — no trailing commentary. After the line, proceed to the next phase without waiting for acknowledgement.

    If a phase ends in partial failure (one agent failed after retry), the line gains a `⚠` suffix and one extra line listing what was deferred:
    ```
    [phase C ✔⚠] 1 CLAUDE.md generated, 1 deferred, 2 agent-context generated (6:45, 165k tokens)
      Deferred: publisher-service (529 after retry) — re-run /discover --resume
    ```

### OBSERVABILITY — unified run directory + event schema

**Authoritative spec**: `{plugin_dir}/docs/observability.md`. The event schema, enum values, and field semantics below are a summary — on any conflict, the observability doc wins.

**Run directory** — every onboarding run gets its own dir under the workspace:

```
{workspace_root}/{slug}/runs/discover/{run_id}/
├── scratchpad.md          human-readable phase state (used by --resume)
├── checkpoints.jsonl      machine event log (this section)
├── outputs/               phase artifacts (platform-draft.md, divergences.md, etc.)
└── report.md              final Phase D summary
```

**`run_id`** format: `{YYYY-MM-DD-HHMMSS}-{workspace-slug}`. Compute at the very start of the run, before any file write. If the resulting directory already exists (same-second collision), append `-2`, `-3`, ….

Stable workspace-level outputs (`config.json`, `context/platform.md`, `agents/`, `agent-memory/`) stay at workspace root — they're the enduring product of onboarding, not per-run artifacts.

**Event emission** — every event is one JSON object on its own line in `checkpoints.jsonl`. Append-only. Emit with `Write` (read + append) or shell `echo >> …`.

**Common fields** (every event): `ts` (ISO8601 UTC), `event`, `skill: "discover"`, `run_id`. Phase-scoped events also include `phase` and `stage`.

**Event types** — /discover emits the following (full schema in `docs/observability.md`):

| Event | When | Notable extras |
|---|---|---|
| `run_start` | First event, before Phase A | `workspace_slug`, `args` |
| `run_end` | Last event, after Phase D | `status`, `duration_ms` |
| `phase_start` | Entering any phase | `phase`, `stage` |
| `phase_end` | Phase complete, scratchpad updated | `phase`, `stage`, `duration_ms` |
| `agent_end` | Every `Agent` tool call returns | `agent_type`, `description`, token fields, `status`, optional `audit_findings_count` |
| `orch_checkpoint` | Optional — emit at phase boundaries to capture orchestrator-overhead delta | `jsonl_offset`, `orch_since_last.{input,output,cache_read}_tokens` |
| `bash_slow` | Bash call > 5000 ms | `duration_ms`, `cmd_summary` (first 60 chars) |
| `retry` | Between a failed `agent_end` and its retry | `agent_type`, `description`, `retry_reason` |

Fields not in the source data → omit the key. Do not fabricate zero values.

**Parsing the `<usage>` block from Agent tool results:**

Every Agent tool response ends with a footer like:

```
agentId: a692490f10491aee9 (use SendMessage with to: 'a692490f10491aee9' to continue this agent)
<usage>total_tokens: 77922
tool_uses: 28
duration_ms: 242835</usage>
```

Parse with `/<usage>([\s\S]*?)<\/usage>/`, split the body by newlines, parse each `key: value` pair, coerce numeric values to integers. Copy the keys into the `agent_end` event (normalize to snake_case). Newer Claude Code versions also include `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.

If `<usage>` is absent (tool error before usage was reported), emit `agent_end` with `status: "failed"` and no token fields.

**Retry interaction**:
1. Emit `agent_end` with `status: "failed"` and whatever usage was returned (often none).
2. Emit `retry` with `retry_reason` (e.g., `"529 overloaded"`).
3. Wait per the Phase C rules (30 s / 60 s / `retry-after`).
4. Re-dispatch. Emit a fresh `agent_end` with `status: "ok"` on success, `status: "deferred"` if the retry also failed.

**Validation**: run `node {plugin_dir}/scripts/validate-checkpoints.js {run_dir}/checkpoints.jsonl` at the end of Phase D. Exit code 1 = schema violation (fix before archival). Exit code 2 = soft warning (record and continue).

**Phase D Step 7** reads this JSONL to produce the execution summary — see `phases/phase-d-verification.md`.

**Scratchpad vs checkpoints — two different files, two different jobs**:
- `scratchpad.md` — human-readable run state, used for `--resume`.
- `checkpoints.jsonl` — machine-readable event log, used for the summary, trending, and debugging failed runs.

Both are kept; neither replaces the other.

---

### SCRATCHPAD

**Created at the very start of onboarding** (before Phase A, after asking the workspace name AND after computing `run_id`). Lives at `{workspace_root}/{slug}/runs/discover/{run_id}/scratchpad.md`.

**Before writing the scratchpad**, the orchestrator MUST:
1. Compute `run_id` = `{YYYY-MM-DD-HHMMSS}-{slug}` from current UTC time. If `runs/discover/{run_id}/` already exists, append `-2`, `-3`, etc.
2. Create the directory: `mkdir -p {workspace_root}/{slug}/runs/discover/{run_id}/outputs`
3. Emit the first `run_start` event to `checkpoints.jsonl` in that dir.
4. Then write the scratchpad below.

```markdown
# Onboarding Scratchpad

## Run Info
- **Skill**: discover
- **Run ID**: {run_id}
- **Workspace**: {name} ({slug})
- **Parent dirs**: {parent_dir list}
- **Flags**: {flags used}
- **Started**: {date}
- **Current Phase**: {phase name}
- **Status**: IN_PROGRESS | INTERRUPTED | COMPLETED | FAILED

## Phase Status
| Phase | Status | Notes |
|-------|--------|-------|
| Greenfield | SKIPPED | (runs only if --greenfield or zero repos found) |
| A. Repo Discovery | PENDING | |
| B1. Domain Questions | PENDING | |
| B2. Architect Discovery | PENDING | |
| B2.5. Stack Discovery + Divergence | PENDING | |
| B3. Design System | PENDING | |
| C. Generation | PENDING | |
| D. Verification | PENDING | |

## Discovered Repos (filled by Phase A)
| # | Repo | Path | Type | Role | Spec | CLAUDE.md | Agent-Context |
|---|------|------|------|------|------|-----------|---------------|

## Domain Answers (filled by Phase B1)
- **Project name**: 
- **Domain sentence**: 
- **User roles**: 
- **Languages + RTL**: 

## Generation Status (filled by Phase C)
| Item | Status |
|------|--------|
| Workspace config | PENDING |
| Platform context | PENDING |
| Domain agents | PENDING |
| CLAUDE.md per repo | (per-repo rows added dynamically) |
| Agent-context per repo | (per-repo rows added dynamically) |
```

### RESUME FLOW (`--resume`)

Apply the shared resume rules at `{plugin_dir}/docs/interruption-and-resume.md` — how to find interrupted runs, pick a target, confirm with the user, and re-enter without creating a new run dir.

`/discover`-specific state to restore from scratchpad: the `## Discovered Repos` table (Phase A output) and the `## Domain Answers` block (Phase B1 output). Both must already be populated before Phase C can resume cleanly.

### PRE-PHASE 0: Workspace name + usage gate

**Step 0.0: Resolve the workspace root directory.**

Before creating any workspace dir, make sure the user's preferred root is known. Run `node {plugin_dir}/scripts/workspace-root.js --check`:
- Exit 0 — already configured (or `$PIPECREW_WORKSPACE_ROOT` is set). Skip to 0.1.
- Exit 2 — never configured. Ask the user once:

  ```
  Where should PipeCrew store workspaces?
  Default: ~/.claude/pipecrew/workspaces
  (Press Enter to accept the default, or paste an absolute/~-prefixed path.)
  ```

  Then persist the answer (or the default) with `node {plugin_dir}/scripts/workspace-root.js --set="<path>"`. This writes `~/.claude/pipecrew/config.json` so `/deliver` and future `/discover` runs reuse the same root without re-prompting.

After this step, capture `{workspace_root} = $(node {plugin_dir}/scripts/workspace-root.js --get)` and use it everywhere the remaining steps show the literal `~/.claude/pipecrew/workspaces/` path.

**Step 0.1: Ask workspace name.**

Before Phase A, the orchestrator must know the workspace name to create the scratchpad directory. Ask:

```
What's the project/platform name?
(e.g., "Digital Arabic Library", "Acme SaaS", "HealthTrack")
```

From the answer, derive the slug (kebab-case, ≤20 chars) and compute `run_id` = `{YYYY-MM-DD-HHMMSS}-{slug}`.

**Step 0.2: Pre-flight usage gate** (same gate `/deliver` runs before Phase 1).

Read `~/.claude/stats-cache.json`. Find today's date in `dailyModelTokens`. Sum tokens per model. Compare against the observed daily ceiling (max daily value for each model in the history).

If any model exceeds **80%** of its observed ceiling:

```
⚠️ Today's {model} usage is at {N}% of your observed daily budget.
A full onboarding typically consumes {estimate} Opus tokens
(architect discovery + stack discovery + design system + docs generation).
You may hit rate limits mid-run.

Continue anyway? (yes / no)
```

Behavior: **warn and continue.** Do not hard-block. The user decides. If `stats-cache.json` doesn't exist or has no data for today, skip the gate silently.

**Step 0.3: Create the run directory.**

```bash
mkdir -p {workspace_root}/{slug}/runs/discover/{run_id}/outputs
```

If `runs/discover/{run_id}/` already exists (same-second collision), append `-2`, `-3`, … to `{run_id}` until unique.

Emit the first `run_start` event to `{run_dir}/checkpoints.jsonl` (see `docs/observability.md`). Then write the initial scratchpad from the template below. Then proceed to Phase A.

### PIPELINE

```
Phase Greenfield: Brainstorm + Scaffold ─ (only if --greenfield OR zero repos found)
Phase A:  Repo Discovery ─────── scan dirs, detect tech stacks, confirm with user
Phase B:  Domain Questions ────── 4 questions to the user
Phase B2: Architect Discovery ─── solution-architect reads code, generates platform.md (MODE: discovery)
Phase B2.5: Stack Discovery ───── per-stack scan; produces stacks/{type}.md + per-repo divergences in platform.md
Phase B3: Design System ────────── (only if frontend) discover components, tokens, patterns
Phase C:  Generation ──────────── config + CLAUDE.md + platform.md + agents + agent-context
Phase D:  Verification ────────── validate paths, check git status, summary
```

### PHASE FILES

Each phase lives in its own file. Load only the active phase.

| Phase | File |
|-------|------|
| Greenfield (brainstorm + scaffold) | `phases/phase-greenfield-brainstorm.md` |
| A. Repo Discovery | `phases/phase-a-repo-discovery.md` |
| B. Domain Questions + Architect + Design System Discovery | `phases/phase-b-domain-and-architect.md` |
| B2.5. Stack Discovery + Divergence | `phases/phase-b25-stack-discovery.md` |
| C. Generation | `phases/phase-c-generation.md` |
| D. Verification | `phases/phase-d-verification.md` |

**When entering a phase**: Read the phase file and follow its instructions.
