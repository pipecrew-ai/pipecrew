---
name: learn
description: "Learn from user feedback about a shipped feature — from a merged PR, a recorded /deliver run, a branch diff, or free-form text — and propose scoped updates to the workspace's durable context docs (platform.md, stacks/{type}.md, repo CLAUDE.md / DESIGN_SYSTEM.md / agent-context/). Presents findings tier-classified (repo / workspace / plugin-level) with before/after diffs; user approves per finding; approved changes are applied. Every run is logged to context/learn-log.md for institutional memory."
---

## Description

The learning loop for PipeCrew. Converts one feedback signal → scoped doc updates so the crew gets smarter about this workspace over time.

**Sources accepted**:
- Merged PR (GitHub via `gh` CLI) — reads review comments + post-plugin fix commits to learn from what humans had to correct
- Recorded /deliver run — reads `corrections.md` + the run's outputs to learn from what the user had to push back on during dispatch
- Branch diff — reads a diff between a branch and its base, no PR required
- Free-form text — conversational user feedback from any channel

**Output scopes** (tier classification for every finding):
- **Workspace durable** → updates `{workspace_root}/{slug}/context/stacks/{type}.md` or `platform.md`
- **Repo durable** → updates `{repo}/CLAUDE.md` or `{repo}/agent-context/*` or `DESIGN_SYSTEM.md` (frontend — path resolved via `config.repos[repo].design_system_path`, falling back to standard candidates)
- **Plugin-level** → flagged in the log only (not auto-applied; requires maintainer review)
- **Run-local** → no propagation; already captured in the run's outputs, mentioned but not acted on

**Design system path resolution**: when a finding targets a frontend repo's DESIGN_SYSTEM.md, resolve the path in this order:
1. `config.repos[repo-name].design_system_path` (relative to `repo.path`) — the canonical source.
2. Fallback probe: `agent-context-v2/common/DESIGN_SYSTEM.md`, `agent-context/common/DESIGN_SYSTEM.md`, `agent-context/DESIGN_SYSTEM.md`, `docs/DESIGN_SYSTEM.md`, `DESIGN_SYSTEM.md`.
3. If nothing is found, the finding cannot be auto-applied — log it and point the user at `/discover --resume` to bootstrap the file, then re-run feedback.

## Usage

```
/pipecrew:learn --pr=<url> [--note="..."] [--workspace=<slug>]
/pipecrew:learn --run=<run_id> [--workspace=<slug>]
/pipecrew:learn --branch=<name> [--base=<main>] [--workspace=<slug>]
/pipecrew:learn "<free-form text>" [--workspace=<slug>]
```

### Flags

| Flag | Purpose |
|------|---------|
| `--pr=<url>` | GitHub PR URL. Fetches review comments + commits via `gh`. |
| `--note="..."` | Optional free-form annotation. Works with **any** source mode (`--pr`, `--run`, `--branch`, or as a stand-alone supplement to the positional text). The note is passed to the feedback-learner as an extra signal alongside the structured source — the learner considers it when partitioning observations, but does NOT skip tier-classification or per-finding approval. Useful for "the architect kept picking pattern X but we always do Y" type hints that aren't visible in the run output or PR diff. |
| `--run=<run_id>` | A `/deliver` run directory name under `{workspace_root}/{slug}/runs/feature/`. Reads that run's `corrections.md` + outputs. |
| `--branch=<name>` | Branch name to diff (local). Base defaults to `main` or `dev` — whichever the workspace uses. |
| `--base=<name>` | Override the base branch for `--branch` mode. |
| `--workspace=<slug>` | Which workspace's docs to update. Auto-detects if omitted (scans `{workspace_root}/*/config.json` for repo paths that match the PR / branch). |
| `--dry-run` | Show findings + proposed updates, but skip the apply step. Useful to preview. |
| `--apply-all` | Skip per-finding approval and apply every non-plugin-level finding. Use with care. |

### Examples

```
/pipecrew:learn --pr=https://github.com/Arabookverse-com/abvi-backoffice-service/pull/31
/pipecrew:learn --pr=https://github.com/.../pull/42 --note="we fixed the auth approach, see commit d28808e"
/pipecrew:learn --run=2026-04-16-120338-book-content-upload
/pipecrew:learn --branch=fix/contract-detail-modals --base=main
/pipecrew:learn "the plugin keeps putting details in a separate route, we always want a modal"
```

## Instructions

