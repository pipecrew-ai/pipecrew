### Phase 6: Assessment (assessor)

**Spin-up decision** — the assessor is a cross-repo integration judge (see its charter below), so it only earns its tokens when there is a cross-repo surface to judge. Two skip conditions, checked in order:

1. **Single-repo skip.** Count the distinct repos that had COMPLETED implementation tasks. If only 1 repo was modified, **skip Phase 6 entirely** — the per-repo code reviewer in Phase 5.5 already covered it. Log: `"Only 1 repo modified ({repo-name}) — Phase 6 skipped. Cross-repo assessment requires 2+ repos."`
   - **Exception — frontend-only runs still get browser verification.** If that single modified repo has `role: "frontend"` (and `--no-browser-verify` was not passed), still run **Step 6.5 (Live frontend verification) standalone** before skipping the rest of Phase 6 — there are no cross-repo static passes to do, but the running UI is exactly what a single-repo reviewer can't exercise. Skip only Steps 2–5; run Step 6.5, then proceed to Phase 7.

2. **Standalone-scope skip (2+ repos, no integration surface).** Even with 2+ repos modified, read the architect's `cross_repo_integration` flag from the AFFECTED_SERVICES block (`node {plugin_dir}/scripts/extract-block.js {run_dir}/outputs/phase-2-architecture.md AFFECTED_SERVICES`, field `cross_repo_integration`; or read `{run_dir}/outputs/blocks/affected-services.json`). If it is `false`, **skip Phase 6** — the repos changed independently with no shared contract, no service-to-service call, no cross-stack ref, and no frontend→backend binding, so there is nothing cross-repo to assess; the per-repo Phase 5.5 reviewers already covered each repo standalone. Log: `"{N} repos modified but cross_repo_integration=false ({cross_repo_rationale}) — Phase 6 skipped. No cross-repo surface to assess."` This is the path for bundled-but-independent changes and the same maintenance applied to multiple services.
   - **Fallback if the flag is missing** (older architect output, no `cross_repo_integration` field): do NOT skip — fall through to running the assessor. A missing flag must not silently drop integration verification. Log a warning so the architect prompt can be tightened.

On either skip: set Phase 6 status to SKIPPED and proceed to Phase 7. Otherwise (2+ repos AND `cross_repo_integration` is `true` or absent) run the assessor as below.

> **Routing note:** audit-finding remediation and standalone maintenance are usually better run through `/patch`, which has no assessor phase by design. If such work reaches `/deliver` and touches 2+ repos, the `cross_repo_integration=false` skip above is the safety net that keeps the assessor from spinning up on it.

**MANDATORY PRE-CHECK**: Before launching the assessor, read the scratchpad's Implementation Tasks table. Check every task's status. Build a status summary:

```
IMPLEMENTATION TASK STATUSES:
| Task | Status | Notes |
|------|--------|-------|
| Backend: {service} | COMPLETED/BLOCKED/SKIPPED/FAILED | {reason if not COMPLETED} |
| Frontend | COMPLETED/BLOCKED/SKIPPED/FAILED | {reason if not COMPLETED} |
| Mock | COMPLETED/BLOCKED/SKIPPED/FAILED | {reason if not COMPLETED} |
```

Pass this status summary to the assessor so it knows which repos to assess and which to flag as blockers.

#### Assessor dispatch — E1 slim input set

The assessor is a cross-repo integration judge, not a re-reviewer. The per-repo code reviewers (Phase 5.5) + fix round already verified craft, spec compliance per repo, and requirements coverage per repo. The assessor's **unique value** is the cross-repo view — wire shapes match, role gating symmetric, event/infra wiring aligns.

