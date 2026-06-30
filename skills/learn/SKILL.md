---
name: learn
description: "Learn from user feedback — from a merged PR, a recorded /deliver run, a branch diff, a Claude Code session transcript, or free-form text — and propose scoped updates to the workspace's durable context docs (platform.md § Established Patterns, repo CLAUDE.md / DESIGN_SYSTEM.md / agent-context/). Presents findings tier-classified (repo / workspace / plugin-level) with before/after diffs; user approves per finding; approved changes are applied. After the docs are saved the user can optionally dispatch the per-repo implementer agents to apply the same findings to an existing branch as a fix round (so the branch the feedback came from gets brought in line with the new conventions, not just future work). Every run is logged to history/learn-log.md for institutional memory."
---

## Description

The learning loop for PipeCrew. Converts one feedback signal → scoped doc updates so the crew gets smarter about this workspace over time.

**Sources accepted**:
- Merged PR (GitHub via `gh` CLI) — reads review comments + post-plugin fix commits to learn from what humans had to correct
- Recorded /deliver run — reads `corrections.md` + the run's outputs to learn from what the user had to push back on during dispatch
- Branch diff — reads a diff between a branch and its base, no PR required
- **Claude Code session** — a conversation transcript (a `.jsonl` under `~/.claude/projects/.../{sessionId}.jsonl`, or the live session via `--session=current`). Learns from what the user steered, corrected, or repeated across a working session. **No prior /deliver run required** — point it at any session and it reasons about whether anything is worth persisting.
- Free-form text — conversational user feedback from any channel

> **Session / free-form text are the weakest signal class** — they are *exploratory* (most of a session is normal work, not a reusable rule). `/learn` biases hard toward "no update" for these: it lists what it noticed and recommends a context change **only** when a structural, repeatable convention is revealed. A clear "no change recommended, here's why" is a first-class, successful outcome — not a failed run.

