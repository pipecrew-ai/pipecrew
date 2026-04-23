# Interruption handling + resume semantics

Shared rules for what happens when a skill run is interrupted, and how `--resume` picks up where it left off. Every skill in the plugin uses these rules.

## Interruption commands (user-initiated)

During any skill run, the user can interrupt with one of:

| Command | Effect |
|---|---|
| `skip` | Mark the current phase `SKIPPED` in the scratchpad; emit `phase_end` with a `skipped` note; move to the next phase. |
| `stop` | Update the scratchpad top-level status to `INTERRUPTED`; emit `run_end` with `status: "aborted"` and `duration_ms` since `run_start`; print a one-line resume hint. Do not continue to the next phase. |
| `restart from phase X` | Update the scratchpad's `## Phase Status` to set the current phase to X; re-enter X fresh (prior outputs for X are archived to `outputs/phase-X.v{N}.md` before being overwritten). |

Don't add skill-specific interruption verbs without a good reason — consistency across skills matters more than the occasional convenience verb.

## Automatic interruption (environment-initiated)

| Event | Effect |
|---|---|
| Parallel phase agent fails after retry | Mark that agent's task `FAILED` in the scratchpad; continue other agents in the same parallel batch; at batch end, ask the user whether to proceed to the next phase or resume later. |
| Context window limit hit mid-phase | Scratchpad persists (it's on disk); emit `run_end` with `status: "aborted"` and `duration_ms`; user resumes in a new session. |
| Non-retryable Agent error (non-429 4xx) | Same as manual `stop`. |
| User closes terminal / kills process | No cleanup runs. Next invocation of `--resume` finds `Status: IN_PROGRESS` in the scratchpad and offers to continue; the last `run_end` event is missing, which the reporter uses to flag the prior run as "aborted — never emitted run_end". |

## `--resume` semantics

Applies identically to `/discover --resume` and `/deliver --resume` (and any future skill with a resume flag).

### Step 1: Find interrupted runs

Scan `~/.claude/workspaces/*/runs/{skill}/*/scratchpad.md` for files with `Status: IN_PROGRESS` or `Status: INTERRUPTED`.

If `--workspace=<slug>` is set, restrict to that workspace. If the skill has its own run-id flag (e.g., `/deliver --feature=<slug>`), use it to disambiguate further.

### Step 2: Pick the target run

- Zero found → `"No interrupted {skill} run found."` and exit.
- One found → use it.
- Multiple found → list them (`run_id`, started-at, current phase, last activity) and ask the user to pick.

### Step 3: Confirm

```
Resuming {skill}: {workspace-slug}
Run:             {run_id}
Current phase:   {phase}
Started:         {timestamp}
Last activity:   {last event ts from checkpoints.jsonl}

Completed: {list of COMPLETED phases}
Resuming from: {current phase}

Continue?
```

### Step 4: Re-enter

- **Do NOT create a new `run_id` or new run directory.** Resume writes to the existing `runs/{skill}/{run_id}/`.
- Append to the existing `checkpoints.jsonl` — do not truncate. The reporter derives resume boundaries by spotting gaps in `ts` values > 1 hour (see `docs/observability.md`).
- Do NOT re-run completed phases. Start from the current phase as listed in scratchpad.
- If the current phase has partial artifacts under `outputs/` (e.g., half-written `phase-2-architecture.md`), back them up to `outputs/phase-2.v{N}.md` before re-entering the phase and rewriting them.

### Step 5: Restore skill-specific state

Each skill loads its own state from the scratchpad:
- `/discover` reads the Discovered Repos table + Domain Answers.
- `/deliver` reads the Phase Status table + Implementation Tasks + Agent Dispatch Log.

The shared mechanism is: **scratchpad is the recovery unit**. Anything the skill needs to resume must be persisted there before the phase that needs it runs.

## What cannot be resumed

- **Partially-generated files in a target repo** (e.g., a backend implementer wrote half a controller before context ran out). The worktree is on the user's machine; the next resume starts that phase fresh and may produce slightly different code. Phase-level idempotency is the responsibility of each implementer agent.
- **Approval decisions already given**. If a prior run approved Phase 3 spec edits and then died, the resumed run still has those edits on disk (the orchestrator already committed them). But a prior run that REJECTED won't have the agents re-ask — state says that phase is DONE with REJECTED, and resume goes to the next phase, which may have its own approval gate.

## Event emission on interruption

Always emit one of the following in `checkpoints.jsonl` before the run ends:

| Situation | Event |
|---|---|
| User `stop` | `run_end` with `status: "aborted"`, `duration_ms` |
| User `skip` + continue | `phase_end` for skipped phase, then proceed |
| User `restart from X` | No `run_end`; emit `phase_start` for X (the reporter sees two `phase_start` events for X and interprets the second as a restart) |
| Context limit | `run_end` with `status: "aborted"` — attempt it; if context is fully exhausted the event may be lost, and the resume will detect "no `run_end` seen" (see observability) |
| Parallel fail after retry → user chooses to stop | `run_end` with `status: "aborted"` |
| Parallel fail after retry → user chooses to proceed without the deferred agent | Continue; the deferred agent's prior `agent_end` with `status: "deferred"` is the only record |

## Approval-prompt wording (shared vocabulary)

Every user-facing approval across every skill uses one of three canonical templates. Don't invent new phrasings.

### Template A — simple approval

Use when the skill needs a go/no-go on a produced artifact (requirements doc, architecture doc, diff summary):

```
Approve? (yes / no / edit)
```

- `yes` — continue to the next phase.
- `no` — abort the run (emit `run_end` with `status: "aborted"`).
- `edit` — pass the user's edits back to the producing agent and re-run the current phase.

### Template B — warn-and-continue gate

Use when something is unusual but not blocking — budget pressure, heterogeneous workspace, risky change:

```
⚠️ {what's unusual, one sentence}.
{What happens if the user continues, one sentence}.
Continue anyway? (yes / no)
```

- `yes` — proceed.
- `no` — abort the run (same as Template A `no`).

### Template C — skip-or-continue

Use when skipping an action is a meaningful choice (e.g., optional sub-step):

```
{What's being offered, one sentence}
(yes / skip)
```

- `yes` — do it.
- `skip` — don't do it, continue to the next step.

Never abort on `skip` — use Template A if the user might want to bail entirely.

### Don't use

- ❌ `Proceed?` alone (no yes/no guidance)
- ❌ `(y/n)` (abbreviated — keep prompts greppable)
- ❌ `Continue?` alone — always suffix with the valid answers
- ❌ Custom verbs like `accept` / `reject` / `merge` — stick to `yes`, `no`, `edit`, `skip`

## Scratchpad `Status` values (shared vocabulary)

Both skills use the same top-level `Status` field in scratchpad.md:

| Value | Meaning |
|---|---|
| `IN_PROGRESS` | Run is live. Resume picks these up. |
| `INTERRUPTED` | User typed `stop` or context limit hit. Resume picks these up too — same mechanics. |
| `COMPLETED` | Phase D (or equivalent) ran cleanly. Resume should skip these with "already complete". |
| `FAILED` | Something hard-failed (non-transient). Resume offers to restart from the failed phase. |

Do NOT invent skill-specific status values. If you need to capture more detail, add phase-level status in the `## Phase Status` table — don't overload the top-level Status field.
