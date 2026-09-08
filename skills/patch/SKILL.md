---
name: patch
description: "Lightweight, memory-backed change skill. Applies small, well-specified, recurring changes (audit-finding fixes, codemods, convention enforcement, mechanical migrations) using reusable fix RECIPES instead of the full /deliver pipeline. No product-owner, no architect, no per-repo paired reviewers — design and review criteria come from recipes + ADRs + per-repo checklists. One approval gate. Read-only verification. Use when the WHAT is already known and the blast radius is small; bounce to /deliver when the change needs requirements, UX, or cross-repo contract design."
---

## What this is

`/patch` is the **low-altitude gear** for PipeCrew. `/deliver` decides *what to build*;
`/patch` applies *what's already decided*. Where `/deliver` re-derives design and review
criteria every run via expensive agents, `/patch` reads them from **memory** — a library of
fix **recipes** (each a fix template AND a detector), ADRs, and per-repo verify checklists.
That makes a known class of change near-free to repeat, and it gets cheaper the more you use it.

Use it for: audit-finding remediation, recipe sweeps (codemods), applying a reviewer/PR
comment, enforcing a remembered convention, mechanical migrations, or `/troubleshoot` fixups.

Do NOT use it for new features, anything needing requirements/UX discovery, or a real
cross-repo contract (spec/schema) change — those are `/deliver`. The skill self-detects this
and bounces (see "Escalation boundary").

## Usage
```
/patch [work-selector] [flags]
```

### Work selectors (how the change enters — pick one; interactive if omitted)
| Selector | Meaning |
|----------|---------|
| (none) | Interactive — list the workspace's `context/audit-findings.md` backlog and prompt for scope |
| `--findings=F1,F2,…` | Specific audit-finding IDs from `context/audit-findings.md` |
| `"free-form text"` | A described small change ("stop the bare except in abvi_email_sender.py") |
| `--recipe=<name> --sweep` | Codemod mode — run a recipe's match pattern across all repos, fix every hit. No findings doc needed. |
| `--from-troubleshoot=<report-path>` | Consume a `/troubleshoot` report's root-cause `file:line` as the work item |
| `--from-review=<report-path>` | Apply a `/review` or `/deliver` Phase 5.5 report's findings as a fix round |

### Flags
| Flag | Default | Effect |
|------|---------|--------|
| `--workspace=<slug>` | auto-detect | Workspace config. Auto-detects if only one exists. |
| `--no-worktrees` | worktrees ON | Work in-place on each repo's current branch (good for tiny edits). |
| `--review` | OFF | Add a real read-only reviewer dispatch on top of the completeness pass (for non-trivial patches). |
| `--commit` | OFF | Commit each touched repo after the gate (descriptive message per repo). |
| `--no-learn` | OFF | Skip writing new/updated recipes + gotchas back to memory at the end. |
| `--branch=<name>` | `patch/<slug>` | Feature/worktree branch name. |
| `--dry-run` | OFF | Match + plan + show the intended diff, then stop. No edits. |

### Examples
```
/patch --findings=F1,F2,F3,F4              # remediate specific audit findings
/patch "externalize the hardcoded API key in auth application.properties"
/patch --recipe=deliteralize-aws-account-id --sweep      # codemod across all repos
/patch --from-troubleshoot=runs/troubleshoot/2026-06-12-…/report.md --commit
/patch --findings=F3 --review --no-worktrees
```

---

## Instructions

### CRITICAL RULES
1. **Recipes are the source of design.** A known recipe means the team already decided how to
   fix this class — apply it, do not re-design. Only an *unmatched* item triggers a triage step.
2. **One gate.** `/patch` pauses for the user exactly once (Step 4, plan + diff). No
   requirements/architecture/spec/plan/review gates. (`--review` adds a reviewer dispatch, not
   a second user gate, unless it surfaces a blocker.)
3. **Verification is read-only and orchestrator-run by default** — grep/compile/synth from the
   recipe's `verify` rules. This is the safety fix for the reviewer-reverting-work failure mode:
   the default verifier cannot mutate the worktree. If `--review` dispatches a reviewer agent,
   that agent MUST be read-only (it produces findings only; it never edits or runs mutating git).