### CRITICAL RULES

1. **Never silently rewrite workspace / repo docs.** Every proposed change is presented as a before/after diff; the user approves per finding or rejects. `--apply-all` still shows a summary and requires one confirmation.
2. **Never auto-apply plugin-level findings.** The target would be the plugin's own prompts/templates, which are shared across all workspaces. Plugin-level findings are logged with the flag `plugin-level-review-needed` so the maintainer can assess.
3. **Tier classification is the first filter.** Run-local findings are visible in the summary but don't become proposals. Only repo-scope, workspace-scope, and plugin-scope findings become actionable items.
4. **Log every invocation.** Append to `{workspace_root}/{slug}/context/learn-log.md` — even if every finding was rejected. The record matters.
5. **Be explicit about source reliability.** PR review comments from a human reviewer are strong signal. Post-merge fix commits are strong signal (the truth shipped). Free-form user text is strong signal but filtered through the user's recall. Run corrections are moderate signal (may have been one-off decisions).

---

### PIPELINE

```
1. Resolve workspace ──────────── (from --workspace or auto-detect)
2. Collect signal ─────────────── (based on source mode — pr / run / branch / text)
3. Dispatch feedback-learner ──── (agent analyzes signal vs current tier-1 docs)
4. Present findings ──────────── (tier-classified, per-finding approval UX)         <- user gate
5. Apply approved updates ─────── (file edits to the target tier)
6. Write learn-log entry ─────── (durable record in the workspace)
7. Report summary ────────────── (what was applied, what was flagged, one-line status)
```

---

### Step 1: Resolve the workspace

**Step 1.0 — resolve `{workspace_root}`**: run `node {plugin_dir}/scripts/workspace-root.js --get` to capture the user's configured workspaces root (the same resolution `/deliver` and `/discover` use). Use `{workspace_root}` everywhere the steps below reference workspace paths. If the script exits non-zero (root never configured), tell the user to run `/discover` first — feedback has nothing to learn against without an onboarded workspace.

If `--workspace=<slug>` is provided, use `{workspace_root}/{slug}/config.json`. If not:

- For `--pr` / `--branch`: extract the repo path from the PR URL or current working directory. Scan `{workspace_root}/*/config.json` for any workspace whose `repos.*.path` matches. If exactly one matches, use it. If multiple, ask the user.
- For `--run`: the run ID contains the workspace slug inherently — `{workspace_root}/*/runs/feature/{run_id}/` unique match.
- For free-form text: no auto-detection possible. If `--workspace` is omitted, ask.

Validate the resolved config via `node {plugin_dir}/scripts/validate-config.js {config-path}`. Halt on errors.

### Step 2: Collect the signal

Branch on the source mode. Each produces the same output shape: a `signal` bundle containing raw material for the learner.

#### 2a. PR mode (`--pr`)

```bash
# Via gh CLI
gh pr view {pr-number} --repo {org}/{repo} --json title,body,state,merged,mergeCommit,headRefName,files,reviews
gh api repos/{org}/{repo}/pulls/{pr-number}/comments --paginate
gh api repos/{org}/{repo}/pulls/{pr-number}/commits
```

From this, compute:

- **Plugin commits vs human commits**: partition the commits by heuristics in order:
  1. `Co-Authored-By: Claude` trailer in commit message (strongest signal).
  2. Optional `PipeCrew-Run-Id: {run_id}` trailer (if the workspace adopts the trailer — see observability additions).
  3. Timestamp overlap with a `/deliver` run in `{workspace_root}/{slug}/runs/feature/*/checkpoints.jsonl` — commits made within the run's start–end window are presumptively plugin commits.
  4. Ask the user to confirm the partition before proceeding if heuristics are ambiguous.

- **Post-plugin fixes**: the diff between the last plugin commit and the final merged SHA — this is what humans had to add/fix to make the feature ship-worthy. The richest single signal.

- **Review comments**: inline comments with file:line references + the commenter's text. Distinguish `MEMBER` / `CONTRIBUTOR` comments (strong signal) from `NONE` / bot comments (weak).

Bundle all of this into the signal for the learner. Include `--note` verbatim if provided.

#### 2b. Run mode (`--run`)

```bash
run_dir={workspace_root}/{slug}/runs/feature/{run_id}
```