To keep token cost proportional to that value, **pass only these inputs** (do NOT pass `platform.md`, `audit-findings.md`, or full task bodies — the assessor doesn't need to re-derive architecture):

1. **Status summary table** (from pre-check above)
2. **Phase 3 spec diffs** file path: `{run_dir}/outputs/phase-3-diffs.md` (lists what changed in each spec)
3. **Phase 5.5 code-review report** path: `{run_dir}/outputs/phase-5-5-code-review.md` (findings + fix-round outcomes)
4. **Updated spec file paths** — one per affected service (the assessor reads them directly to verify wire shapes)
5. **Files-modified list per repo** — extract from the scratchpad's Implementation Tasks "Files Changed" column. This lets the assessor target its reads to what actually changed, not the whole repo.
6. **Endpoint inventory** — a flat list of `method path → DTO` entries extracted from the spec diffs. Pre-compute this in the orchestrator from Phase 3 output; the assessor uses it as its wire-shape checklist.
7. **Recurring cross-repo gap checklist** — IF `{workspace_root}/{slug}/context/cross-repo-checklist.md` exists, pass its **contents**. It is a small, bounded, curated list of gap *classes* this workspace has hit before (written by `/learn` from prior assessor findings); the assessor folds it into its plan at Step 1.5 to check those classes proactively. This is a deliberately separate sidecar — passing it does **not** breach the "no `platform.md`" rule below, because the whole point of the sidecar is to stay small and assessor-only. Skip this input if the file doesn't exist yet.

Do NOT pass requirements or architecture files in the prompt. The assessor is forbidden from re-reading them — if it needs a specific FR/EC detail, it reads the `phase-5-5-code-review.md` which already maps findings to requirements. This is a deliberate scope narrowing.

#### Dispatch

Launch the `{slug}-assessor` agent (published by onboarding Phase C Step 3 to `~/.claude/agents/`). If it does not exist, fall back to `subagent_type: general-purpose` with a preamble that reads `{workspace_root}/{slug}/agents/assessor.md` — and log a warning prompting `/discover --resume --workspace={slug}` to publish workspace agents.

**Tool**: `Agent`
**subagent_type**: `{slug}-assessor` (substitute actual slug, e.g., `dal-assessor`)
**description**: `"Cross-repo assessment — {feature-slug}"`

```
Assess cross-repo integration for feature "{feature_summary}".

IMPLEMENTATION TASK STATUSES:
{status summary table from pre-check above — CRITICAL: check this FIRST; BLOCKED or FAILED tasks cannot be PASS}

INPUT FILES (read these yourself via Read tool — do NOT request re-reads of platform.md or task bodies; scope is narrowed to these files):
- Phase 3 spec diffs: {run_dir}/outputs/phase-3-diffs.md
- Phase 5.5 code review + fix-round report: {run_dir}/outputs/phase-5-5-code-review.md

UPDATED SPEC FILES (read to verify wire shapes):
{list spec file paths for each affected service}

FILES CHANGED (target your reads to these):
{for each COMPLETED task in the scratchpad:}
  - {repo}: {files-changed list from scratchpad column}

ENDPOINT INVENTORY (pre-computed from spec diffs — use as your wire-shape checklist):
{flat list: method path → response DTO | request DTO}

{if {workspace_root}/{slug}/context/cross-repo-checklist.md exists, include:}
RECURRING CROSS-REPO GAP CHECKLIST (gap classes this workspace has shipped before — check each proactively per Step 1.5):
{paste the contents of context/cross-repo-checklist.md}

SCOPE: cross-repo integration only.
1. Wire shapes agree across backend ↔ frontend ↔ mock for every endpoint in the inventory.
2. Requirements surfaced by both sides of each wire are enforced consistently (e.g., a role gate on the server is mirrored by a frontend route guard).
3. Event/infra wiring aligns (queue names, bucket ARNs, event payload fields).
4. End-to-end story — trace each listed endpoint from UI action through API through persistence back to UI.

CRITICAL FOR THIS DISPATCH (do not skip):
- **Score constraint.** Score is PASS / PARTIAL / FAIL. **Cannot be PASS** if any task above is BLOCKED or FAILED, or if any critical cross-repo gap is unfixed. Default to FAIL on uncertainty — re-running is cheap; shipping a broken integration is not.
- **Save to `{run_dir}/assessment.md`.** Phase 7 reporter reads this file.
- **Walk every endpoint in the inventory above.** For each `method path → DTO`, verify wire-shape agreement across the affected sides (backend↔frontend↔mock). Missing one is a critical cross-repo gap.
- **Cross-repo focus only.** Do NOT re-review per-file craft (Phase 5.5 covered it), do NOT re-derive architecture from platform.md, do NOT re-inspect un-modified files, do NOT produce fix assignments for findings already addressed in the Phase 5.5 fix round.

Now: assess the cross-repo integration for "{feature_summary}" and reply with score + 3-5 sentence summary + any deployment-blockers.
```

Wait for the assessor to complete and present the report to the user.

---

#### Step 6.5: Live frontend verification (browser, via chrome-devtools MCP)

**Purpose:** static wire-shape agreement (Steps 2–5) proves the *types* line up; it does NOT prove the feature actually works in a browser. When the feature touched the frontend, drive a real Chrome against the running app to verify the FR use-cases end-to-end and that the UI's network calls reach the backend with the shapes/status the spec promises. This catches runtime breakage no static pass can: a route that white-screens, a mutation that 500s, a console error, a request body the backend rejects.

**Trigger (auto on frontend impact, opt-out):** run this step when ALL of these hold:
- A repo with `role: "frontend"` had a COMPLETED implementation task this run (frontend impact), AND
- `--no-browser-verify` was NOT passed.

If there was no frontend impact, skip silently. If `--no-browser-verify` was passed, log `"Step 6.5 skipped — --no-browser-verify"` and continue. `--browser-verify` forces the step even if frontend-impact detection is uncertain.

**Step 6.5a — Ensure the chrome-devtools MCP is available.**

```bash
node {plugin_dir}/scripts/ensure-mcp.js status --name=chrome-devtools
```

Read the JSON:
- `present:true, connected:true` → the tools are usable this session → proceed to Step 6.5b.
- `cli_available:false` → the `claude` CLI isn't on PATH; print one line ("can't manage MCP servers — chrome-devtools verification skipped") and skip to Step 6.5e (record skip). Do not fail the run.
- `present:false` (missing) → **inform the user and offer to install** (do NOT install silently):

  ```
  Step 6.5 wants to verify the frontend in a real browser, but the
  `chrome-devtools` MCP server isn't installed. It drives Chrome to
  exercise the new UI against the running app.

  Install it now?  (npx -y chrome-devtools-mcp@latest, local scope)
    yes  → install it
    no   → skip browser verification for this run
  ```

  On `no` → skip to Step 6.5e (record skip with reason `user-declined-mcp-install`). On `yes`:

  ```bash
  node {plugin_dir}/scripts/ensure-mcp.js install --name=chrome-devtools --cmd="npx -y chrome-devtools-mcp@latest" --scope=local
  ```

  The install returns `needs_restart:true` — **Claude Code only loads MCP servers at launch, so the tools are NOT usable in this running session.** Surface this and let the USER decide how to proceed (do not auto-pick):

  ```
  ✓ chrome-devtools MCP installed (local scope). It loads on the NEXT
    `claude` launch, so it can't run in this session.

  How do you want to proceed?
    continue → finish this run now WITHOUT browser verification. Re-run it
               later with:  /deliver --resume --workspace={slug} --browser-verify
               (after you restart Claude Code)
    wait     → I'll pause here. Restart Claude Code, then run
               `/deliver --resume --workspace={slug}` and Step 6.5 will run.
  ```

  On `continue` → skip to Step 6.5e (record skip with reason `mcp-installed-needs-restart`, and note the resume command in the scratchpad + Phase 7 report). On `wait` → set the scratchpad Status to `INTERRUPTED`, write a resume marker, emit `phase_end` for Phase 6 as partial, and stop the run cleanly with the restart instructions. (On the resumed run, Step 6.5a will see `connected:true` and proceed.)

**Step 6.5b — Resolve how to run the app.** Browser verification needs the frontend dev server and a backend it can call (the mock is the default target — it already mirrors every endpoint and needs no DB/cloud creds). Source the run commands in this precedence:
1. **Workspace config** — an optional `config.workspace.frontend_verify` block, if present:
   ```json
   "frontend_verify": {
     "frontend_cmd": "npm run dev",
     "frontend_cwd_repo": "abvi-pms-frontend",
     "base_url": "http://localhost:5173",
     "backend": "mock",                 // "mock" | "backend"
     "mock_cmd": "npm start",
     "mock_cwd_repo": "abvi-backends-mock",
     "ready_path": "/",                 // path to poll for readiness
     "routes": ["/alc/content-rating/tasks"]   // optional default routes to check
   }
   ```
2. **Inference** — if no block: frontend `frontend_cmd` from the frontend repo's `package.json` (`dev` script) at the Phase 5 worktree path; `base_url` from its Vite/Next default; mock command from the mock repo's `package.json` (`start`/`dev`). Read each repo's `CLAUDE.md` "Build & run" section for the authoritative command if present.
3. **Undeterminable** → skip to Step 6.5e with reason `app-run-cmd-unknown` and a one-line hint to add a `frontend_verify` block. Never guess a command that could mutate state.

Run the servers against the **Phase 5 feature worktrees** (so the new code is what's exercised), not the main checkouts.

**Step 6.5c — Start servers, wait for ready, then verify.** Start the mock (if `backend:"mock"`) and the frontend dev server as **background** Bash processes (`run_in_background: true`). Poll `base_url + ready_path` until it answers (cap ~60s); if it never comes up, skip to Step 6.5e with reason `app-failed-to-start` and include the last server log lines.

Once up, dispatch the assessor in **browser-verification mode** (the `{slug}-assessor` already ran the static pass; this is a focused second dispatch with the live URLs — it has the chrome-devtools MCP tools available). Prompt skeleton:

```
You are doing LIVE BROWSER verification for feature "{feature_summary}" using the chrome-devtools MCP tools (navigate_page, take_screenshot, evaluate_script, list_console_messages, list_network_requests, click, fill, etc.).

The app is running:
- Frontend: {base_url}
- Backend:  {mock base url} ({"mock mirror of the real API" | "real backend"})
- Auth/role note: this feature is gated to role {role}. If the app needs an authenticated session for that role, use the workspace's documented dev-login path (see {frontend repo}/CLAUDE.md); if you cannot reach an authenticated state, report it as a verification gap rather than guessing.

ROUTES / USE-CASES TO VERIFY (map each FR to a concrete UI action):
{for each FR the frontend owns: FR-id + the user action that exercises it, e.g.
 - FR-1: navigate {route}; confirm the task list renders with rows
 - FR-2: select 2 rows, click Claim; confirm the result dialog shows per-task outcomes
 - FR-4: select a row, click Download; confirm a network POST to /content-rating/tasks/download returns 200 application/zip}

FOR EACH use-case:
1. navigate / interact via the MCP tools.
2. take_screenshot at the key state.
3. list_console_messages — ANY error-level console message is a finding.
4. list_network_requests — confirm the expected request fired, hit the right path, sent the spec-shaped body, and got the expected status. A 4xx/5xx on a happy-path action is a CRITICAL cross-repo finding (the UI and backend disagree at runtime).
5. Note any white-screen, unhandled rejection, missing element, or stuck loading state.

OUTPUT: append a "## Live Frontend Verification" section to {run_dir}/assessment.md with, per use-case: PASS/FAIL, the screenshot path, console findings, and the observed network call (method path → status). Then give a verification verdict: VERIFIED / ISSUES-FOUND / COULD-NOT-VERIFY (+reason). Do NOT fix anything — findings only.
```

Capture screenshots under `{run_dir}/review/browser/`.

**Step 6.5d — Tear down.** Stop the background frontend + mock processes you started (kill the Bash background tasks). Leave nothing running.

**Step 6.5e — Fold into the score.** Read the assessor's verification verdict:
- `VERIFIED` → note it in the assessment; no score change.
- `ISSUES-FOUND` → the live findings join the cross-repo gap list below. A happy-path 4xx/5xx or a white-screen is a CRITICAL gap → the overall Phase 6 score cannot be PASS until fixed (route the fixes through the same fix-dispatch flow below).
- `COULD-NOT-VERIFY` / skipped (any 6.5a/6.5b reason) → record the reason in `assessment.md` and the scratchpad; this does NOT by itself fail the run (static assessment still stands), but surface it plainly so the user knows browser verification did not happen and how to run it (`--browser-verify`).

Emit `agent_start`/`agent_end` for the browser-verification dispatch like any other, with `phase: "6"`, `stage: "browser-verify"`.

---

**If the assessor found cross-repo issues not caught by Phase 5.5** (static OR the Step 6.5 live verification), ask: "Should I dispatch fix-round agents to address these?"

If yes, dispatch fixes via the **same `Agent` tool pattern as Phase 5** — one `Agent` call per repo that has fixes, all in a single assistant message so they run in parallel. Use the same generic implementer agents (`spring-boot-implementer`, `react-implementer`, `cdk-stack-implementer`, `mock-implementer`). **Include the requirement reference (FR-X / EC-X) from the assessor's fix assignment** in each fix prompt so the agent can map fixes back to requirements.

Fixes must be applied to the existing feature worktrees from Phase 5 — never on main. If a worktree is missing (cleanup happened), recreate it with `Bash`: `cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} feature/{feature-slug}`. If `--no-worktrees` was passed, apply fixes on the current branch of each repo.

**Fix prompt template** (use for every fix dispatch):

```
You are applying fixes in the {tech-type} worktree at {worktree_path} (branch: feature/{feature-slug}). Work directly in this worktree — do NOT create a new worktree or switch branches.

First read {worktree_path}/CLAUDE.md to confirm the repo's conventions.

FIX LIST from cross-repo assessment:

## Fix 1 — {short title} ({CRITICAL|NON-CRITICAL})
**File**: {path:line}
**Requirement**: {FR-X / EC-X}
**Problem**: {one sentence describing what's wrong}
**Change**: {exact code change or behavior the fix should produce}

## Fix 2 — ...

[Repeat for every fix in this repo.]

After applying all fixes, run {repo's test command — mvn test / npm test -- --run / npm run build} and report pass/fail.

If any existing test fails because it relied on the old (buggy) behavior, update those tests — the fix is correct.

Report: files modified (with what changed), test results, FR/EC coverage map (which file:line enforces each requirement after the fix).

Do not touch any other feature or make any changes outside this fix list.
```

Wait for all fix dispatches to complete. If there were critical cross-repo issues, re-run the assessor (same `Agent` call as the first pass) to verify the fixes.

**Update scratchpad**: Set Phase 6 Status to COMPLETED. Record score and fix rounds.

---
