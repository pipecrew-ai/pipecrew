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

Verify each worktree was created before dispatching agents against it. Record worktree paths in the scratchpad Implementation Tasks table so Phase 5.5 reviewers and Phase 6 assessor can locate them.

#### Phase 5a: Backend + Workers (skip if --frontend-only)

**Use the lean task-ID dispatch template from Phase 4.5.** The backend task file created in Phase 4.5 already contains the full feature summary, sub-task checklist, FR/EC list, data model, API design (or inline endpoint contract for code-first services), event schemas (for no-api worker services), endpoint list, and worktree path. The implementer reads the task file once and operates from it — nothing needs to be forwarded from the orchestrator's context.

For each service in the architect's `AFFECTED_SERVICES` list, pick the implementer dynamically from the repo's `type` via the `TYPE_TO_AGENT` mapping in `phases/dispatch-rules.md`. Do **NOT** hardcode `spring-boot-api-implementer` — services may be any of spring-boot / fastapi / nestjs / flask / django / python-worker (or future additions).

Lookup rule, per service:
1. Resolve `config.repos[config.services[svc].repo].type`
2. Map to `subagent_type` via the dispatch-rules table:
   - `spring-boot` → `spring-boot-api-implementer`
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

Read `outputs/phase-1-requirements.md` and extract the frontend-relevant sections.
Read `outputs/phase-2-architecture.md` and extract `<!-- BEGIN FRONTEND_ARCHITECTURE -->`.

**Step 2: UX Consultant**

Dispatch the workspace-specific UX consultant agent `{slug}-ux-consultant`, published by onboarding to `~/.claude/agents/` (see onboard Phase C Step 3). This agent is read-only — it does not create a worktree or write any files, and it can run in parallel with Phases 5a/5c/5d in the same assistant message. The agent reads the workspace's `design-system.md` and discovers the frontend's component library + storybook at invocation time — do NOT hardcode paths in the prompt.

**Fallback**: if `~/.claude/agents/{slug}-ux-consultant.md` does not exist, fall back to `subagent_type: pipecrew:ux-consultant` (the framework-agnostic plugin version). Log the fallback and suggest `/discover --resume --workspace={slug}` to publish workspace agents.

**Tool**: `Agent`
**subagent_type**: `{slug}-ux-consultant` (substitute actual slug, e.g., `dal-ux-consultant`)
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
```

**After**: Present UX summary to user. Wait for approval.

**UX Approval Gate**: Show key UX decisions, deviations from standard patterns, and anything the user should weigh in on. Ask: "Approve UX recommendations to proceed with frontend implementation?"

**Step 2.5**: Refine frontend sub-tasks in the scratchpad if the UX spec introduced new components or changes.

**Step 3: Feature Implementer**

**Append the UX `IMPLEMENTATION_SPEC` into the existing frontend task file** before dispatching. Open the frontend task file from `~/.claude/dal-pipeline/tasks/` (created in Phase 4.5) and add the extracted `<!-- BEGIN IMPLEMENTATION_SPEC --> ... <!-- END IMPLEMENTATION_SPEC -->` block at the end of the body (or replace any placeholder the task file already reserved for it). This is the **only** piece of new information that enters the task file at Phase 5b — the UX consultant produces it in the same phase, so it wasn't available when Phase 4.5 wrote the initial task.

Then use the lean task-ID dispatch template from Phase 4.5:

**Tool**: `Agent`
**subagent_type**: `react-feature-implementer`
**description**: `"Frontend implement — {feature-slug}"`
**prompt**: the canonical task-ID dispatch template (see Phase 4.5) with the frontend task file path and worktree path substituted. Do **NOT** inline requirements, frontend architecture, endpoints, or the IMPLEMENTATION_SPEC — all of it is in the task file the agent will read first.

**On completion**: update the scratchpad. The implementer flips its task file from `status: todo` to `status: done`.

#### Phase 5c: Mock Server (skip if --no-mock or --backend-only)

Dispatch in the same message as Phases 5a, 5d, and the UX half of 5b.

**Use the lean task-ID dispatch template from Phase 4.5.** The mock task file carries the endpoint list, response shapes (from API_DESIGN), worktree path, seed data hints, and the spec-over-frontend rule. The orchestrator does not forward any of this in the prompt.

**Tool**: `Agent`
**subagent_type**: `mock-endpoint-implementer`
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

Wait for every dispatched agent to return. For any task that returned FAILED, capture the reason in the scratchpad but continue — Phase 6 assessor will flag it as a blocker. **Update scratchpad**: Set Current Phase to "Phase 5.5: Code Review".

---