Read:
- `{run_dir}/scratchpad.md` — overview of what ran, which phases, what task files were created.
- `{run_dir}/corrections.md` — the captured user pushbacks during gates (if the run used a version of `/deliver` that wrote this file).
- `{run_dir}/outputs/phase-1-requirements.md`, `phase-2-architecture.md`, `phase-3-diffs.md`, `phase-5-5-code-review.md` — the intermediate run outputs.
- `{run_dir}/assessment.md` — Phase 6 output, if present.
- `{run_dir}/report.md` — Phase 7 summary, if present.
- `{run_dir}/checkpoints.jsonl` — event timeline; useful to cross-reference against any PRs that landed after the run.

Bundle for the learner. If the run also has an associated merged PR (which you can often find by the feature's branch name), offer to also include the PR as a secondary signal source — more data usually helps.

#### 2c. Branch-diff mode (`--branch`)

```bash
base={base or "main"}
cd {repo_path} && git log --oneline {base}..{branch} && git diff {base}...{branch}
```

No PR, no review comments — just the raw diff. Weakest of the structured modes (you can't distinguish "what the plugin did" from "what humans changed" without commit-level markers), but useful for learning from branches that haven't been PR'd yet.

#### 2d. Free-form text mode (positional)

The signal IS the text. No collection step beyond capturing the user's prompt verbatim. The learner reads it alongside the current tier-1 docs and proposes what the text implies.

---

### Step 3: Dispatch the feedback-learner agent

**Tool**: `Agent`
**subagent_type**: `pipecrew:feedback-learner`
**description**: `"Learn from {source-mode} — {identifier}"`

**Prompt**:

```
You are analyzing feedback about the {workspace.name} workspace and proposing
scoped updates to its durable context docs.

## Signal source
Mode: {pr | run | branch | text}
Identifier: {PR URL | run_id | branch name | <first 60 chars of text>}

## The signal

{For PR mode:}
### Review comments ({N} total)
{paste each comment with file:line + author + body}

### Plugin commits ({N})
{paste commit messages + diffs}

### Post-plugin fixes ({N} commits)
{paste commit messages + diffs — these are the rich signal}

{User annotation:}
{--note contents if provided}

{For run mode:}
### Corrections captured during the run
{paste corrections.md}

### Run outputs
{paste phase-1, phase-2, phase-5-5 outputs — the artifacts that show what got produced}

{For branch mode:}
### Branch diff
{paste git log + diff}

{For text mode:}
### User feedback text
{paste verbatim}

## Current workspace durable docs (read and compare)

Read each of these before proposing any update:
- {workspace_root}/{slug}/context/platform.md
- {workspace_root}/{slug}/context/stacks/{type}.md (one per repo.type in the workspace config)
- {for each relevant repo:} {repo.path}/CLAUDE.md
- {for each frontend repo:} {repo.path}/agent-context*/common/DESIGN_SYSTEM.md

## Your job

For every meaningful pattern revealed by the signal, produce one finding.
A "meaningful pattern" is a recurring / structural issue — not a one-off
decision that only applied to this particular feature. Err on the side of
NOT proposing updates for one-off decisions.

Per finding, answer:

1. **Observation** — what did the plugin do / what pattern did it use?
2. **Correction** — what's the right pattern (from the review comment / fix
   commit / user text)?
3. **Evidence** — quote the review comment, the commit diff, or the user text
   that establishes this.
4. **Tier** — exactly one of:
   - `run-local` — one-off, no propagation needed. Flag for visibility only.
   - `repo-durable` — convention specific to one repo. Target: that repo's
     CLAUDE.md, agent-context/, or DESIGN_SYSTEM.md.
   - `workspace-durable` — convention shared across all repos of a type in
     this workspace. Target: platform.md or stacks/{type}.md.
   - `plugin-level` — universal best practice that would apply to any workspace.
     Target: flagged only, no file edit.
5. **Target file + section** — the exact path + §-section the update would
   touch. If tier is `plugin-level`, write "(plugin maintainer review — no
   workspace file)".
6. **Proposed change** — a before/after diff of the target section. Keep it
   small and surgical. If the target section doesn't exist yet, show it as a
   new section addition.

## Output structure

```markdown
# Feedback analysis — {source identifier}

## Summary
- Source: {mode} / {identifier}
- Signal strength: {strong | moderate | weak — justify in one sentence}
- Current docs read: {count}
- Findings produced: {N} ({N} run-local, {N} repo-durable, {N} workspace-durable, {N} plugin-level)

## Finding 1
### Observation
{what did the plugin do}

### Correction
{what it should do}

### Evidence
{quote + reference}

### Tier
{run-local | repo-durable | workspace-durable | plugin-level}

### Target
{file path + §-section, or "plugin-level review"}

### Proposed change
```diff
- {before lines}
+ {after lines}
```

## Finding 2
...
```

## Ground rules

1. **Quote evidence.** Don't paraphrase reviewer comments or user text — quote
   verbatim.
2. **One finding per distinct pattern.** A single review comment that says
   "use @PreAuthorize AND add tests AND use Specification" is THREE findings.
3. **Prefer workspace over repo scope** when in doubt. A pattern documented at
   the workspace level applies to future repos of the same type too.
4. **If the signal is weak or ambiguous, say so.** Mark low-confidence findings
   with "Confidence: low" and explain why. A finding with weak evidence is
   better rejected than forced.
5. **No file edits.** You propose, the orchestrator applies after user
   approval. Do NOT use Write or Edit tools.
6. **No plugin-level edits.** Even if a finding is clearly plugin-level,
   describe what the plugin change would be, but do not produce a file path
   under {plugin_dir}.
```

The learner is read-only (tools: Read, Glob, Grep, Bash). It does not write anything.

---

### Step 4: Present findings + approval UX

Parse the learner's output into a list of findings. Render each one to the user in a compact format:

```
## Feedback findings — {source}

Signal strength: {strong|moderate|weak}
Workspace-durable: {N}   Repo-durable: {N}   Plugin-level (flagged): {N}   Run-local (FYI): {N}

────────────────────────────────────────
[1/N] Finding #1 — {tier} — {target file}

Observation: {one line}
Correction:  {one line}
Evidence:    {one-line quote}
Proposed change: {3-5 line diff preview}

Apply? (y = yes / n = skip / e = edit then apply / v = view full)
────────────────────────────────────────
```

For each finding:

- **y** → queue for apply.
- **n** → skip; record in the log as rejected.
- **e** → let the user supply revised content; queue revised version for apply.
- **v** → show the full finding block and re-prompt.

For `plugin-level` findings, skip the apply prompt — they auto-route to the log with `action: flagged`. Tell the user:

```
[4/N] Finding #4 — plugin-level — (no workspace file edit)

Observation: {...}
Suggested plugin change: {...}

This would affect the plugin's own prompts / templates, which are shared across all
workspaces. Not auto-applied. Logging for maintainer review.
```

For `run-local` findings, do not prompt at all — just list them in the summary as informational context and include them in the log.

Batch mode (`--apply-all`): skip per-finding prompts, show a combined summary + one confirmation. Reject-per-finding is not available in this mode.

Dry-run mode (`--dry-run`): show findings + proposed changes, emit a single "would apply N findings" summary, skip both apply AND log write. Nothing persists.

---

### Step 5: Apply approved updates

For each approved finding:

1. Read the target file.
2. Apply the before/after diff. If the target section exists, edit in place. If it's a new section, append at the appropriate position (section number order).
3. Stamp the file's `Last Updated` field (if present) to today's date.
4. Confirm the edit landed — re-read the file, verify the new content is present.
5. Record in memory: `{finding #, target file, status: applied/failed}`.

**Never use `Write` to replace a whole doc.** Always `Edit` or surgical append — the user may have hand-curated other sections, and the learner's before block may be slightly stale (recent edits you don't know about). If the `Edit`'s `old_string` doesn't match (because the file drifted), flag that finding as `apply-failed` and continue — don't try to force it.

After all applies complete, run a quick sanity check:
- Every frontmatter `Last Updated` on changed files is today.
- No placeholder (`{{...}}`) was introduced.
- The files still parse as markdown (basic structural check — no broken code fences).

### Step 6: Write the learn-log entry

Append to `{workspace_root}/{slug}/context/learn-log.md` (create if missing). Format:

```markdown
## {ISO-date} — {source-mode} {identifier}

**Source**: {mode} ({PR URL / run_id / branch / "text"})
**Signal strength**: {strong|moderate|weak}
**Workspace at time of feedback**: {git rev of workspace config.json, or "n/a"}

### Findings applied
| # | Tier | Target | Summary |
|---|---|---|---|
| 1 | workspace-durable | stacks/spring-boot.md §1 | Auth pattern documented as SecurityConfig + @PreAuthorize |
| 2 | workspace-durable | stacks/spring-boot.md §2 | Query pattern documented as Specification<> |
| 3 | repo-durable | abvi-backoffice-service/CLAUDE.md | Added note: service exposes contract endpoints since PR #31 |

### Findings rejected
| # | Tier | Target | Reason |
|---|---|---|---|
| 4 | workspace-durable | platform.md | User rejected: "this is a one-off" |

### Findings flagged (plugin-level)
| # | Summary |
|---|---|
| 5 | Plugin-level: spring-boot implementer should prefer declarative security on greenfield code |

### Notes
- Invocation args: `--pr=... --note="..."`
- Duration: {mm:ss}
- Learner tokens used: ~{N}k
```

The log is the durable record of how the workspace learned over time. Future `/pipecrew:learn` invocations can cross-reference this log to spot recurring patterns.

If you added a new entry for a finding that's marked **plugin-level**, don't only write it to the feedback log — also print a brief chat message pointing at it:

```
⚠️ Plugin-level finding flagged. See learn-log.md entry for {date}.
   To propose this upstream, open an issue / PR against the pipecrew plugin.
```

### Step 7: Summary

Emit the standard one-line phase-done status:

```
[feedback ✔] {N} applied, {N} rejected, {N} plugin-flagged — {source} ({mm:ss}, {Xk} tokens)
```

If no findings were applied (everything rejected or dry-run), use ⚠:

```
[feedback ✔⚠] 0 applied, 4 rejected, 1 plugin-flagged — PR #31 (2:15, 18k tokens)
  No workspace docs updated. Rejections recorded in learn-log.md.
```

---

### Step 7.5: Finalize — update parent /deliver dispatch log (only when `--run` was supplied)

If `/learn` was invoked with `--run=<deliver-run-id>` (i.e. /learn was dispatched from /deliver Phase 8 Step 8.6), the parent /deliver run's `scratchpad.md` already has a feedback-learner row in its `## Agent Dispatch Log` table with outcome `in_progress` (written by Phase 8 just before the Skill invocation). Update it now so the site-view's `loop` character flips working → done and the pyramid closes.

**Locate the row**: `{workspace_root}/{slug}/runs/deliver/{deliver-run-id}/scratchpad.md`. Find the row whose Agent column is `feedback-learner` and Outcome is `in_progress`.

**Update the row** in place. Preserve the `#`, `Phase`, and `Agent` columns. Set:

- `Duration` = the wallclock duration of this /learn run (mm:ss).
- `Tokens` = total tokens reported by the feedback-learner agent (e.g. `18K`).
- `Outcome` = `success — {N} findings ({A} applied, {R} rejected, {F} plugin-flagged)`.

Use a single `Edit` (not `Write`) — append-only is wrong here, the row is being mutated. The file must keep its existing structure; only this row changes.

If the row is not found (e.g. /learn was invoked manually with `--run` outside the Phase 8 path, so /deliver never wrote the placeholder), skip silently. Do not synthesize a row in that case — the user is running /learn ad-hoc and the /deliver run is already finalized.

If `--run` was not supplied (PR / branch / free-form modes), this step is a no-op.

---

### INTERRUPTION HANDLING

- **User cancels mid-approval** — findings already applied stay applied. Write the log with partial results. Emit a `feedback ✔⚠` line noting "user cancelled at finding #N".
- **Learner agent fails** — report the failure; no log entry beyond "source collected, learner failed". User can re-invoke.
- **`Edit` fails because target file drifted** — mark the finding as `apply-failed` and continue. The user sees this in the final summary and can re-run with a smaller scope.

---

### Observability

Every `/pipecrew:learn` run emits the same event schema as `/deliver` / `/discover` runs (see `{plugin_dir}/docs/observability.md`):

- `run_start` — with `skill: "learn"`, source mode, identifier.
- `agent_end` — after the learner returns, with token usage.
- `phase_end` — one per pipeline step above.
- `run_end` — with applied/rejected/flagged counts.

Run directory: `{workspace_root}/{slug}/runs/learn/{run_id}/` where `{run_id}` = `{YYYY-MM-DD-HHMMSS}-{source-slug}`. `source-slug` = `pr-31`, `run-2026-04-16-xxx`, `branch-fix-foo`, or `text` (truncated first 24 chars of text).

Keep the learner's raw output under `{run_dir}/learner-output.md` for post-hoc debugging. The log entry is the human-facing summary; the raw output is the full reasoning trail.