4. **Scope discipline (R6).** Touch only what the recipe/item cites. No "while I'm here" edits,
   no unrelated refactors. A patch that grows beyond its recipe is a signal to bounce to `/deliver`.
5. **In-session `Agent` dispatch — never `claude -p`.** Implementer `subagent_type` is resolved
   per repo `type` via the TYPE_TO_AGENT table (same as `/deliver`, see `phases/dispatch-rules.md`).
6. **Shared rules apply.** Transient-failure retries (`rules/transient-failures.md`), checkpoint
   events (`rules/observability.md`), and gate open/close (`scripts/gate.js`) work exactly as in
   `/deliver`. Emit `run_start` / `phase_*` / `agent_end` / `run_end` events to `checkpoints.jsonl`.

### Step 0: Resolve workspace + preflight
1. Resolve the workspace from the registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json`
   (add `--workspace=<slug>` if passed) → `{slug, path, root}`. Set `{slug}` = `.slug`,
   `{workspace_root}` = `.root`.
2. Config path is `{path}/config.json`. If `--resolve` exits 3, it lists candidates —
   one → use it, many → ask, none → tell the user to run `/discover` or `/join`. Validate with
   `node {plugin_dir}/scripts/validate-config.js <path>`. Stop on failure.
3. Create a run dir: `{workspace_root}/{slug}/runs/patch/{run_id}/` where
   `run_id = {YYYY-MM-DD-HHMMSS}-{slug-of-selector}`. Subdirs: `outputs/`, `tasks/`. Emit
   `run_start` to `{run_dir}/checkpoints.jsonl` (`skill: "patch"`).

### Step 1: Load memory (cheap reads — this is the whole point)
Read, in order, only what's relevant:
- **Recipes** — workspace-scoped: `{workspace_root}/{slug}/context/recipes/*.yml`. The plugin ships
  NO recipes; a recipe library is grown per workspace (by `/patch` and `/learn`). On a brand-new
  workspace this is empty — every item starts as an unmatched-triage in Step 3 and seeds the first
  recipes. If the directory is missing, create it on first write.
- **ADR index** (decisions that back recipes): `{workspace_root}/{slug}/context/adrs/INDEX.md`
- **Audit backlog** (if a findings selector is used): `{workspace_root}/{slug}/context/audit-findings.md`
- **Agent memory** — your own `MEMORY.md` store, for operational gotchas (e.g. untracked
  CLAUDE.md in worktrees, stale base branches) and user prefs. Honor them.
- Per-repo `CLAUDE.md` is read **lazily by the implementer**, only for repos actually touched.

### Step 2: Gather work items
Resolve the work selector to a concrete list of `{repo, target file:line, intended change}`:
- `--findings` → pull each finding's text from `audit-findings.md`; verify it against current
  code (line numbers drift — grep the cited symbol/literal, don't trust the stored line).
- free-form → identify the target file(s) and the change.
- `--recipe … --sweep` → run the recipe's `match` pattern across all repos (grep/glob); every
  hit becomes a work item. **No findings doc required — the recipe is the detector.**
- `--from-troubleshoot` / `--from-review` → parse the report's `file:line` + problem.

Group items by repo. Items in the same repo are applied sequentially (one worktree); different
repos run in parallel.

### Step 3: Match items to recipes (triage only the unknowns)
For each item:
1. **Match a recipe** by its `match` pattern + tags. On a hit, attach the recipe's `fix`,
   `verify`, and `follow_up` to the item. **No design work — the recipe is the design.**
2. **No match AND trivial/obvious** (e.g. a typo, a config value swap): handle inline; draft a
   new recipe stub if the pattern looks reusable.
3. **No match AND non-trivial** (a genuine design fork — which mechanism? which side of a
   trade-off?): this is the ONLY place `/patch` may escalate. Either:
   - dispatch a single, narrow `solution-architect` micro-call **for that item only**, or
   - if the fork is genuinely a feature/contract decision → **bounce to `/deliver`** (see
     Escalation boundary) and drop the item from this run with a note.
   Capture the resolution as a **new recipe** (written in Step 7) so the next instance is free.

Write one lean task file per item to `{run_dir}/tasks/{slug}.md` (target, recipe, fix, verify).

### Step 4: The single gate
Present the plan: per item — repo, target, the recipe being applied (or "triaged: <decision>"),
and the intended change. If `--dry-run`, also render the would-be diff and STOP here.

Open the gate: `node {plugin_dir}/scripts/gate.js open --run-dir={run_dir} --phase=apply
--gate=approval --question="Apply these N patches?"`. On the user's answer, `close` the gate.
`no` → stop. `yes` → proceed.

### Step 5: Apply
- **Worktrees** (default): per distinct repo, `git -C {repo} worktree add ../{repo}-{slug} -b {branch}`.
  With `--no-worktrees`, work in-place on the current branch. (Honor the memory gotcha: if a
  repo's CLAUDE.md / agent-context is untracked, the implementer reads it from the MAIN checkout,
  not the worktree.)
- Dispatch ONE implementer per repo (TYPE_TO_AGENT by repo `type`). The prompt points at the
  repo's task file(s) + worktree path and carries the recipe's `fix` directive. Same-repo items
  go to one implementer, applied sequentially. Different repos dispatch in parallel (one message).
- Implementers flip their task file `status: todo → done` and report files+lines changed.

### Step 6: Verify (read-only, orchestrator-run)
For each item, run its recipe's `verify` rules directly from the orchestrator (Bash):
- e.g. `grep "<literal>" == 0 hits`, `mvn -q -DskipTests compile`, `cdk synth`, `py_compile`.
- This verifier CANNOT mutate the worktree — that is deliberate.
If `--review` was passed, ALSO dispatch the matching read-only reviewer (TYPE_TO_AGENT reviewer
column) for a craft pass. A reviewer that attempts a mutating command is a defect — flag it; never
let a reviewer's edit/revert stand.

Any failed verify → record against the item, attempt one fix re-dispatch (per
`rules/transient-failures.md` cadence), then surface remaining failures at Step 7 (don't swallow).

### Step 7: Record (memory write-back) + wrap-up
- Write `{run_dir}/report.md`: items, per-repo files changed, verify results, and the
  **follow-ups** aggregated from each applied recipe's `follow_up` (e.g. "inject ENV_VAR / rotate
  secret"). Emit `run_end`.
- If a findings selector was used, append a **remediation-status** note to
  `context/audit-findings.md` marking the fixed items.
- Unless `--no-learn`:
  - Write/update **recipes** in `context/recipes/` for any newly-triaged class, and bump each
    applied recipe's `seen_in:` list.
  - Surface any operational gotcha discovered this run (suggest saving to agent memory).
  - (Recipes are workspace-actionable and safe to write. Plugin-level lessons are NOT written by
    `/patch` — that is `/learn`'s job, human-gated.)
- If `--commit`: commit each touched repo (`git add -u` to skip build artifacts) with a message
  citing the recipe/finding IDs and ending with the standard Co-Authored-By line. `/patch` never
  pushes or opens PRs — hand to the user or `/deliver --with-pr` for that.

---

## Recipe resolution
A recipe is both a fix template and a detector. Schema + authoring rules: `skills/patch/recipe-schema.md`.

**Recipes are workspace-scoped** — they live ONLY at `{workspace_root}/{slug}/context/recipes/*.yml`.
The plugin ships no recipes: a recipe encodes a *team's* convention (and often cites a workspace ADR),
so it belongs to the workspace, where it stays reusable across that workspace's repos and survives
plugin upgrades. `/patch` reads and writes this directory; `/learn` may also write to it. A fresh
workspace starts empty and grows its library as `/patch` triages new classes.

## Escalation boundary (when /patch bounces to /deliver)
Refuse and hand off the moment the *what* is unknown. Concrete trip-wires:
- No matching recipe **and** the change is non-trivial **and** it touches an API spec / shared
  schema / contract → it's a delivery, not a patch.
- The change needs new requirements, UX, or product decisions.
- The change spans repos with a *new* wire-shape that must be designed (producer/consumer).

When bouncing: print `This needs design — run: /deliver "<restated change>" [flags]` and stop the
affected item. A one-line config/code edit is a patch; "publishers can choose contract type" is not.

## What this skill does NOT do
- No product-owner, no architecture phase, no task-planner.
- No per-repo paired reviewers by default (opt in with `--review`); never a mutating reviewer.
- No spec/schema editing, no mock/frontend generation for new contracts (→ `/deliver`).
- No push, no PR open, no merge. (`--commit` is the furthest it goes.)
