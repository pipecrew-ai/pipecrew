---
name: deliver
description: "PipeCrew delivers a feature end-to-end across all workspace repos. Orchestrates: requirements → architecture → spec editing → parallel implementation (backend + frontend + mock + infra) → cross-repo assessment. Usage: /deliver <feature description>. Reads workspace config from {workspace_root}/{workspace}/config.json."
---

## Description

End-to-end feature pipeline. Orchestrates work across API service repos, frontend, mock server, and infrastructure repos as defined in the workspace config.

## Usage
```
/deliver <feature description> [flags]
/deliver --resume [--workspace=<slug>]
```

### Arguments
- `feature description`: rough 1-2 sentence description of what the user needs. Mention the relevant domain area naturally (e.g., "publishers can choose contract type" — the architect will identify that this involves the publisher service).

### Flags
| Flag | Effect |
|------|--------|
| `--workspace=<slug>` | Workspace config. Auto-detects if omitted. |
| `--feature=<slug>` | For `--resume` / `/site-view` — pick one in-flight pipeline by slug |
| `--service=<key>` | Hint Phase 1 focus (architect decides full impact) |
| `--skip-spec-edit` | Skip spec editing |
| `--skip-backend` | Skip spec editing + backend |
| `--frontend-only` | Frontend only |
| `--backend-only` | Backend only (no frontend/mock/infra) |
| `--with-infra` | Force infra phase |
| `--no-mock` | Skip mock |
| `--no-review` | Skip Phase 5.5 code review |
| `--auto-fix-mechanical` | Phase 5.5 routes fix rounds **per repo**: a repo whose criticals are all `mechanical` (the reviewer tags each critical `mechanical` or `architectural`) skips the gate and its fix round dispatches the moment its reviewer finishes — pipelined, without waiting for sibling reviewers. Repos with any `architectural` critical still gate — but each gets its own focused gate as its reviewer finishes (per phase-5.5 Step 2), not a consolidated end-of-phase prompt. Use to tighten the loop on small features where reviewer findings are predictable (missing field, wrong status code, missing i18n key). |
| `--force-security-review` | Force security review |
| `--no-security` | Skip security review |
| `--no-context-update` | Skip Phase 7 agent-context refresh |
| `--with-pr` | Phase 8 publishes draft PRs (one per repo) with cross-repo linking; without it Phase 8 only runs the feedback offering |
| `--publish-despite-blockers` | Phase 8 PR publish ignores Phase 6 blocker gate (use only after manually reviewing blockers) |
| `--no-feedback-prompt` | Phase 8 skips the end-of-run feedback prompt (CI-friendly) |
| `--resume` | Resume interrupted pipeline (asks which if multiple) |
| `--from-deferred[=<feature-slug>]` | Resume work the user previously chose to defer at a Phase 4.5 "Minimum only" gate. With a value, loads `{workspace_root}/{slug}/deferred/<feature-slug>.md` directly. Without a value, lists pending deferred files and prompts to pick one. Different from `--resume` (which picks up an INTERRUPTED in-flight pipeline) — `--from-deferred` starts a NEW run from a deferred follow-up file. |
| `--no-worktrees` | Skip worktree creation for Phase 3 + Phase 5. Work in-place on the current branch of each repo. Use only for small interactive fixes where isolation is not needed. Default is to create one worktree per repo touched. |
| `--auto-approve` | Cut Claude Code's per-tool-call permission prompts during the run. Writes an opt-in marker (`scripts/autoapprove-marker.js on`) that the plugin's `deliver-autoapprove-hook.js` reads to **auto-approve only clearly-safe tool calls** — file edits (`Edit`/`Write`) plus `Bash` whose every segment is a known build/test/local-git/read verb. **Dangerous or unclassifiable commands (rm, git push, deploys, publish, sudo, shell substitution, redirects, unknown binaries) still prompt.** The marker is removed at run end / interruption and self-expires ~6h after the run goes idle. This is NOT `bypassPermissions` — it never auto-approves the risky stuff. See `docs/permissions.md`. Requires a `claude` restart after plugin upgrade for the hook to load. |

