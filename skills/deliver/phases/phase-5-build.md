---

### Phase 5: Parallel Implementation

All implementer work is dispatched **via the `Agent` tool in the current session** using the generic per-repo-type agents from the `feature-pipeline` plugin. No `claude -p` subprocesses. No subprocess auth propagation. No shell-escaping gotchas.

**WORKTREE RULE**: Every **repo** that will be modified needs a feature worktree, unless `--no-worktrees` was passed. The orchestrator creates worktrees **before** dispatching any agents. Agents are launched with the worktree path as their working directory. They never touch the main repo checkout.

**If `--no-worktrees` was passed**: skip Step 0 below entirely. Agents work on the current branch of each repo. Log once at the top of Phase 5: "Phase 5 working in-place on each repo's current branch — no worktrees per flag." Downstream fix-rounds and Phase 5.5 reviewers inherit the same in-place mode.

**REUSE FROM PHASE 3**: If Phase 3 already created worktrees for spec-owning repos (see the `spec_worktrees` map in the scratchpad's Architecture Flags), reuse those. For repos that did NOT have specs edited (e.g., frontend, mock, infra), create new worktrees in Step 0 using the same naming pattern.

**MONOREPO RULE**: If multiple services share the same repo (detected by comparing `config.services[*].repo` values), create **one worktree** for that repo and dispatch implementer tasks for those services **sequentially, not in parallel** — parallel writes to the same worktree cause file conflicts. The task files already track which service each task covers, so each implementer knows its scope even though they share a worktree. Log: "Services {A}, {B} share repo {repo-name} — dispatching sequentially."

**PARALLELISM**: Multiple `Agent` tool calls in a single assistant message run concurrently, but **only for tasks targeting different repos**. Tasks sharing a repo run sequentially. 5a/5c/5d and the UX half of 5b can all be dispatched in one message if they target different repos.

**CONTEXT HYGIENE**: After dispatching all Phase 5 agents, do NOT re-reference Phase 1/2 outputs from conversation history. Use the scratchpad output files.

**ON COMPLETION**: As each agent returns, immediately update the scratchpad — set task status to COMPLETED (or FAILED), record the worktree path, and list the files that changed.

**COMMIT PER TASK** (do this at the same moment, only for a COMPLETED task): commit that task's work as **one logical commit** in its working dir, so each repo's branch reads as one commit per Phase-5 task and its PR is reviewable commit-by-commit. This is also the *only* clean boundary at which a task's changes are isolated: once the next task runs in the same worktree (monorepo) or a 5.5 fix round edits the files, the boundary is gone. Reconstructing per-task commits later in Phase 8 is not reliable — commit here.

```bash
# working dir = the task's worktree (or the repo's current branch under --no-worktrees)
git -C {working_dir} add -A
git -C {working_dir} commit -q -m "feat({repo-short}): {task-title} [{task-id}]"
```

- **One commit per task.** A repo with a single task → one commit; a monorepo with N sequential tasks → N commits on that repo's branch, in task order.
- **Nothing to commit** (agent made no file changes, or FAILED) → skip the commit; note it in the scratchpad. Never commit an empty or partial/failed task.
- **`{repo-short}`** is the repo's short tag from `config.json` (same token Phase 8 uses in PR titles); **`{task-id}`** is the task file id so the commit traces back to the plan.
- Record the commit SHA in the scratchpad's Implementation Tasks row alongside files-changed.

#### Step 0: Create worktrees

Skip this step entirely if `--no-worktrees` was passed.

Before any agent is dispatched, create one worktree per **distinct repo** that will be touched. Build the repo list from the Phase 4.5 task table — deduplicate by repo path.

```bash
{for each distinct repo_path in the task list:}
# Reuse Phase 3 worktree if already present
if [ -d "../{repo-name}-{feature-slug}" ]; then
  echo "worktree already exists for {repo-name} — reusing"
else
  cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} -b feature/{feature-slug}
fi
```

Skip worktrees for repos whose phases are all skipped. If a worktree already exists (from Phase 3 or from resume), leave it alone.

Verify each worktree was created before dispatching agents against it: run `git -C {worktree_path} status` and confirm it exits cleanly. If a worktree is missing, stop and report — do not dispatch an agent to a missing path. Record all confirmed worktree paths in the scratchpad Implementation Tasks table so Phase 5.5 reviewers and Phase 6 assessor can locate them.

#### Phase 5a: Backend + Workers (skip if --frontend-only)

**Use the lean task-ID dispatch template from Phase 4.5.** The backend task file created in Phase 4.5 already contains the full feature summary, sub-task checklist, FR/EC list, data model, API design (or inline endpoint contract for code-first services), event schemas (for no-api worker services), endpoint list, and worktree path. The implementer reads the task file once and operates from it — nothing needs to be forwarded from the orchestrator's context.

Pull the structured services list from the architect's output (do NOT LLM-parse the prose Notes):

```bash
node {plugin_dir}/scripts/extract-block.js outputs/phase-2-architecture.md AFFECTED_SERVICES
```

For each entry in `services[]`, pick the implementer dynamically from the repo's `type` via the `TYPE_TO_AGENT` mapping in `phases/dispatch-rules.md`. Do **NOT** hardcode `spring-boot-implementer` — services may be any of spring-boot / fastapi / nestjs / flask / django / python-worker (or future additions).

Lookup rule, per service:
1. Resolve `config.repos[config.services[svc].repo].type`
2. Map to `subagent_type` via the dispatch-rules table:
   - `spring-boot` → `spring-boot-implementer`
   - `fastapi` → `fastapi-implementer`
   - `nestjs` → `nestjs-implementer`
   - `flask` → `flask-implementer`
   - `django` → `django-implementer`
   - `python-worker` → `python-worker-implementer` (spec_policy is always `no-api`; the task file references event schemas edited in Phase 3a)
   - `other` → skip with a scratchpad note — no implementer available

**Tool**: `Agent`
**subagent_type**: {looked up per service from the table above}
**description**: Short role-based name, e.g., `"Publisher backend — book content upload"` or `"Order events worker — new contractId field"`
**prompt**: the canonical task-ID dispatch template (see Phase 4.5) with the appropriate task file path and worktree path substituted. Do **NOT** inline data model, API design, requirements, spec content, or event schemas — the task file holds all of it.

Dispatch one `Agent` call per affected service. All of them go in the same assistant message as Phase 5c and Phase 5d and the UX half of 5b so they run in parallel (subject to the monorepo-sequential rule above).

**On completion** (agent returns): update the scratchpad — task status COMPLETED, worktree path, files changed. The agent is responsible for flipping its own task file from `status: todo` to `status: done`.

#### Phase 5b: Frontend (skip if --backend-only) — Two-step dispatch

Phase 5b runs in two steps: UX consultant first (output gated on user approval), then feature implementer.

**Step 1: Extract context** from the scratchpad output files.

Read `outputs/phase-1-requirements.md` and extract the frontend-relevant sections. **Do NOT `Read outputs/phase-2-architecture.md`** — pull the frontend-relevant blocks directly from `outputs/blocks/`:

```bash
# Structured FRONTEND_ARCHITECTURE — components / routes / api_integration
cat {run_dir}/outputs/blocks/frontend-architecture.json

# Raw FRONTEND_ARCHITECTURE markdown for the prose (state management, i18n, styling)
node {plugin_dir}/scripts/extract-block.js {run_dir}/outputs/phase-2-architecture.md FRONTEND_ARCHITECTURE --raw

# API surface the frontend will hit
cat {run_dir}/outputs/blocks/api-design.json
```

The JSON carries the navigable index (components, routes, api_integration) — pass it to the UX consultant + implementer as structured input. The `--raw` markdown carries the prose under the JSON (state management strategy, i18n keys, styling notes) — pass that alongside as supplementary context.

**Step 2: UX Consultant**

Dispatch the base plugin UX consultant `pipecrew:ux-consultant` in its default **design mode** (no `MODE:` line needed). It is **not** workspace-generated — it's the same rich, framework-agnostic agent that authored the design system in `/discover` Phase B3 (discovery mode), now consuming it. It reads `{repo_path}`'s design system (`agent-context/common/DESIGN_SYSTEM.md`) + `platform.md` and discovers the frontend's component library + storybook at invocation time — do NOT hardcode paths in the prompt. This agent is read-only — no worktree, no writes — and can run in parallel with Phases 5a/5c/5d in the same assistant message.

**Tool**: `Agent`
**subagent_type**: `pipecrew:ux-consultant`
**description**: `"Frontend UX recommendations — {feature-slug}"`
**prompt template**:

```
Provide UX recommendations for this feature. Research and recommendations only — do not implement, do not create a worktree.

TARGET REPO: {frontend.path}

FEATURE: {feature_summary}

REQUIREMENTS:
{extracted frontend-relevant sections from Phase 1}

FRONTEND ARCHITECTURE (from solution architect):
{extracted FRONTEND_ARCHITECTURE section from Phase 2}

ENDPOINTS TO INTEGRATE (exact spec field names — do NOT rename):
{list of endpoints with the exact request/response field names from the spec}

INSTRUCTIONS:
1. Read {frontend.path}/CLAUDE.md first to learn the project name, tech stack, user roles, and where the detailed docs live.
2. Follow CLAUDE.md's pointers to find the design system docs (typically under agent-context-v2/common/ or agent-context/common/). Read them.
3. Find and read the storybook foundation stories (src/stories/**/*.stories.tsx) — Colors, Typography, Spacing at minimum. Read component stories on demand.
4. Read 2-4 existing feature docs under agent-context-v2/features/ or agent-context/features/ for features similar to what you're designing.
5. Produce the consultation in the format your system prompt specifies, including the IMPLEMENTATION_SPEC block delimited by <!-- BEGIN IMPLEMENTATION_SPEC --> and <!-- END IMPLEMENTATION_SPEC -->.

Your recommendations must use actual tokens, primitives, and patterns from what you read — not generic UX advice. Match established patterns from existing features unless there is a strong reason to deviate (which you must call out explicitly).

CRITICAL FOR THIS DISPATCH (do not skip — these are the rules most often forgotten):
- **Emit IMPLEMENTATION_SPEC block.** The dispatch's downstream consumer (Phase 5b Step 3 frontend implementer) reads `<!-- BEGIN IMPLEMENTATION_SPEC --> ... <!-- END IMPLEMENTATION_SPEC -->` from your output and appends it to the task file. Missing block = the implementer has no UX direction and falls back to whatever it invents.
- **Read-only.** Do not Edit, Write, or run state-mutating commands. Do not create a worktree. Your output is the recommendation only.
- **Use only what you read.** Tokens, primitives, component names, and i18n key conventions must come from the actual design system + storybook + existing feature docs you read above. No invented primitives, no generic Tailwind / Material advice the repo doesn't already use.
- **Cite established patterns.** When you recommend a pattern, name the existing feature you're matching (e.g., "follow the row-actions pattern from `agent-context/features/orders.md`"). When you deviate, explain *why* in one sentence.
- **Spec field names are non-negotiable.** Endpoints' request/response field names above are the contract. Do not rename them in your recommendation.

Now: produce UX recommendations for the feature in `{frontend.path}` and emit the IMPLEMENTATION_SPEC block in the format your system prompt specifies.
```

**After**: Present UX summary to user. Wait for approval.

**UX Approval Gate**: Show key UX decisions, deviations from standard patterns, and anything the user should weigh in on. Ask: "Approve UX recommendations to proceed with frontend implementation?"

**Step 2.5**: Refine frontend sub-tasks in the scratchpad if the UX spec introduced new components or changes.

**Step 3: Feature Implementer**

**Append the UX `IMPLEMENTATION_SPEC` into the existing frontend task file** before dispatching. Open the frontend task file from `~/.claude/dal-pipeline/tasks/` (created in Phase 4.5) and add the extracted `<!-- BEGIN IMPLEMENTATION_SPEC --> ... <!-- END IMPLEMENTATION_SPEC -->` block at the end of the body (or replace any placeholder the task file already reserved for it). This is the **only** piece of new information that enters the task file at Phase 5b — the UX consultant produces it in the same phase, so it wasn't available when Phase 4.5 wrote the initial task.

Then use the lean task-ID dispatch template from Phase 4.5:

**Tool**: `Agent`
**subagent_type**: looked up by the frontend repo's `type` via the `TYPE_TO_AGENT` table in `dispatch-rules.md` (`react` → `react-implementer`, `nextjs` → `nextjs-implementer`). Resolve via `config.repos` where `role === "frontend"`. Do **NOT** hardcode `react-implementer` — workspaces with a Next.js frontend must dispatch `nextjs-implementer`.
**description**: `"Frontend implement — {feature-slug}"`
**prompt**: the canonical task-ID dispatch template (see Phase 4.5) with the frontend task file path and worktree path substituted. Do **NOT** inline requirements, frontend architecture, endpoints, or the IMPLEMENTATION_SPEC — all of it is in the task file the agent will read first.

**On completion**: update the scratchpad. The implementer flips its task file from `status: todo` to `status: done`.

#### Phase 5c: Mock Server (skip if --no-mock or --backend-only)

Dispatch in the same message as Phases 5a, 5d, and the UX half of 5b.

**Use the lean task-ID dispatch template from Phase 4.5.** The mock task file carries the endpoint list, response shapes (from API_DESIGN), worktree path, seed data hints, and the spec-over-frontend rule. The orchestrator does not forward any of this in the prompt.

**Tool**: `Agent`
**subagent_type**: `mock-implementer`
**description**: `"Mock endpoints — {feature-slug}"`
**prompt**: the canonical task-ID dispatch template (see Phase 4.5) with the mock task file path and worktree path substituted.

**On completion**: update the scratchpad. The implementer flips its task file from `status: todo` to `status: done`.

#### Phase 5d: Infrastructure (only if architect flagged or --with-infra)

Extract `<!-- BEGIN INFRASTRUCTURE_IMPACT -->` section. Dispatch in the same message as 5a, 5c, and the UX half of 5b.

For each repo with `role: infrastructure` that the architect flagged as affected, pick the implementer from the repo's `type`:
- `cdk` → `cdk-stack-implementer`
- `terraform` → `terraform-implementer`

If the feature touches multiple infra repos of different types (e.g., one CDK stack repo + one Terraform repo), dispatch one Agent call per repo, each with its matching implementer. These are independent so they can run in parallel.

**Tool**: `Agent`
**subagent_type**: {looked up per infra repo — `cdk-stack-implementer` or `terraform-implementer`}
**description**: `"Infra ({cdk|terraform}) — {feature-slug}"`

**Use the lean task-ID dispatch template from Phase 4.5.** The infra task file carries the `INFRASTRUCTURE_IMPACT` block, cross-stack reference list, naming conventions, worktree path, and build verification commands (which differ per tool: `cdk synth` + `cdk diff` for CDK; `terraform fmt` + `terraform validate` + `terraform plan` for Terraform). The orchestrator does not forward any of this in the prompt.

**prompt**: the canonical task-ID dispatch template (see Phase 4.5) with the infra task file path and worktree path substituted.

**Terraform-specific**: the terraform-implementer is instructed to NEVER run `terraform apply`. Its deliverable is the plan output, which the user reviews at Phase 5.5 or at the Phase 7 PR stage before a human applies it.

**On completion**: update the scratchpad. The implementer flips its task file from `status: todo` to `status: done`.

#### After all Phase 5 agents complete

**Phase 5 is complete when every task file shows `status: done` or `status: failed` (none remain `todo` or `in_progress`).** For any task that returned FAILED, capture the reason in the scratchpad but continue — Phase 6 assessor will flag it as a blocker. **Update scratchpad**: Set Current Phase to "Phase 5.5: Code Review".

---