**Output scopes** (tier classification for every finding):
- **Workspace durable** → updates `{workspace_root}/{slug}/context/platform.md` (typically the `Established Patterns` section)
  - **Exception — recurring cross-repo integration gap *classes*** (surfaced by the assessor via its `## Notes for /learn`, e.g. "role-gated backend endpoints repeatedly ship without the matching frontend route guard") go to the dedicated sidecar `{workspace_root}/{slug}/context/cross-repo-checklist.md`, **not** `platform.md`. Only the Phase 6 assessor loads that sidecar, so keeping these out of `platform.md` keeps the always-loaded doc lean. **Dedupe** against existing entries (merge a near-duplicate, don't add a second) and **cap** the file at ~150 lines — if it would exceed that, drop the least-recurring entry. It is a tight checklist of gap *classes*, not an append-only log; create it on the first such finding.
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
/pipecrew:learn --session=<path|id|current> [--note="..."] --workspace=<slug>
/pipecrew:learn "<free-form text>" [--workspace=<slug>]

# Optional fix-round flags (combine with any source mode above):
/pipecrew:learn ... --fix-branch=<name>     # target a specific branch when dispatching the fix round
/pipecrew:learn ... --auto-fix              # skip the post-apply prompt — always dispatch implementers
/pipecrew:learn ... --no-fix                # skip the post-apply prompt — never dispatch implementers
```

### Flags

| Flag | Purpose |
|------|---------|
| `--pr=<url>` | GitHub PR URL. Fetches review comments + commits via `gh`. |
| `--note="..."` | Optional free-form annotation. Works with **any** source mode (`--pr`, `--run`, `--branch`, or as a stand-alone supplement to the positional text). The note is passed to the feedback-learner as an extra signal alongside the structured source — the learner considers it when partitioning observations, but does NOT skip tier-classification or per-finding approval. Useful for "the architect kept picking pattern X but we always do Y" type hints that aren't visible in the run output or PR diff. |
| `--run=<run_id>` | A `/deliver` run directory name under `{workspace_root}/{slug}/runs/feature/`. Reads that run's `corrections.md` + outputs. |
| `--branch=<name>` | Branch name to diff (local). Base defaults to `main` or `dev` — whichever the workspace uses. |
| `--base=<name>` | Override the base branch for `--branch` mode. |
| `--session=<path\|id\|current>` | Learn from a Claude Code session. `current` = the live conversation (the orchestrator distills its salient feedback turns); a `.jsonl` path or a bare session id = a past transcript (collected via `collect-session-feedback.js`). Weakest signal class — see the source-reliability note. Composes with `--note` (that **is** the "free text + session" combination — no separate flag needed). Requires `--workspace` (no repo to auto-detect from). |
| `--workspace=<slug>` | Which workspace's docs to update. Auto-detects if omitted (scans `{workspace_root}/*/config.json` for repo paths that match the PR / branch). |
| `--dry-run` | Show findings + proposed updates, but skip the apply step. Implies `--no-fix` (a dry run never dispatches implementers). |
| `--apply-all` | Skip per-finding approval and apply every non-plugin-level finding. Does NOT imply `--auto-fix` — the fix-round prompt still runs after applies unless `--auto-fix` / `--no-fix` is also passed. |
| `--fix-branch=<name>` | Optional branch name to dispatch the fix round against. If omitted, the orchestrator uses each affected repo's currently checked-out branch and asks the user to confirm before dispatching. |
| `--auto-fix` | Skip the post-apply confirmation prompt and dispatch implementers for every approved finding's affected repo. Use with care — implementers will modify code on the resolved branch. |
| `--no-fix` | Skip the post-apply confirmation prompt and do NOT dispatch any implementers. Equivalent to answering "n" at the prompt. |

### Examples

```
/pipecrew:learn --pr=https://github.com/Arabookverse-com/abvi-backoffice-service/pull/31
/pipecrew:learn --pr=https://github.com/.../pull/42 --note="we fixed the auth approach, see commit d28808e"
/pipecrew:learn --run=2026-04-16-120338-book-content-upload
/pipecrew:learn --branch=fix/contract-detail-modals --base=main
/pipecrew:learn --session=current --workspace=dal-platform          # learn from the conversation we just had
/pipecrew:learn --session=2ed98d97-4d59-4e46-... --workspace=dal-platform   # a past session by id
/pipecrew:learn --session=current --workspace=dal-platform --note="focus on the modal-vs-route discussion"
/pipecrew:learn "the plugin keeps putting details in a separate route, we always want a modal"

# With fix-round:
/pipecrew:learn --run=2026-04-15-200215-contract-view-and-list --fix-branch=feature/contract-view-and-list
/pipecrew:learn --pr=https://github.com/.../pull/31 --auto-fix
/pipecrew:learn "we never split publisher modules" --no-fix     # docs only, do not touch any branch
```

## Instructions

### CRITICAL RULES

1. **Never silently rewrite workspace / repo docs.** Every proposed change is presented as a before/after diff; the user approves per finding or rejects. `--apply-all` still shows a summary and requires one confirmation.
2. **Never auto-apply plugin-level findings.** The target would be the plugin's own prompts/templates, which are shared across all workspaces. Plugin-level findings are logged with the flag `plugin-level-review-needed` so the maintainer can assess.
3. **Tier classification is the first filter.** Run-local findings are visible in the summary but don't become proposals. Only repo-scope, workspace-scope, and plugin-scope findings become actionable items.
4. **Log every invocation.** Append to `{workspace_root}/{slug}/history/learn-log.md` — even if every finding was rejected. The record matters.
5. **Be explicit about source reliability.** PR review comments from a human reviewer are strong signal. Post-merge fix commits are strong signal (the truth shipped). Free-form user text is strong signal but filtered through the user's recall. Run corrections are moderate signal (may have been one-off decisions). **A Claude Code session is the weakest signal** — exploratory, mostly normal work, lots of dead ends; treat it the same class as free-form text and default to recommending no change unless a structural, repeatable convention clearly emerges.
6. **Never dispatch a fix-round implementer without explicit user consent.** The fix round modifies real code on a real branch — it is the only step in `/learn` that touches anything outside the workspace docs. Default behavior is to ask the user (per repo, with the resolved branch named) before each dispatch. Only `--auto-fix` skips that gate, and only after the standard per-finding doc-approval gate has already run. `--dry-run` always implies `--no-fix`. Plugin-level findings never become fix-round dispatches (their target is the plugin, not workspace code).

---

### PIPELINE

```
1. Resolve workspace ──────────── (from --workspace or auto-detect)
2. Collect signal ─────────────── (based on source mode — pr / run / branch / text)
3. Dispatch feedback-learner ──── (agent analyzes signal vs current tier-1 docs)
4. Present findings ──────────── (tier-classified, per-finding approval UX)         <- user gate
5. Apply approved updates ─────── (file edits to the target tier)
6. Write learn-log entry ─────── (durable record in the workspace)
6.5. Optional fix round ──────── (per-repo implementer dispatch on the affected branch)  <- user gate
7. Report summary ────────────── (what was applied, what was flagged, what was fixed, one-line status)
```

---

### Step 1: Resolve the workspace

**Step 1.0 — resolve `{workspace_root}`**: run `node {plugin_dir}/scripts/workspace-root.js --get` to capture the user's configured workspaces root (the same resolution `/deliver` and `/discover` use). Use `{workspace_root}` everywhere the steps below reference workspace paths. If the script exits non-zero (root never configured), tell the user to run `/discover` first — feedback has nothing to learn against without an onboarded workspace.

If `--workspace=<slug>` is provided, use `{workspace_root}/{slug}/config.json`. If not:

- For `--pr` / `--branch`: extract the repo path from the PR URL or current working directory. Scan `{workspace_root}/*/config.json` for any workspace whose `repos.*.path` matches. If exactly one matches, use it. If multiple, ask the user.
- For `--run`: the run ID contains the workspace slug inherently — `{workspace_root}/*/runs/feature/{run_id}/` unique match.
- For `--session` and free-form text: no repo to auto-detect from. If `--workspace` is omitted, ask.

Validate the resolved config via `node {plugin_dir}/scripts/validate-config.js {config-path}`. Halt on errors.

**Step 1.5 — pull shared memory** (only if `config.workspace.memory.enabled`): before comparing the signal against the workspace's durable docs, read the team's latest so findings are proposed against current canon — `node {plugin_dir}/scripts/sync-memory.js pull {workspace_root}/{slug}`. Warn-only (dirty tree / fetch failure → uses local copy, never blocks `/learn`). Skip silently when memory is off.

### Step 2: Collect the signal

Branch on the source mode. Each produces the same output shape: a `signal` bundle containing raw material for the learner.

#### 2a. PR mode (`--pr`)

**Comments — use the canonical collector, do NOT hand-parse `gh` JSON.** Run the predefined script; it paginates fully, strips bot/CI noise, normalizes inline + conversation + review-summary comments into one list, and assigns **stable `C-n` ids** the learner's inventory adopts verbatim. Hand-parsing paginated JSON is the exact path by which a comment goes un-enumerated before the coverage guard can see it.

```bash
node {plugin_dir}/scripts/collect-pr-feedback.js --pr={pr-url} --out={run_dir}/signal/pr-comments.json
```

Exit codes: `0` ok · `1` usage / bad URL · `2` `gh` unavailable / not authenticated / network (tell the user to `gh auth login`) · `3` unparseable `gh` output. The script prints only a one-line count to stdout — the comment bodies stay in the file, out of your context. Pass `{run_dir}/signal/pr-comments.json` to the learner (Step 3); the learner Reads it and builds its `C-n` inventory from the ids the script already assigned.

**Commits — fetch separately for the plugin-vs-human partition** (the collector deliberately handles comments only, not the commit-authorship heuristic):

```bash
gh pr view {pr-number} --repo {org}/{repo} --json title,body,state,merged,mergeCommit,headRefName,files
gh api repos/{org}/{repo}/pulls/{pr-number}/commits
```

From this, compute:

- **Plugin commits vs human commits**: partition the commits by heuristics in order:
  1. `Co-Authored-By: Claude` trailer in commit message (strongest signal).
  2. Optional `PipeCrew-Run-Id: {run_id}` trailer (if the workspace adopts the trailer — see observability additions).
  3. Timestamp overlap with a `/deliver` run in `{workspace_root}/{slug}/runs/feature/*/checkpoints.jsonl` — commits made within the run's start–end window are presumptively plugin commits.
  4. Ask the user to confirm the partition before proceeding if heuristics are ambiguous.

- **Post-plugin fixes**: the diff between the last plugin commit and the final merged SHA — this is what humans had to add/fix to make the feature ship-worthy. The richest single signal.

- **Review comments**: already collected into `{run_dir}/signal/pr-comments.json` by the script above — each entry has a stable `C-n` id, `kind` (inline / conversation / review-summary), `author`, `association`, `path:line`, and `resolved` / `outdated` flags. Bot/CI noise is pre-excluded. Do NOT re-fetch or re-parse comments here; pass the file path to the learner.

Bundle the commit material + the canonical comment file path into the signal for the learner. Include `--note` verbatim if provided.

#### 2b. Run mode (`--run`)

```bash
run_dir={workspace_root}/{slug}/runs/feature/{run_id}
```

Read:
- `{run_dir}/scratchpad.md` — overview of what ran, which phases, what task files were created.
- `{run_dir}/corrections.md` — the captured user pushbacks during gates (if the run used a version of `/deliver` that wrote this file).
- `{run_dir}/run-notes.md` — durable observations the product-owner / solution-architect flagged during the run (their `## Notes for /learn` sections, appended by `/deliver`'s capture rule). **Strong signal** — these are the agents pointing at gaps in the workspace docs; treat each bullet as a candidate finding to tier-classify.
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

#### 2e. Session mode (`--session`)

Learn from a Claude Code conversation. Two sub-cases:

**`--session=<path>` or `--session=<id>`** (a past transcript) — use the canonical collector; do NOT hand-walk the JSONL. The transcript is mostly noise (assistant turns, tool results, local-command stdout, system reminders, sub-agent sidechains) and a real user turn can be missed before the coverage guard sees it. The script keeps only genuine human turns, drops the rest into an audit list, and assigns **stable `C-n` ids** the learner adopts verbatim:

```bash
node {plugin_dir}/scripts/collect-session-feedback.js --session={path-or-id} --out={run_dir}/signal/session.json
```

Exit codes: `0` ok · `1` usage / transcript-or-id not found / ambiguous id · `3` unparseable transcript. The script prints only a one-line count to stdout — the turn bodies stay in the file, out of your context. Pass `{run_dir}/signal/session.json` to the learner (Step 3); it Reads the file and builds its `C-n` inventory from the ids already assigned. (A bare id resolves under `~/.claude/projects/*/{id}.jsonl`; pass an absolute `.jsonl` path if the id is ambiguous.)

**`--session=current`** (the live conversation) — you are *in* the session, so do NOT try to self-read the whole transcript (it would blow the context budget). Instead, distill the salient feedback turns from the conversation you are currently in — the corrections, the "no, do it this way", the things the user repeated or insisted on — and write them yourself into `{run_dir}/signal/session.json` in the **same shape the collector emits**:

```json
{ "session": { "id": "current", "path": null, "turns": N },
  "counts": { "signal": N, "excluded": 0, "lines": 0 },
  "comments": [ { "id": "C-1", "kind": "user-turn", "ts": null, "body": "<verbatim or close-paraphrase of one feedback turn>" } ],
  "excluded": [] }
```

Keep `comments[]` to the turns that actually carry steering/feedback — skip routine "ok", "continue", "thanks". This is the cheap default path: finish a conversation, run `/learn --session=current`, and it proposes what (if anything) is worth persisting.

Either way, the resulting `session.json` is the signal bundle handed to the learner. Include `--note` verbatim if provided (that is the "free text + session" combination).

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
### Review comments — canonical list (read this file)
The PR's comments are pre-collected, de-noised, and numbered at:
  {run_dir}/signal/pr-comments.json
Read that file. Each entry already has a stable `C-n` id plus kind / author /
association / path:line / resolved / outdated. **Adopt those `C-n` ids verbatim
as your inventory spine** (Step 3.5) — do not renumber, drop, or merge them.
Every `C-n` in that file MUST appear in your Comment coverage table with a
disposition. (If a single comment bundles N distinct asks, keep its id and add
sub-ids C-n-a / C-n-b for the split.)

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

{For session mode:}
### Session feedback — canonical list (read this file)
The session's human turns are pre-collected, de-noised, and numbered at:
  {run_dir}/signal/session.json
Read that file. Each entry has a stable `C-n` id, `kind: user-turn`, and the turn
body (assistant turns, tool results, local-command echoes, system reminders and
sub-agent sidechains are already excluded). **Adopt those `C-n` ids verbatim as
your inventory spine** (Step 3.5) — do not renumber or drop them. Every `C-n`
MUST appear in your Comment coverage table with a disposition.

NOTE — this is the **weakest** signal class. A session is exploratory: most turns
are normal back-and-forth, dead ends, or one-off decisions, NOT reusable
conventions. Default each turn to `run-local` or `already-satisfied`. Only emit a
durable (`repo-durable` / `workspace-durable`) finding when a turn reveals a
**structural, repeatable** convention the user clearly wants applied beyond this
one conversation (e.g. "we ALWAYS use a modal", "NEVER split publisher modules").
When in genuine doubt, do NOT propose an update — recommend no change and say why.

## Current workspace durable docs (read and compare)

Read each of these before proposing any update:
- {workspace_root}/{slug}/context/platform.md (especially the `Established Patterns` section)
- {for each relevant repo:} {repo.path}/CLAUDE.md and the agent-context docs it points to
- {for each frontend repo:} {repo.path}/agent-context*/common/DESIGN_SYSTEM.md

## Your job

FIRST, inventory every distinct reviewer comment / discrete feedback item in
the signal and give each a stable id (C-1, C-2, …) — one reviewer remark = one
id; split a comment that bundles N asks into C-3a/C-3b/…. Assign EXACTLY ONE
disposition to every C-n: `doc-finding` (→ a Finding), `code-fix` (→ a CF-n the
implementer must fix — real code defect, not a reusable convention),
`run-local` (→ RL-n), `already-satisfied` (docs + code already comply),
`plugin-level` (→ flagged Finding), or `out-of-scope` (with a one-line reason).
You MUST emit the "Comment coverage" table mapping every C-n to its disposition
and how it was tackled — a comment with no disposition is a defect, not an
allowed omission. This is the completeness guard the user asked for.

THEN, for every meaningful pattern revealed by the signal, produce one finding.
A "meaningful pattern" is a recurring / structural issue — not a one-off
decision that only applied to this particular feature. Err on the side of
NOT proposing updates for one-off decisions. A comment that is a real defect but
not a reusable convention is NOT dropped — it becomes a `code-fix` (CF-n) item.

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
   - `workspace-durable` — convention shared across all repos (or all repos
     of a given type) in this workspace. Target: platform.md (typically
     `## Established Patterns`).
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

## Recommendation
{update | no-update} — {one sentence. If no-update, this is a complete, successful
answer: say WHY nothing durable should change, e.g. "the session was normal
feature work; no repeatable convention emerged." If update, name how many durable
findings follow.}

## Summary
- Source: {mode} / {identifier}
- Signal strength: {strong | moderate | weak — justify in one sentence}
- Current docs read: {count}
- Comments inventoried: {total C-n} — {N} doc-finding, {N} code-fix, {N} run-local, {N} already-satisfied, {N} plugin-level, {N} out-of-scope
- Coverage: {covered}/{total} → {ALL COVERED | ⚠ UNMAPPED: C-x}
- Findings produced: {N} ({N} run-local, {N} repo-durable, {N} workspace-durable, {N} plugin-level)

## Comment coverage
| Comment | Source | Gist | Disposition | How tackled |
|---|---|---|---|---|
| C-1 | {reviewer @ file:line / sha / "user text"} | {gist} | doc-finding | Finding 1 |
| C-2 | {…} | {…} | code-fix | CF-1 |
{one row per inventoried comment — every C-n appears exactly once}

**Coverage check**: {total} inventoried, {total} dispositioned → {ALL COMMENTS COVERED | ⚠ UNMAPPED}.

## Code-fix items (need an implementer, not a doc update)
{For each CF-n:}
### CF-1 — {repo} — {title}
**From comment**: C-{n}
**Repo**: {repo-name}
**Target**: {file}:{line}
**What's wrong**: {one sentence}
**Fix direction**: {one sentence}
**Evidence**: {verbatim quote + source}
{If none: _None._}

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
   better rejected than forced. For `session` / free-form `text` sources,
   default to **no durable finding** — these are exploratory, and recommending
   "no change" with a clear reason is a correct, complete answer, not a failure.
   Always emit the top-level `## Recommendation` line stating `update` or
   `no-update`.
5. **No file edits.** You propose, the orchestrator applies after user
   approval. Do NOT use Write or Edit tools.
6. **No plugin-level edits.** Even if a finding is clearly plugin-level,
   describe what the plugin change would be, but do not produce a file path
   under {plugin_dir}.
7. **Cover every comment.** Every inventoried C-n must appear exactly once in
   the Comment coverage table with a disposition. Dropping a comment because it
   wasn't a "pattern" is the exact failure this guard exists to prevent — route
   it to `code-fix`, `already-satisfied`, or `out-of-scope` instead. End with
   the coverage check line stating ALL COMMENTS COVERED or naming the unmapped
   ids.
```

The learner is read-only (tools: Read, Glob, Grep, Bash). It does not write anything.

---

### Step 4: Present findings + approval UX

**Step 4.0 — coverage gate (run before any per-finding prompt).** Parse the learner's `## Comment coverage` table and its coverage-check line. Then:

- If the coverage check reports any **UNMAPPED** comments, do NOT proceed silently. Re-dispatch the learner via `SendMessage` with: `"Your Comment coverage table left {ids} without a disposition. Every inventoried comment must map to doc-finding / code-fix / run-local / already-satisfied / plugin-level / out-of-scope. Re-emit the coverage table and any new CF-n / findings — same conversation, do not redo the rest."` Loop until coverage is complete (cap 2 retries; if still incomplete, surface the gap to the user explicitly rather than burying it).
- Render the coverage table to the user up front, so they can see how **every** PR comment was handled — not just the ones that became doc findings:

```
## Comment coverage — {source}   ({covered}/{total} comments dispositioned)

| Comment | Gist | Disposition | How tackled |
|---|---|---|---|
| C-1 | {gist} | doc-finding | Finding 1 |
| C-2 | {gist} | code-fix | CF-1 → fix-round (Step 6.5) |
| C-3 | {gist} | already-satisfied | platform.md §X already says this |
| C-4 | {gist} | out-of-scope | reviewer question, no change |
```

Code-fix items (`CF-n`) are carried into the Step 6.5 fix-round bundles (the "ask implementer to fix" path) — flag in the render that they need code changes, not doc edits.

**Step 4.1 — per-finding approval.** Parse the learner's output into a list of findings. Render each one to the user in a compact format:

```
## Feedback findings — {source}

Recommendation: {update | no-update} — {the learner's one-sentence justification}
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

**No actionable findings (common for `session` / `text`):** if the learner's `## Recommendation` is `no-update` and there are zero repo/workspace/plugin findings, skip the per-finding prompts entirely. Still write the learn-log entry (Step 6) — the reasoning is worth keeping — and go straight to the Step 7 summary, rendering it as the positive "no change recommended" outcome, not a warning. There is nothing to apply and (unless `--fix-branch` was given) no fix round.

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

Append to `{workspace_root}/{slug}/history/learn-log.md` (create if missing). Format:

```markdown
## {ISO-date} — {source-mode} {identifier}

**Source**: {mode} ({PR URL / run_id / branch / "text"})
**Source run ID**: {deliver-run-id — ONLY in `run` mode; omit this line for pr / branch / text}
**Signal strength**: {strong|moderate|weak}
**Workspace at time of feedback**: {git rev of workspace config.json, or "n/a"}

### Comment coverage
*(the full audit of how every inventoried reviewer comment was handled — copy the learner's coverage table)*

| Comment | Gist | Disposition | How tackled |
|---|---|---|---|
| C-1 | {gist} | doc-finding | Finding 1 (applied) |
| C-2 | {gist} | code-fix | CF-1 → fix-round: applied |
| C-3 | {gist} | already-satisfied | platform.md §X |
| C-4 | {gist} | out-of-scope | reviewer question |

**Coverage**: {covered}/{total} comments dispositioned — {ALL COVERED | ⚠ list unmapped}.

### Code-fix items
*(reviewer-flagged defects that became implementer work, not doc updates — appears only if the learner produced CF-n items)*

| CF | From | Repo | Target | Disposition |
|---|---|---|---|---|
| CF-1 | C-2 | abvi-backoffice-service | ContentRatingTaskService.java:142 | fixed in round (or: deferred / fix-skipped) |

### Findings applied
| # | Tier | Target | Summary |
|---|---|---|---|
| 1 | workspace-durable | platform.md § Established Patterns | Auth pattern documented as SecurityConfig + @PreAuthorize |
| 2 | workspace-durable | platform.md § Established Patterns | Query pattern documented as Specification<> |
| 3 | repo-durable | abvi-backoffice-service/CLAUDE.md | Added note: service exposes contract endpoints since PR #31 |

### Findings rejected
| # | Tier | Target | Reason |
|---|---|---|---|
| 4 | workspace-durable | platform.md | User rejected: "this is a one-off" |

### Findings flagged (plugin-level)
| # | Summary |
|---|---|
| 5 | Plugin-level: spring-boot implementer should prefer declarative security on greenfield code |

### Fix-round dispatches
*(this subsection appears only if Step 6.5 ran and at least one bundle was dispatched)*

| Repo | Branch | Implementer | Duration | Tokens | Applied | Skipped | Tests | Lint |
|---|---|---|---|---|---|---|---|---|
| abvi-pms-frontend | feature/contract-view-and-list | react-implementer | 4m 12s | 38K | #1, #3, #4, #5 | #2 (covered by #1) | pass | pass |
| abvi-publisher-service | feature/contract-view-and-list | spring-boot-implementer | 2m 04s | 19K | — | (no bundle — no findings for this repo) | — | — |

For each row that has a `Notes for the user` line in the agent output, also include it as a bullet underneath the table.

### Notes
- Invocation args: `--pr=... --note="..." [--fix-branch=... | --auto-fix | --no-fix]`
- Duration: {mm:ss} (orchestrator + learner + fix-round dispatches combined)
- Learner tokens used: ~{N}k
- Fix-round tokens used: ~{N}k *(only if Step 6.5 dispatched anything)*
```

The log is the durable record of how the workspace learned over time. Future `/pipecrew:learn` invocations can cross-reference this log to spot recurring patterns.

If you added a new entry for a finding that's marked **plugin-level**, don't only write it to the feedback log — also print a brief chat message pointing at it:

```
⚠️ Plugin-level finding flagged. See learn-log.md entry for {date}.
   To propose this upstream, open an issue / PR against the pipecrew plugin.
```

### Step 6.5: Optional fix round — apply findings to existing code

Doc updates from Step 5 only steer **future** runs. The branch the feedback came from still contains the violations the user flagged. This step optionally dispatches the per-repo implementer agents to fix them in place.

**Skip this step entirely** when ANY of the following holds:
- `--no-fix` was passed.
- `--dry-run` was passed (no docs were applied either, so there's nothing to "match" the branch to).
- Zero findings were applied at Step 5 **AND** the learner produced zero `code-fix` (CF-n) items (nothing to fix in code).
- Every applied finding is `plugin-level` **AND** there are no CF-n items (no workspace repo to fix).
- The source is `session` or free-form `text` **AND** `--fix-branch` was not passed. A session/text signal need not correspond to any branch, so the fix round is **opt-in** for these sources: run it only when the user explicitly names the branch to bring in line via `--fix-branch`. (With `--fix-branch`, proceed normally.)

> **Code-fix items are first-class fix-round input.** The fix round addresses two kinds of work: (a) approved doc findings whose convention the branch still violates, and (b) the learner's `code-fix` (CF-n) items — real defects a reviewer flagged that aren't reusable conventions. Both flow through the same per-repo bundling below. CF-n items make the round worth running even when every doc finding was rejected.

Otherwise:

#### 6.5.1 — Group approved findings AND code-fix items by affected repo

For each applied (non-plugin-level) finding, resolve the affected repo:

1. The finding's target file path always lives under one of `config.repos[*].path` — match by longest-prefix path. For each finding store `{finding_id, repo_name, repo_type, repo_path, target_doc_path}`.
2. The Observation / Evidence sections also contain concrete source-file references (e.g., `src/components/contracts/DownloadContractButton.tsx`). Extract any path that resolves under the same `repo_path` — these become the per-finding `affected_files` list.
3. If a finding has no in-repo source files (it's purely about adding a new file or moving things around), keep the finding but mark `affected_files: []` — the implementer will use the Correction text to decide what to create / move.

**Then add the learner's `code-fix` (CF-n) items.** Each CF-n already names its repo and target file:line. Resolve its `repo_path` the same way and fold it into that repo's bundle as a fix-list entry of kind `code-fix` (alongside any doc findings). A CF-n carries no doc to update — its "reference convention" is the reviewer comment itself; pass its `What's wrong` + `Fix direction` + evidence straight through. A repo that has only CF-n items and no doc findings still gets a bundle.

If the same repo is targeted by multiple findings and/or CF-n items, group them into ONE per-repo bundle. The orchestrator will dispatch ONE implementer per bundle, not N.

#### 6.5.2 — Resolve the implementer agent per repo

Use the canonical `TYPE_TO_AGENT` mapping in `{plugin_dir}/skills/deliver/phases/dispatch-rules.md` § "Agent Dispatch (TYPE_TO_AGENT mapping)". Same fallback chain applies:

1. Workspace-local override at `~/.claude/agents/{slug}-{type}-implementer.md` — prefer if present.
2. Plugin-shipped implementer from the table.
3. `general-purpose` with the standard preamble — last resort.

If the type has no plugin agent AND no workspace-local override (e.g., `type: api-collections`), skip that repo's bundle and tell the user — there is no implementer to dispatch.

#### 6.5.3 — Resolve the target branch per repo

In priority order:

1. If `--fix-branch=<name>` was passed, use that name across every affected repo.
2. Otherwise, run `git -C {repo_path} branch --show-current` for each repo and use whatever is currently checked out.
3. If a repo is in a detached-HEAD state, or the resolved branch is `main` / `master` / `dev` (the workspace's protected base — read from `repos[*].main_branch` if present, else default heuristic), do NOT auto-proceed — explicitly ask the user to name a branch. The fix round must never run against a protected branch by default.

Verify the branch exists on disk: `git -C {repo_path} rev-parse --verify {branch}`. If it doesn't, warn and skip that repo.

**Do NOT create a worktree.** Unlike `/deliver`, the fix round operates on the user's existing branch in-place — that branch is the whole point. The implementer agents are documented to work in their `repo_path` argument; pass the actual repo path, not a worktree path.

#### 6.5.4 — Per-repo confirmation gate

For each repo bundle, before dispatching, render:

```
## Fix-round dispatch — {repo_name}

Implementer:  {resolved_subagent_type}
Branch:       {resolved_branch}    (resolved via {flag | current | user-input})
Findings:     {N} ({list of finding IDs and one-line summaries})
Code-fixes:   {M} ({list of CF IDs and one-line summaries — reviewer-flagged defects})
Files in scope: {list of resolved affected_files + CF target files, or "(implementer will derive from Correction text)"}

Dispatch? (y = yes / n = skip this repo / b = pick a different branch)
```

- `y` → queue this bundle for dispatch.
- `n` → skip this repo entirely; record `fix-skipped` in the log.
- `b` → prompt for a branch name; re-validate with the rule in 6.5.3; re-render this gate.

`--auto-fix` skips this prompt and answers `y` for every bundle, BUT the protected-branch check from 6.5.3 still applies — `--auto-fix` will not silently dispatch against `main`/`master`/`dev`; in that case it pauses and asks for a branch.

#### 6.5.5 — Build the implementer prompt

For each queued bundle, dispatch via `Agent` tool with the resolved `subagent_type`. The prompt is structured the same way every implementer accepts a `fix_list`-style input. Pass:

```
**Tool**: Agent
**subagent_type**: {resolved_subagent_type}
**description**: "Fix round on {repo_name} — {N} findings from /learn"

**Prompt body** (literal — substitute placeholders):

You are dispatched as a fix-round implementer following a /pipecrew:learn run on the
{workspace.name} workspace. The user just approved {M} workspace/repo durable doc updates
that codify conventions this branch violated. Your job is to bring the existing branch in
line with those new conventions.

repo_path: {repo_path}
branch:    {resolved_branch}    (already checked out — do NOT create a worktree, do NOT switch
                                 branches, do NOT push, do NOT create commits unless explicitly
                                 asked by the user later)

Convention docs that were just updated (read these first — they are the source of truth):
{for each doc edited at Step 5 that lives under this repo:}
- {repo-relative path}    — section: "{section header that was added/edited}"

Findings to apply (fix_list):

{for each finding in this bundle:}
### Finding {id} — {one-line summary}
- **Observation** (what the code currently does): {finding.Observation}
- **Correction** (what the code must do): {finding.Correction}
- **Affected files** (resolved from Evidence — refine if you find more):
  {bullet list of finding.affected_files; or "(none yet — derive from Correction)"}
- **Reference convention**: {repo-relative path of the doc updated at Step 5 for this finding},
  section "{section name}". Re-read it before editing — that is the rule of record.

Code-fix items (fix_list — reviewer-flagged defects, no doc to read; the comment IS the spec):

{for each CF-n in this bundle:}
### {CF-id} — {one-line summary}  (from review comment {C-n})
- **What's wrong** (current behavior): {cf.whats_wrong}
- **Fix direction** (what the code must do): {cf.fix_direction}
- **Target files**: {cf.target file:line list}
- **Reviewer evidence**: {cf.evidence verbatim quote + source}. This is the rule of record for this item — there is no durable doc; apply exactly what the reviewer asked.

Constraints:
1. Edit ONLY the named files plus any of their direct callers / imports / tests that break
   because of the edit. Do NOT range further.
2. Update tests that exercise the changed code paths. If a test encodes the OLD behavior as
   the expected behavior, update both the test name and the assertion to match the new
   convention.
3. After all edits, run the repo's test suite and lint (use the commands documented in
   {repo_path}/CLAUDE.md). Report failures — do not gloss over them.
4. Do NOT commit. Do NOT push. Leave the working tree dirty for the user to inspect.
5. If a finding cannot be applied (e.g., the file was deleted on this branch, or the
   correction conflicts with another finding in this bundle), mark it
   `fix-skipped: {reason}` in your output and continue with the others.

Output (use this structure verbatim):

## Fix round outcome — {repo_name}
- Findings applied: {list ids}
- Findings skipped: {list ids with reason}
- Files changed: {list with one-line summary per file}
- Tests run: {command} → {pass | fail count}
- Lint: {command} → {pass | fail count}
- Notes for the user: {any judgement calls you made or anything they should review by hand}
```

#### 6.5.6 — Run dispatches in parallel across repos, sequential within a repo

Dispatch all per-repo bundles in parallel by issuing multiple `Agent` tool calls in a single message — the same parallelism rule `/deliver` uses for cross-repo work. Multiple findings within the same repo always go in ONE bundle to one implementer; never split same-repo findings across two parallel agents (they would race on the same files).

#### 6.5.7 — Capture per-bundle outcome

Parse each agent's `<usage>` block for `duration_ms` and `total_tokens`. Capture the `## Fix round outcome` block from the agent's response verbatim. For each bundle store `{repo_name, branch, subagent_type, duration_ms, total_tokens, applied_finding_ids, skipped_finding_ids, files_changed, test_status, lint_status, notes}`.

These records feed the Step 6 log entry's new "Fix-round dispatches" subsection (write the log AFTER 6.5 if any fix-round dispatches ran — see Step 6 note below) and the Step 7 summary line.

> **Re-write of the learn-log entry.** Step 6 may have already written the entry before 6.5 ran. If 6.5 produced any fix-round outcomes, append a `### Fix-round dispatches` subsection to the same entry (don't write a second entry). This keeps one log row per `/learn` invocation.

### Step 7: Summary

Emit the standard one-line phase-done status. Include a fix-round suffix when Step 6.5 dispatched at least one bundle:

```
[feedback ✔] {N} applied, {N} rejected, {N} plugin-flagged — {source} ({mm:ss}, {Xk} tokens)
            ↳ coverage: {covered}/{total} comments dispositioned ({C} code-fix items)
            ↳ fix-round: {R} repos, {A} findings + {CF} code-fixes applied to code, {S} skipped
```

Always print the coverage line — it is the at-a-glance proof that no reviewer comment was silently dropped. If coverage is < 100%, use ⚠ and name the unmapped ids.

**No durable change — distinguish deliberate from incomplete.** When 0 findings were applied:

- If the learner's `## Recommendation` was `no-update` (it looked and concluded nothing reusable emerged — the common, *correct* outcome for `session` / `text`), render it as a clean ✔ with the recommendation as the headline. This is a successful run, not a warning:

```
[feedback ✔] no context change recommended — session "modal-vs-route" (1:48, 12k tokens)
  Looked at 9 turns; all run-local (normal feature work). Reasoning recorded in learn-log.md.
  ↳ coverage: 9/9 turns dispositioned
```

- If findings WERE proposed but the user rejected them all (or coverage is incomplete), keep the ⚠ — something actionable was surfaced and nothing landed:

```
[feedback ✔⚠] 0 applied, 4 rejected, 1 plugin-flagged — PR #31 (2:15, 18k tokens)
  No workspace docs updated. Rejections recorded in learn-log.md.
```

If the doc applies succeeded but the fix-round prompt was declined / `--no-fix` was passed, mention that explicitly so the user remembers the existing branch was NOT touched:

```
[feedback ✔] 4 applied, 0 rejected, 0 plugin-flagged — text "contract-view-and-list" (3:22, 22k tokens)
  Fix round: skipped (--no-fix). Existing branches still violate the new conventions.
```

---

### Step 7.4: Sync workspace memory to GitHub (only if `config.workspace.memory.enabled` AND ≥1 finding applied)

If the workspace opted into GitHub-backed memory and this run **changed** any durable doc (≥1 finding applied to `platform.md` / repo `CLAUDE.md` / `agent-context` / `DESIGN_SYSTEM.md` / `audit-findings.md`), persist it:

```bash
node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} --message "learn: {N} updates — {source}" --checkpoint=learn
```

Skip when `memory.enabled` is absent/false, or when 0 findings were applied (nothing to sync). The script redacts secrets, commits the durable docs, rebases onto the team's latest, and publishes per `config.workspace.memory.sync_mode` — `commit` pushes straight to `main`; `hybrid`/`pr` open a `memory/*` PR when the change touches `platform.md` / an ADR (a rebase conflict always routes through a PR). Push/PR failures warn but never fail `/learn`. See `docs/design/github-memory.md`. **Note:** workspace-level findings update `{workspace_root}/{slug}/context/*` (synced here); repo-level findings update files *inside the code repos* (committed in those repos' own git, not here).

### Step 7.5: Finalize — update parent /deliver dispatch log (only when `--run` was supplied)

If `/learn` was invoked with `--run=<deliver-run-id>` (i.e. /learn was dispatched from /deliver Phase 8 Step 8.6), the parent /deliver run's `scratchpad.md` already has a feedback-learner row in its `## Agent Dispatch Log` table with outcome `in_progress` (written by Phase 8 just before the Skill invocation). Update it now so the site-view's `loop` character flips working → done and the pyramid closes.

**Locate the row**: `{workspace_root}/{slug}/runs/deliver/{deliver-run-id}/scratchpad.md`. Find the row whose Agent column is `feedback-learner` and Outcome is `in_progress`.

**Update the row** in place. Preserve the `#`, `Phase`, and `Agent` columns. Set:

- `Duration` = the wallclock duration of this /learn run (mm:ss).
- `Tokens` = total tokens reported by the feedback-learner agent (e.g. `18K`).
- `Outcome` = `success — {N} findings ({A} applied, {R} rejected, {F} plugin-flagged)`.

Use a single `Edit` (not `Write`) — append-only is wrong here, the row is being mutated. The file must keep its existing structure; only this row changes.

If the row is not found (e.g. /learn was invoked manually with `--run` outside the Phase 8 path, so /deliver never wrote the placeholder), skip the row update silently. Do not synthesize a row in that case — the user is running /learn ad-hoc and the /deliver run is already finalized.

**Record the reverse link (`learn_runs.json`).** The forward link (this learn run → its source deliver run) is the learn-log entry's `**Source run ID**` line. To make the *reverse* link queryable — a deliver run → the learn runs that analyzed it — write/merge `{workspace_root}/{slug}/runs/deliver/{deliver-run-id}/learn_runs.json` (the same machine-readable sidecar pattern Phase 8 uses for `pr_urls.json`):

```json
{
  "analyzed_by": [
    { "learn_run_id": "{this learn run_id}", "ts": "{ISO-8601}", "findings_applied": {A}, "findings_rejected": {R}, "findings_flagged": {F} }
  ]
}
```

Read-and-merge if the file already exists (a deliver run can be analyzed more than once) — append one `analyzed_by[]` entry, never overwrite prior ones. Do this even when the dispatch-log row above was absent (the ad-hoc `--run` case still benefits from the back-reference). Downstream tooling then has a direct "which learn runs touched this deliver run, and what did they change?" lookup without scanning every workspace's `history/learn-log.md`.

If `--run` was not supplied (PR / branch / free-form modes), this entire step is a no-op.

---

### INTERRUPTION HANDLING

- **User cancels mid-approval** — findings already applied stay applied. Write the log with partial results. Emit a `feedback ✔⚠` line noting "user cancelled at finding #N".
- **Learner agent fails** — report the failure; no log entry beyond "source collected, learner failed". User can re-invoke.
- **`Edit` fails because target file drifted** — mark the finding as `apply-failed` and continue. The user sees this in the final summary and can re-run with a smaller scope.
- **User cancels mid-fix-round-confirmation** — repos already dispatched continue running; repos still awaiting confirmation are recorded in the log as `fix-skipped: user-cancelled` and the run wraps up normally. Doc updates are NOT rolled back.
- **Fix-round implementer fails** — capture the failure outcome in the per-repo row of the log (`Outcome: failed — {error summary}`) and continue with the other repos' bundles. Do NOT retry automatically — re-running `/learn` against the same source would re-dispatch correctly.
- **Resolved branch is protected (main / master / dev)** — pause and require the user to name a non-protected branch. `--auto-fix` does NOT bypass this — protected-branch protection always wins.

---

### Observability

Every `/pipecrew:learn` run emits the same event schema as `/deliver` / `/discover` runs (see `{plugin_dir}/rules/observability.md`):

- `run_start` — with `skill: "learn"`, source mode, identifier.
- `agent_end` — after the learner returns, with token usage. Also emitted after each fix-round implementer returns (one per dispatched bundle), with `agent_type` set to the resolved implementer (e.g., `react-implementer`) and `phase: "6.5"`.
- `phase_end` — one per pipeline step above. Step 6.5 emits its own `phase_end` only when at least one bundle was dispatched; otherwise a skip-reason is recorded as `phase_end` with `status: "skipped"` and `reason` set to one of `no-fix-flag` / `dry-run` / `no-applied-findings` / `all-plugin-level` / `user-declined`.
- `run_end` — with applied/rejected/flagged counts AND fix-round counts (`fix_repos`, `fix_findings_applied`, `fix_findings_skipped`).

Run directory: `{workspace_root}/{slug}/runs/learn/{run_id}/` where `{run_id}` = `{YYYY-MM-DD-HHMMSS}-{source-slug}`. `source-slug` = `pr-31`, `run-2026-04-16-xxx`, `branch-fix-foo`, `session-current` or `session-{id-prefix}` (first 8 chars of the session id), or `text` (truncated first 24 chars of text).

Keep the learner's raw output under `{run_dir}/learner-output.md` for post-hoc debugging. The log entry is the human-facing summary; the raw output is the full reasoning trail.