### Examples
```
/deliver "publishers choose contract type when requesting"
/deliver "managers see reviewer performance stats" --skip-spec-edit
/deliver "add 2FA to login flow" --with-infra --workspace=my-platform
/deliver "bulk book status change" --service=publisher
/deliver --resume --workspace=my-saas
/deliver --from-deferred=publishers-choose-contract-type    # resume the deferred slice from a previous "Minimum only" run
/deliver --from-deferred                                     # list pending deferred items and prompt to pick one
```

## Instructions

### CRITICAL RULES

1. **Read the workspace config first.** Resolve the config path:
   - If `--workspace=<slug>` was passed: use `{workspace_root}/{slug}/config.json`
   - If not passed: resolve `{workspace_root}` via `node {plugin}/scripts/workspace-root.js --get` and scan `{workspace_root}/*/config.json`. If exactly one exists, use it. If multiple exist, list them and ask the user to pick.
   - If none exist, print the detailed "missing config" block below and stop — do NOT proceed to Phase 1.

   Parse the JSON. Validate with `node {plugin}/scripts/validate-config.js {config-path}`. If validation fails, report errors and stop. All repo paths, service mappings, spec file locations, and domain context come from this config — nothing is hardcoded.

   **Missing-config stop message** (print verbatim, adapted to the user's scan results):

   ```
   ✗ No workspace config found.

   /deliver requires a workspace configuration file at
     {workspace_root}/{slug}/config.json

   I scanned {workspace_root}/ and found none. The workspace config is
   produced by /discover, which also generates several other artifacts
   that /deliver depends on.

   Recommended: run /discover first

     /discover /path/to/your/repos

   /discover takes about 5-15 minutes and produces:
     • config.json           — this file (hard requirement)
     • context/platform.md   — architecture context for Phase 2 (hard requirement)
     • CLAUDE.md per repo    — implementer orientation (soft; skip → 3-5× token cost per dispatch)
     • agent-context/ per repo — deep architecture docs (soft; skip → implementer re-reads code each run)
     • context/audit-findings.md — real bugs spotted during onboarding (soft; skip → Phase 4.5 has fewer anti-patterns to inject)
     • Workspace agents ({slug}-product-owner, assessor, ux-consultant) — tailored to your domain

   You can hand-write config.json + context/platform.md and run /deliver
   against them directly, but the other artifacts are soft-optional and
   each one degrades /deliver quality in a specific way:

     - No CLAUDE.md → implementers guess conventions per dispatch; PRs become less consistent
     - No agent-context → no "similar feature" catalog; implementers re-derive architecture
     - No audit-findings.md → Phase 4.5 `## Known Anti-Patterns` uses plugin stack catalog only, not your workspace's observed bugs
     - No workspace agents → falls back to generic agents with a preamble; product-owner loses domain context

   If your workspace has zero existing repos (greenfield): run
     /discover --greenfield
   which brainstorms + scaffolds + discovers in one pass.
   ```
2. **Config-driven phase auto-detection.** After loading the config, derive which phases to run based on what repos exist — NOT based on assumptions about the workspace shape. Flags override auto-detection, not the other way around.

    | Phase | Auto-runs if | Override flag |
    |-------|-------------|---------------|
    | 3a (Contract Edit) | architect's `AFFECTED_CONTRACTS` is non-empty | `--skip-spec-edit` skips |
    | 3b (Spec Edit) | architect found spec changes AND at least one affected service has `spec_policy: api-first` | `--skip-spec-edit` skips |
    | 4 (Spec Sync) | user opts in at the Phase 3 approval gate | **default OFF** — skipped unless the user answers "yes" to the spec-sync follow-up at the Phase 3 gate. Auto-skipped (and the gate question is suppressed) when no repo has `spec_copies` referencing any affected service — there are no sync targets to ask about. |
    | 5a (Backend) | config has repos with `role: "api-service"` | `--frontend-only` skips |
    | 5b (Frontend) | config has repos with `role: "frontend"` | `--backend-only` skips |
    | 5c (Mock) | config has repos with `role: "mock-server"` | `--no-mock` skips |
    | 5d (Infra) | config has repos with `role: "infrastructure"` AND architect flags it | `--with-infra` forces |
    | 5.5 (Review) | any Phase 5 task ran | `--no-review` skips |
    | 5.75 (Security) | keyword trigger or `--force-security-review` | `--no-security` skips |
    | 6 (Assess) | **2+ repos modified during Phase 5 AND the architect's `cross_repo_integration` flag is `true`** (or absent — conservative fallback). Skip if only 1 repo changed (the reviewer covers it) OR if 2+ repos changed but `cross_repo_integration=false` (standalone scope — nothing cross-repo to assess; e.g. bundled-independent changes or the same maintenance applied to several services). Note the skip reason. See phase-6-assess.md spin-up decision. | — |
    | 7 (Report) | always | — |
    | 8 (Publish + Wrap-up) | always (Step 8.6 feedback offering); PR publish steps within Phase 8 only if `--with-pr` AND no Phase 6 blockers | `--with-pr` enables PR publish; `--publish-despite-blockers` overrides blocker gate; `--no-feedback-prompt` skips Step 8.6 |

    Store the derived phase plan in the scratchpad's Architecture Flags section. Log: "Auto-detected phases: {list}. Skipped: {list with reasons}."

3. **Pre-flight check** — verify all repo paths from the config exist on disk. Report missing repos and stop.
4. **Per-run isolation.** Each feature run has its own directory under the workspace:
   ```
   {workspace_root}/{slug}/runs/deliver/
   └── {run_id}/                    ← THIS run's {run_dir}  (run_id = {YYYY-MM-DD-HHMMSS}-{feature-slug})
       ├── scratchpad.md            lean phase index
       ├── checkpoints.jsonl        unified event log (see rules/observability.md)
       ├── outputs/
       ├── tasks/
       ├── review/                  per-repo code-review reports
       ├── security-review.md       (optional — --force-security-review)
       ├── assessment.md            Phase 6 output
       ├── fix-rounds/              (optional — per fix-round artifacts)
       └── report.md                Phase 7 final report
   ```
   The timestamp prefix of `{run_id}` makes sibling dirs chronologically sortable — no separate `active/` or `completed/` split. In all phase files, `{run_dir}` resolves to `{workspace_root}/{slug}/runs/deliver/{run_id}/`. See `phases/pre-flight.md` for run_id computation + directory creation. Update the scratchpad immediately after every phase completes.
5. **User approval gates** — pause after Phase 1 (requirements), Phase 2 (architecture), Phase 3 (spec changes), Phase 4.5 (implementation plan), **Phase 5b UX consultant** (before launching feature-implementer), and **Phase 5.5 code review** (only for repos with critical issues that need approval — the gate asks whether to dispatch a fix round. Reviewers run as background dispatches and are processed per-repo as each finishes: a repo needing no approval (gates disabled, or `--auto-fix-mechanical` set AND that repo's criticals all `mechanical`) dispatches its fix round immediately; a repo needing approval gets its own focused gate the moment its reviewer finishes — one prompt per critical-finding repo as findings arrive, NOT one consolidated prompt after the slowest reviewer. Only one gate is open at a time. See phase-5.5-code-review.md Step 2).

    **At EVERY gate, surface the wait to the UI**: before asking the user, run `node {plugin_dir}/scripts/gate.js open --run-dir={run_dir} --phase={N} --gate=approval --question="..." [--context="..."]`. After receiving the user's answer, run `node {plugin_dir}/scripts/gate.js close --run-dir={run_dir}`. This drives the yellow "waiting for input" banner in the pipeline-view UI and the `⏸` prefix in the browser tab title — essential when the user has the UI open in a second monitor and is working elsewhere. Forgetting to `close` leaves the banner stuck; treat open/close as mandatory bracketing around every gate. Full gate contract + label catalog in `{plugin_dir}/docs/site-view.md`.
6. **Parallel execution** — Phases 5a, 5c, 5d run in parallel via background agents. Phase 5b runs sequentially (UX → user gate → implementer) but can run in parallel with 5a/5c/5d.
7. **Section extraction** — extract architect output sections using `<!-- BEGIN X -->` / `<!-- END X -->` delimiters. Product-owner output also uses these delimiters.
8. **Clarification questions** — product-owner and solution-architect agents will ask questions. Present them to the user and pass answers back.
9. **Spec editing — delegated to `openapi-spec-editor`** — Phase 3 dispatches the `openapi-spec-editor` agent via the Agent tool to apply the approved technical design's API_DESIGN section to each affected spec file in the architect's declared order. The agent reads each spec, applies edits in place on the current branch, verifies YAML well-formedness, and returns a structured diff summary per service. The orchestrator never reads spec files directly — it reads only the agent's diff summary.
**Rollback on rejection**: if the user rejects at the Phase 3 approval gate, the orchestrator runs `git checkout <spec-file>` for each modified spec in each affected service repo to revert, then either stops the pipeline or re-dispatches `openapi-spec-editor` with updated instructions based on the user's feedback. The agent does not handle rollback itself — that's strictly an orchestrator responsibility.
10. **In-session Agent tool dispatch — NEVER `claude -p`.** See `phases/dispatch-rules.md` for the full TYPE_TO_AGENT mapping table, worktree creation steps, and parallel dispatch rules. Load that file before Phase 4.5.
    - **Worktrees default ON.** Phase 3 creates worktrees for spec-owning repos; Phase 5 reuses them and creates more for repos not touched in Phase 3. Agents always work in the worktree path — never the main repo checkout. `--no-worktrees` opts out (see flag table).
    - **Workspace agents:** Phase 1 / Phase 5b UX / Phase 6 dispatch by slug-prefixed name (`{slug}-product-owner`, `{slug}-ux-consultant`, `{slug}-assessor`). Onboarding Phase C Step 3 publishes these to `~/.claude/agents/` so they resolve as first-class `subagent_type`s. If not found, phases fall back to `general-purpose` with a preamble that reads the canonical copy at `{workspace_root}/{slug}/agents/{role}.md`.
11. **Context hygiene** — after dispatching Phase 5 agents, do NOT re-reference Phase 1/2 outputs from conversation history. Use the scratchpad output files when Phase 6 needs them.
12. **Agent naming** — name agents by their role, not their phase number. E.g., "Backend implementer — publisher-service" not "Phase 5a: Backend implementation".
13. **SendMessage for follow-ups** — if an agent returns incomplete output, use `SendMessage` to continue the existing agent rather than spawning a new one.
14. **Execution tracking + task management** — see `phases/dispatch-rules.md` for the full tracking protocol (per-phase, per-dispatch, per-task metrics) and the task file contract (frontmatter schema, CRUD operations, context-lean rules). Load that file before Phase 4.5.
15. **Transient failures** — every Agent dispatch in every phase follows the shared retry rules at `{plugin_dir}/rules/transient-failures.md`. Retry once on 529/503/network per the table, wait per `retry-after` on 429, halt on a second 429 or any non-429 4xx. Emit `retry` + follow-up `agent_end` events per `rules/observability.md`. On parallel dispatch, retry only the failed agent — let the rest of the batch finish. Deferred agents block advancing to the next gating phase until the user resumes or approves continuing without them.
16. **Emit a one-line phase-done status in chat** — immediately after `phase_end` and scratchpad update, print exactly one line in the format:

    ```
    [phase {CODE} ✔] {what-was-produced} ({metrics})
    ```

    Examples:
    - `[phase 1 ✔] requirements document (FR×8 / EC×3, 12k tokens, 2:10)`
    - `[phase 2 ✔] technical design — 4 services, 7 endpoints (28k tokens, 4:03)`
    - `[phase 3 ✔] spec edits applied to 3 services (3:12)`
    - `[phase 5a ✔] publisher-service backend complete — 12 files changed (94k tokens, 8:12)`
    - `[phase 5.5 ✔] 3 reports — 2 critical, 5 non-critical (24k tokens, 5:20)`
    - `[phase 6 ✔] assessment PASS (18k tokens, 6:18)`

    Gives users a greppable progress signal without forcing them to open the scratchpad. One line per phase — no trailing commentary. After the line, proceed to the next phase (or wait for an approval gate if the phase is gated).

    Partial failure or user-rejected gate gains a `⚠` suffix and one extra line:
    ```
    [phase 5a ✔⚠] 2 services complete, 1 deferred (80k tokens, 7:40)
      Deferred: backoffice-service (529 after retry) — re-run /deliver --resume
    ```

### PIPELINE

```
Pre-flight: Validate repos + create scratchpad ── automatic
Phase 1: Requirements (dal-product-owner) ──────── WHAT                    <- user gate
Phase 2: Architecture (solution-architect) ─────── HOW + WHICH SERVICES    <- user gate
Phase 3a: Contract Edit (schema-implementer) ────── SHARED SCHEMAS          ┐
Phase 3b: Spec Edit (openapi-spec-editor) ────────── API CONTRACT             ┴─<- single user gate (both diffs)
Phase 4: Sync Specs ────────────────────────────── opt-in at Phase 3 gate (default OFF)
Phase 4.5: Implementation Plan + Context Budget ─── full task list          <- user gate
Phase 5: Parallel ──────┬── 5a: Backend (spring-boot-implementer — one per service)
  (Agent tool dispatch) ├── 5b: Frontend (ux-consultant → react-implementer)
                        ├── 5c: Mock Server (mock-implementer)
                        └── 5d: Infrastructure (cdk-stack-implementer, if needed)
Phase 5.5: Per-repo code review ─┬── Backend: {type}-reviewer (once per service)
  (parallel, skips mock+infra)   └── Frontend: {type}-reviewer
                                 → if critical issues: user gate → re-dispatch implementers with fix list
Phase 5.75: Security code review (security-consultant, if triggered)
Phase 6: Assessment (assessor) ──────────────────── cross-repo spec + requirements verification
Phase 7: Summary ──┬── Reporter agent (execution report with insights)
                   ├── Context-manager refresh (unless --no-context-update)
                   └── Archive scratchpad
Phase 8: Publish ──┬── PR publish (if --with-pr): user gate → push → draft PRs → cross-repo linking → append PR URLs to report.md
                   └── Run wrap-up + feedback offering (always): /learn --run + disclaimer about /learn --pr later
```

---

### Scratchpad

The scratchpad template and directory structure are in `phases/pre-flight.md` (loaded only during Pre-flight and Resume — not during implementation phases). The scratchpad itself lives at `{pipeline_dir}/active.md`.

### Utility scripts

Zero-dep Node — prefer over LLM parsing. Phase files cite the specific script at point of use; this is the discoverability index.

| Script | Purpose |
|--------|---------|
| `node {plugin_dir}/scripts/extract-block.js <file> <BLOCK> [--raw]` | Pull a structured JSON block from a phase output (default), or the raw block body for prose-only sections (`--raw`). Block names: `templates/blocks/block-schemas.md`. |
| `node {plugin_dir}/scripts/split-design.js <file> [out-dir]` | Materialize every JSON-fenced block in a phase output as a separate file under `<out-dir>/<slug>.json` (default `<input-dir>/blocks/`). Phase 2 runs this after writing `phase-2-architecture.md` so phases 3–5 can `cat outputs/blocks/<slug>.json` instead of reading the full markdown. |
| `node {plugin_dir}/scripts/gate.js {open\|close} ...` | Open/close approval gates. Always close after the user answers. |
| `node {plugin_dir}/scripts/write-review-diff.js --worktree=<path> --out=<file> [--base=<ref>]` | Pre-compute a repo's feature diff to a file for a (Bash-less) Phase 5.5 reviewer. Prints only a byte-count — the diff body never enters orchestrator context. |
| `node {plugin_dir}/scripts/validate-config.js <path>` | Validate workspace `config.json`. |
| `node {plugin_dir}/scripts/validate-claude-md.js <path>` | Validate a `CLAUDE.md` against the guardrails. Run after context-manager dispatches. |
| `node {plugin_dir}/scripts/validate-checkpoints.js <path>` | Validate `checkpoints.jsonl` event format. |

## Phase Files

Each pipeline phase lives in its own file under `phases/`. The orchestrator loads **only the active phase file** — not all of them. This keeps context lean mid-run.

**Lazy loading rule**: Read a phase file when you enter that phase. Drop it from working memory when you exit (auto-compaction handles this; do not re-reference it in later phases).

| Phase | File | ~Lines |
|-------|------|--------|
| Pre-flight + Resume + Scratchpad template | `phases/pre-flight.md` | 181 |
| 1. Requirements | `phases/phase-1-requirements.md` | 38 |
| 2. Architecture | `phases/phase-2-architecture.md` | 53 |
| 3. Contract + Spec Edit (3a + 3b) | `phases/phase-3-spec-edit.md` | 209 |
| 4. Sync + 4.5 Plan | `phases/phase-4-plan.md` | 231 |
| Dispatch rules + task contract | `phases/dispatch-rules.md` | 83 |
| 5. Implementation | `phases/phase-5-build.md` | 141 |
| 5.5. Code Review | `phases/phase-5.5-code-review.md` | 126 |
| 5.75. Security Review | `phases/phase-5.75-security-review.md` | 78 |
| 6. Assessment | `phases/phase-6-assess.md` | 101 |
| 7. Summary + Archive | `phases/phase-7-report.md` | 216 |
| 8. PR Publish + Feedback Offering | `phases/phase-8-pr-publish.md` | 220 |

**When entering a phase**: `Read {plugin_dir}/skills/deliver/phases/{phase-file}` — follow the instructions in that file for the phase.

---

### INTERRUPTION HANDLING

- "skip" → mark phase skipped in scratchpad, continue
- "stop" → update scratchpad with current state, summarize progress
- "restart from phase X" → update scratchpad Current Phase, resume
- A parallel phase fails → update scratchpad task status to FAILED, report error, continue others, ask user
- Context limit hit → scratchpad persists, user runs `/deliver --resume` in new session

---

### FLAG BEHAVIOR SUMMARY

| Flag | Skips | Starts From |
|------|-------|-------------|
| (none) | — | Phase 1 — architect decides frontend/mock |
| `--skip-spec-edit` | Phase 3 | Phase 1 → 2 → 4 → 5 |
| `--skip-backend` | Phase 3 + 5a | Phase 1 → 2 → 4 → 5b,5c,5d |
| `--frontend-only` | Phase 3 + 5a + 5c + 5d | Phase 1 → 2 → 4 → 5b |
| `--backend-only` | Phase 5b + 5c + 5d | Phase 1 → 2 → 3 → 4 → 5a |
| `--with-infra` | — | Forces Phase 5d even if architect didn't flag it |
| `--no-mock` | Phase 5c | — |
| `--no-review` | Phase 5.5 | Phase 5 → 6 directly |
| `--auto-fix-mechanical` | — | Per-repo Phase 5.5 routing: all-`mechanical` repos pipeline their fix round (no gate, dispatched as the reviewer finishes); repos with `architectural` criticals still gate |
| `--from-deferred[=<slug>]` | — | Loads a previous run's deferred follow-up file as the feature input. Phase 1 (product-owner) and Phase 2 (architect) still run — they refine the deferred items against current state. Phase 7 Step 7.5 marks the source file as `consumed` on success. |
| `--with-pr` | — | Phase 8 publishes one draft PR per repo with cross-repo linking |
| `--publish-despite-blockers` | — | Phase 8 PR publish ignores Phase 6 blocker gate |
| `--no-feedback-prompt` | Phase 8 Step 8.6 | Phase 8 skips end-of-run feedback prompt |
| `--resume` | Completed phases | Reads scratchpad, continues from current phase |

**Architect auto-detection** (when no conflicting flag is set):
- `Frontend Changes Required: No` → Phase 5b skipped automatically
- `Mock Server Update Required: No` → Phase 5c skipped automatically
- Affected Services list → Phase 5a loops only for listed services
