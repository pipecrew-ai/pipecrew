### Phase 4: Sync Specs

**Default: OFF.** Phase 4 only runs when the user explicitly opted in at the Phase 3 approval gate. Read `spec_sync_opt_in` from the scratchpad's Architecture Flags section.

**Skip conditions** (any of these → skip the phase):
- `spec_sync_opt_in` is `no` or unset → log `"Phase 4 skipped — user did not opt in at the Phase 3 gate."`
- No repo has `spec_copies` entries referencing any affected service → log `"Phase 4 skipped — no sync targets exist."` (this case should already have been caught at the Phase 3 gate, which suppresses the follow-up question; the skip-check here is defensive.)

When NOT skipped, for each affected service, find all repos that have `spec_copies` entries referencing that service, and copy the updated spec:

```bash
# For each repo that has spec_copies:
{for each repo in config.repos where repo.spec_copies exists:}
  {for each [service_key, relative_path] in repo.spec_copies:}
    {if service_key is in the affected services list:}
      cp {config.repos[config.services[service_key].repo].path}/{config.services[service_key].spec_file} {repo.path}/{relative_path}
```

Report which repos received which spec copies.

**Update scratchpad**: Set Phase 4 Status to COMPLETED (or SKIPPED with the specific reason from the skip-conditions above). Set Current Phase to "Phase 4.5: Implementation Plan".

---

### Phase 4.5: Implementation Plan + Context Budget

Build the implementation task list from the architect's output + workspace config.

Phase plan comes from rule #2 — read it from the scratchpad's Architecture Flags section. Create tasks only for running phases, based on the architect's `AFFECTED_SERVICES` block + the repo map.

**Pull the structured services list once at the top of this phase** — do NOT LLM-parse the prose under the block:

```bash
node {plugin_dir}/scripts/extract-block.js outputs/phase-2-architecture.md AFFECTED_SERVICES
```

Returns `{services: [{name, spec_policy, endpoints_added, endpoints_modified, handlers_added, fr_ids, ec_ids}], spec_edit_order, frontend_required, mock_required}`. Use this for every per-service decision below (which task files to create, which sub-tasks to seed, what `frontend_required` / `mock_required` say). Schema in `{plugin_dir}/docs/file-formats.md`.

CLI flag combinations:
- Phase 5a runs if: spec was edited OR architect listed affected services AND `--frontend-only` not passed
- Phase 5b runs if: `frontend_required = Yes` AND `--backend-only` not passed
- Phase 5c runs if: `mock_required = Yes` AND `--no-mock` not passed AND `--backend-only` not passed

**Context budget check**: Estimate the token count of each output file. If Phase 5b combined input (requirements + frontend architecture + agent prompts) exceeds ~30K tokens, warn the user and suggest compressing the requirements further.

**Update scratchpad**: Populate the Implementation Tasks table with all tasks that will run (status: PENDING). Set any skipped tasks to SKIPPED with reason. Record context budget estimates.

**Create sub-task breakdown for EACH implementation task** — not just frontend. Break down based on the architecture output.

**Mark each sub-task `M` (Minimum) or `D` (Deferrable):**

- **`M` — Minimum** — needed to ship the feature in its smallest useful form. The user can validate the feature's value with just the M slice running.
- **`D` — Deferrable** — extras the feature could ship without. Source of truth: the architect's `## Risks & Trade-offs` section. Any sub-bullet labelled "deferred" / "out of scope" / "follow-up" / "v2" / "enhancement" goes here. Bullets the requirements doc tagged as nice-to-haves (not core FRs) also go here.

If the architect's design has no `## Risks & Trade-offs` section or it lists no deferrables, mark every sub-task `M` — the entire plan is the minimum, and the gate below collapses to its 2-option form.

#### Backend sub-task breakdown template (per service):
```
Backend: {service}
  [M] 1. DTOs / Models — request/response DTOs matching spec schemas
  [M] 2. Repository — new/modified repository methods
  [M] 3. Service layer — business logic for each M endpoint
  [M] 4. Controller — REST endpoints matching spec paths (read endpoints first; only the writes the M slice needs)
  [M] 5. Tests — unit (service) + integration (controller)
  [M] 6. Run tests — mvn test (or repo equivalent)
  [D] 7. {Optional write endpoint flagged by architect} — cite RISKS sub-bullet
  [D] 8. {Optional async / event-side enhancement} — cite RISKS sub-bullet
```

#### Frontend sub-task breakdown template:
```
Frontend:
  [M] 1. API layer — types, endpoint constants, service methods, error classes for M endpoints
  [M] 2. Hooks — React Query hooks for M endpoints
  [M] 3. Core components — badges, table columns, shared UI for M flows
  [M] 4. Page + routing — page, route, role guard
  [M] 5. i18n — translation keys in every language the workspace configures (per stacks/{type}.md)
  [M] 6. Tests — unit + integration for the M slice
  [D] 7. Detail view — {rich detail dialog, if architect flagged}
  [D] 8. Action buttons — {claim/reject/approve, if architect flagged}
  [D] 9. Agent context update — only if a new pattern was introduced (per R5)
```

#### Mock sub-task breakdown template:
```
Mock:
  [M] 1. Mock data — realistic mock data for M endpoints
  [M] 2. Endpoint handlers — route handlers for M endpoints
  [D] 3. Filters / pagination — only if a D endpoint needs them
```

Present the plan to the user as **two slices per repo** — Minimum, then (if any) Deferrable:

```
## Implementation Plan

### Feature: {feature name}
### Service(s): {list}

### Backend: {service} ({service.repo}) — Minimum slice
| # | Sub-Task | Status |
|---|----------|--------|
| 1.M.1 | DTOs / Models — {N} DTOs | PENDING |
| 1.M.2 | Repository — {summary} | PENDING |
| 1.M.3 | Service layer — {summary} | PENDING |
| 1.M.4 | Controller — {N} endpoints | PENDING |
| 1.M.5 | Tests | PENDING |

### Backend: {service} ({service.repo}) — Deferrable
(Skip this table if the repo has no deferrables.)
| # | Sub-Task | Why deferrable |
|---|----------|----------------|
| 1.D.1 | {bulk-update endpoint} | architect RISKS bullet — "low v1 usage" |
| 1.D.2 | {audit-log integration} | architect RISKS bullet — "follow-up after compliance review" |

### Frontend ({frontend.repo}) — Minimum slice
| # | Sub-Task | Status |
|---|----------|--------|
| 2.M.1 | API layer | PENDING |
| 2.M.2 | Hooks | PENDING |
| 2.M.3 | Core components | PENDING |
| 2.M.4 | Page + routing | PENDING |
| 2.M.5 | i18n ({languages from workspace stacks/{type}.md}) | PENDING |
| 2.M.6 | Tests | PENDING |

### Frontend ({frontend.repo}) — Deferrable
(Skip if no deferrables.)
| # | Sub-Task | Why deferrable |
|---|----------|----------------|
| 2.D.1 | {detail view} | architect RISKS bullet — "v2 enhancement" |

### Mock ({mock.repo}) — Minimum slice
| # | Sub-Task | Status |
|---|----------|--------|
| 3.M.1 | Mock data | PENDING |
| 3.M.2 | Endpoint handlers | PENDING |

### Mock ({mock.repo}) — Deferrable
(Skip if no deferrables.)

### Context Budget
- Requirements on disk: ~{N} tokens | Architecture on disk: ~{N} tokens
- Avg task file: ~{N} tokens | Max task file: ~{N} tokens (task {id})
- Total Minimum tasks: {N_M} | Total Deferrable tasks: {N_D}
- Each dispatch loads only the task file it's given — per-dispatch input ≈ (task file size + 2K boilerplate)

### Skipped
- {Phase}: {reason}

How do you want to proceed?
  1. Approve all   — run Minimum + Deferrable in this pipeline
  2. Minimum only  — run Minimum now; write Deferrable to a follow-up file the next /deliver can pick up
  3. Adjust        — push back on specific sub-tasks before approving
```

If the run has zero `D` sub-tasks (architect flagged nothing), collapse the gate to the 2-option form ("Approve / Adjust") and skip the deferred-file step below.

**If the user picks "Adjust"**: ask which sub-tasks they want to change (natural language is fine — e.g., "move item 1.D.1 to minimum", "drop 2.D.2 entirely", "split 1.M.3 into two steps"). Apply the changes, re-present the updated plan with the same table format, and repeat the gate prompt. Do NOT re-run Phase 1 or Phase 2.

**Include only the slice the user approved** in each agent's prompt — the implementer never sees deferred sub-tasks for its repo.

**Wait for user approval.**

#### When user picks "Minimum only": write the deferred follow-up file

If the user answer was "Minimum only" (option 2), do this BEFORE creating any task files for Phase 5:

1. Make sure the directory exists: `mkdir -p {workspace_root}/{slug}/deferred`.
2. Compute the file path: `{workspace_root}/{slug}/deferred/{feature-slug}.md`.
3. If the file already exists, overwrite it AND log a warning: `"⚠ Overwriting existing deferred file at {path} — previous deferred slice for this feature is being replaced by this run's deferred slice."`
4. Write the file with this format:

```markdown
---
feature: {feature-slug}
source_run_id: {this run's run_id}
source_feature_description: "{original /deliver feature description string}"
created_at: {UTC ISO-8601 timestamp from `date -u +"%Y-%m-%dT%H:%M:%SZ"`}
status: pending      # flips to "consumed" by Phase 7 after a successful resume run
---

# Deferred follow-up: {feature name}

## Original feature description
{original feature description from `/deliver "..."`}

## Why these sub-tasks were deferred
The user approved only the Minimum slice at the Phase 4.5 gate of run `{source_run_id}`. The sub-tasks below were marked Deferrable by the architect (see `{source_run_id}/outputs/phase-2-architecture.md` `<!-- BEGIN RISKS -->`) and were not implemented in that run.

## Deferred sub-tasks (by repo)

### {repo-1.name} ({repo-1.type})
- {deferrable sub-task 1.D.1 — verbatim from the plan, including its "why deferrable" reason}
- {deferrable sub-task 1.D.2}

### {repo-2.name} ({repo-2.type})
- {deferrable sub-task 2.D.1}

## Functional requirements still relevant
(Filtered to FR/EC bullets the deferred sub-tasks were going to enforce. The product-owner refines on resume — some may have become moot, others may have grown.)

- FR-7: {original wording, copied from outputs/phase-1-requirements.md}
- FR-9: {original wording}
- EC-3: {original wording}

## Architecture context (pointers, not copies)
- Data model: `{workspace_root}/{slug}/runs/deliver/{source_run_id}/outputs/phase-2-architecture.md` `<!-- BEGIN DATA_MODEL -->`
- API design: same file, `<!-- BEGIN API_DESIGN -->`
- Risks / Trade-offs (where the deferred items are flagged): same file, `<!-- BEGIN RISKS -->`

## How to resume

```
/deliver --from-deferred={feature-slug}
```

Or just run any `/deliver` — pre-flight will list pending deferred items and offer to resume this one.

After a successful resume, this file's `status` flips to `consumed`. Consumed files are not surfaced by pre-flight; delete them manually to clean up.
```

5. After writing, log: `"Deferred slice written to {workspace_root}/{slug}/deferred/{feature-slug}.md — {N_D} sub-tasks across {repo_count} repos. Resume with /deliver --from-deferred={feature-slug}."`

Then proceed to Step 4 (create task files), but only for the **Minimum slice**. The deferred sub-tasks do NOT become Phase 5 task files — they live entirely in the follow-up file until a resume run picks them up.

---

#### Phase 4.5 — After approval: persist sub-tasks as markdown files

Once the user approves the plan, **persist each sub-task as a markdown file** under `~/.claude/dal-pipeline/tasks/` and replace the plan text in the scratchpad with an IDs-only table. This is where the context-lean contract starts paying off: the full plan body drops out of the orchestrator's live context and every downstream agent fetches its own sub-task on demand via the Read tool.

Read the feature slug from the scratchpad (set during Pre-flight).

**Step 1 — Pull the source material as side files, not full markdown.** Phase 1 emits `outputs/phase-1-requirements.md` (read it via the Read tool — it's the human-readable requirement narrative) and Phase 2 emits per-block JSON side files at `outputs/blocks/`. **Do NOT `Read outputs/phase-2-architecture.md`** — it can be 30k+ tokens of architect prose the planner mostly doesn't use. Instead `cat` the side files this phase needs:

```bash
cat {pipeline_dir}/outputs/blocks/affected-services.json
cat {pipeline_dir}/outputs/blocks/api-design.json
cat {pipeline_dir}/outputs/blocks/data-model.json
cat {pipeline_dir}/outputs/blocks/infrastructure-impact.json 2>/dev/null
```

These small JSON payloads stay in the orchestrator's context for the duration of Phase 4.5 task creation and are dropped afterward. If a section the planner needs is prose-only (e.g., FRONTEND_ARCHITECTURE, RISKS), use `extract-block.js --raw` to pull just that named section out without loading the whole file:

```bash
node {plugin_dir}/scripts/extract-block.js {pipeline_dir}/outputs/phase-2-architecture.md FRONTEND_ARCHITECTURE --raw
node {plugin_dir}/scripts/extract-block.js {pipeline_dir}/outputs/phase-2-architecture.md RISKS --raw
```

**Step 2 — Generate a batch of task IDs.** For the N sub-tasks in the plan, generate N task IDs up front so they can be referenced in sibling task bodies if needed. Run a Bash one-liner to produce N suffixes:

```bash
for i in $(seq 1 {N}); do openssl rand -hex 3; done
```

Capture the suffixes and combine with the feature slug to form the IDs: `{feature-slug}-{suffix}`. Example for a 4-sub-task feature: `book-content-upload-a1f2-7b3c9f`, `book-content-upload-a1f2-e84d12`, etc.

**Step 3 — For each sub-task, Write the task file directly.** Compose a single string containing the YAML frontmatter and the body, and use the Write tool to create `~/.claude/dal-pipeline/tasks/{task-id}.md`. No temp files. The Write tool returns success; the orchestrator captures nothing further because it already has the ID.

The YAML frontmatter template:

```yaml
---
id: {task-id}
feature: {feature-slug}
title: "{one-line title, e.g. 'Backend: publisher service — 6 endpoints'}"
status: todo
phase: "4.5"
severity: ""
repo: "{repo-name, e.g. abvi-publisher-service}"
requirement_refs: "{comma-separated FR/EC, e.g. FR-1,FR-2,FR-8,EC-4}"
file_refs: ""
created_at: {current UTC ISO-8601 timestamp}
updated_at: {same timestamp}
cumulative_duration_ms: 0
cumulative_total_tokens: 0
invocation_count: 0
last_worked_by: ""
---
```

The body (free-form markdown after the closing `---`) should contain everything the implementer would otherwise have received inline in its Phase 5 prompt:

- A one-sentence summary of what the sub-task delivers
- The sub-task checklist from the implementation plan (the numbered rows under "Backend: {service}" / "Frontend" / "Mock" / "Infra")
- The functional requirements (FR-X) and edge cases (EC-X) the implementer must enforce — extract from `outputs/phase-1-requirements.md`, only the ones relevant to this sub-task's repo
- The relevant section of the technical design — extract from `outputs/phase-2-architecture.md`: `DATA_MODEL` + `API_DESIGN` for backend, `FRONTEND_ARCHITECTURE` for frontend, `INFRASTRUCTURE_IMPACT` for infra, the whole `API_DESIGN` for mock
- **A `## Contract Reference` section** — see the `spec_policy` switch below. This is what replaces the old "endpoint list with exact spec field names" bullet and is where the service task files really diverge by policy.
- Worktree path the implementer will work in
- **A `## Known Pitfalls` section (D1 / D3)** — see below
- **A `## Out of Scope` section** — see below. Lists items deferred or rejected at the Phase 2 / 4.5 gates. The implementer treats it as an explicit "do NOT touch" list (per common-rules R6); the reviewer cross-checks the diff against it.
- The expected report format (files created/modified, FR/EC coverage map, test results, commands run)

#### Building the `## Contract Reference` section (spec_policy switch)

For backend + worker service tasks, look up `config.services[{service}].spec_policy` (default `api-first` when omitted) and pick ONE of the three shapes below. Mock and infra tasks skip this section entirely — their contract is `API_DESIGN` / `INFRASTRUCTURE_IMPACT` themselves.

**`api-first`** (spec exists and was edited in Phase 3b):

```markdown
## Contract Reference

**Spec policy**: `api-first`
**Spec file**: `{config.services[svc].spec_file}` (absolute path inside the worktree)

**Endpoints (match spec field names byte-for-byte)**:
- `POST /orders/{order_id}/ship` → request `ShipRequest`, response `ShipResponse`, 200/400/403/404/409
- `GET /orders/{order_id}/history` → query `limit` (int, 1-100), response `HistoryResponse`
- ...

The spec is the source of truth — never rename a field, never change a type. If the spec is wrong, stop and flag it to the orchestrator (do not "improve" it during implementation).
```

**`code-first`** (no spec file — the architect's inline contract is authoritative):

```markdown
## Contract Reference

**Spec policy**: `code-first`
**Spec file**: — (no spec file for this service; the inline contract below IS the contract)

**Inline contract(s)** — copied byte-for-byte from Phase 2 `API_DESIGN` for this service. Field names, types, enum values, status codes, and error shapes are all load-bearing.

{paste the architect's full inline-contract block(s) for this service from API_DESIGN — every endpoint owned by this service, verbatim, including request body fields, response body fields, auth, and error responses}

Deviation from this contract requires re-architecture (Phase 2 redo), not implementer judgment. If you find the contract inconsistent or incomplete, stop and report.
```

**`no-api`** (worker — no HTTP, event-driven):

```markdown
## Contract Reference

**Spec policy**: `no-api`
**Spec file**: — (worker has no HTTP endpoints)

**Event triggers** — copied byte-for-byte from Phase 2 `API_DESIGN` for this worker.

{paste the architect's full Event Triggers block(s) for this worker from API_DESIGN — every handler, verbatim, including trigger source, event schema reference, delivery semantics, batch config, downstream targets, failure modes}

**Event schema files** (from Phase 3a contract edits — reuse the typed models they produce if the repo generates them; otherwise implement the deserializer per the repo's pattern):

- `{absolute path to event schema file 1 in the contract repo worktree}` — {one-line summary of the shape}
- `{absolute path to event schema file 2}` — ...

Idempotency key, DLQ config, and partial-failure reporting are load-bearing — see the `python-worker.md` pitfalls section below.
```

Build this section by reading the architect's `API_DESIGN` from `outputs/phase-2-architecture.md`, selecting the block(s) for the service in question, and substituting the template above. For `no-api` workers, also look at `AFFECTED_CONTRACTS` from `outputs/phase-2-architecture.md` (the Phase 3a contract edits) to resolve the schema file paths — use the worktree path if a `contract_worktrees` entry exists in the scratchpad.

#### Building the `## Known Pitfalls` section

Every task body MUST include a `## Known Pitfalls` section right above `## Report format`. Build it by:

1. Looking up the repo's `type` from `config.repos[{repo}].type`.
2. Reading the corresponding pitfalls file from `{plugin_dir}/docs/pitfalls/{type}.md` (e.g., `spring-boot.md`, `fastapi.md`, `flask.md`, `django.md`, `python-worker.md`, `nestjs.md`, `react.md`, `nextjs.md`, `node-mock.md`, `cdk.md`, `terraform.md`). Select the sections relevant to what the task actually does:
   - Backend task touching endpoints + DB → include "Exception → HTTP status convention", "DB schema / migrations", "Role / authz matrix" sections
   - Backend task doing a list endpoint → also include "Sort / filter param validation", "N+1 queries"
   - Backend task adding/consuming SQS → include "SQS payload compatibility"
   - Flask / Django task → include "App factory / App wiring", "Migrations", "Role / authz"
   - Python-worker task → include "Idempotency", "Partial failure", "DLQ + retry config", "Schema evolution"; omit any HTTP-specific sections
   - Frontend task with filters + URL state → include "useCallback / dependency stability", "URL-persisted filter state", "React Query cache keys"
   - Frontend task with download → include "Download / binary responses"
   - Every frontend task → include "i18n / RTL"
   - Mock task → include "Spec drift", "Seed data coverage"
   - CDK task → include "Resource cross-references", "IAM least-privilege"
   - Terraform task → include "Apply is never the agent's call", "Destroys are irreversible", "IAM least privilege", "State drift"
3. Reading `{workspace_root}/{slug}/context/audit-findings.md` (if present) and filtering to bullets whose `file:line` refers to files the task will touch (look at `## {repo}` H2 sections; match on repo name). Include these under a `### Workspace-specific findings from onboarding` sub-heading, verbatim.
4. If fewer than 3 bullets would survive the filtering + selection, drop the whole section — too-short pitfall lists dilute signal.

Format the section as:

```markdown
## Known Pitfalls

Stack-specific traps to actively avoid in this repo. These are the predictable failure modes that derailed prior implementations — every bullet is either documented in `{plugin_dir}/docs/pitfalls/{type}.md` or surfaced by onboarding as an existing bug.

### Stack-specific ({type})

- {bullet from pitfalls catalog}
- {bullet from pitfalls catalog}
- ...

### Workspace-specific findings from onboarding

- {file:line — description} (copied verbatim from audit-findings.md)
- ...
```

The implementer treats this section as active checklist — not prose context.

The downstream reviewer (Phase 5.5) is instructed to verify that each pitfall was addressed, so the section doubles as an implementation guide and a review lens.

#### Building the `## Out of Scope` section

Every task body MUST include an `## Out of Scope` section right above `## Report format`. Build it by collecting items the user, product-owner, or architect explicitly deferred or rejected before this task ran:

1. **From `outputs/phase-1-requirements.md`** — search for an `## Out of Scope` or `## Non-goals` section in the product-owner's output (if the workspace's product-owner emits one). Copy bullets verbatim, filtered to ones relevant to this task's repo.
2. **From `outputs/phase-2-architecture.md`** — extract the `<!-- BEGIN RISKS -->` section. Any sub-bullet labelled "deferred" / "out of scope" / "follow-up" goes here, filtered to this task's repo.
3. **From captured user gate rejections** (if `outputs/gate-rejections.md` exists) — copy bullets that touch this task's repo.

Format the section as:

```markdown
## Out of Scope

Items deferred or rejected at the Phase 2 / 4.5 gates. Do NOT touch these — if a "natural" enhancement would fall under one of these bullets, stop and ask the orchestrator (per common-rules R6).

- {bullet 1, verbatim from source} ({source: requirements / architecture / gate-rejection})
- {bullet 2} ({source})
- ...
```

If no items survive filtering, write the single line:

```markdown
## Out of Scope

_(none — task scope is fully described by the FR/EC list and sub-task checklist above)_
```

The downstream reviewer (Phase 5.5) is instructed to flag any diff hunk that matches an Out-of-Scope bullet as a Critical scope violation.

After the body, append an empty `## Work Log` section as the last section of the file (see critical rule #13 for the line format the orchestrator will append to it on each dispatch):

```markdown
## Work Log

<!-- one line per agent dispatch, appended by the orchestrator -->
```

**Step 4 — After all Write calls succeed**, capture the UTC timestamp that went into `created_at` / `updated_at` with a single Bash call (`date -u +"%Y-%m-%dT%H:%M:%SZ"`) and reuse it across all sub-tasks in this batch — they're created within seconds of each other so a single timestamp is appropriate.

Repeat the Write step for every sub-task in the plan.

**After all tasks are created**, update the scratchpad's Implementation Tasks table to hold **IDs and repo names only** — no descriptions, no checklists, no FR/EC details. The table becomes:

```markdown
## Implementation Tasks

| # | Task ID | Repo | Agent | Status | Worktree | Files Changed |
|---|---------|------|-------|--------|----------|---------------|
| 1 | {id-1} | abvi-publisher-service | spring-boot-api-implementer | PENDING | | |
| 2 | {id-2} | abvi-backoffice-service | spring-boot-api-implementer | PENDING | | |
| 3 | {id-3} | abvi-pms-frontend | ux-consultant + react-feature-implementer | PENDING | | |
| 4 | {id-4} | abvi-backends-mock | mock-endpoint-implementer | PENDING | | |
| 5 | {id-5} | abvi-ops-platform | cdk-stack-implementer | PENDING | | |
```

Fill the `Agent` column by looking up each repo's `type` in the `TYPE_TO_AGENT` table in `phases/dispatch-rules.md`. The table covers every supported type (spring-boot, fastapi, flask, django, nestjs, python-worker, react, nextjs, node-mock, cdk, terraform, schemas). For `type: other`, write `— (skip — no implementer)` in the Agent column and mark status `SKIPPED`.

**Drop the full implementation plan from live context.** Do NOT keep the plan body, the sub-task checklists, or the FR/EC-mapping notes in the assistant message that follows. If Phase 5 needs any detail, the implementer fetches it via the Read tool on `~/.claude/dal-pipeline/tasks/{task-id}.md`. If the orchestrator itself needs any detail (e.g., to refine dispatch), it also Reads the task file in the moment and drops the result after use.

**Update scratchpad**: Set Current Phase to "Phase 5: Implementation".

---

#### Phase 4.5 — Dispatch Phase 5 implementers with task IDs

When Phase 5 dispatch happens, every implementer agent is launched with a prompt that contains **only its task ID** plus a handful of pipeline-level context fields (worktree path, repo path, branch name). The implementer's first action is to load its task via the Read tool:

```
You are implementing a feature in the {repo-type} worktree at {worktree_path}.

TASK FILE: ~/.claude/dal-pipeline/tasks/{task-id}.md

Your first action: use the Read tool to load the task file at the path above.
The file's YAML frontmatter identifies the task (id, phase, repo, requirement refs). The body below the frontmatter is the full sub-task specification — feature summary, the numbered sub-task checklist, functional requirements (FR-X) and edge cases (EC-X) to enforce, the relevant data model and API design sections, endpoint list with exact spec field names, worktree path, and the expected report format.

Read it once, internalize it, and do not re-quote it in your output or in any intermediate scratchpad update — the orchestrator already knows what the task says, and you are expected to operate from your own loaded copy without forwarding it anywhere.

When you finish implementing and testing, update the task file's status before returning. Use the Edit tool to change the two frontmatter fields:
- `status: todo` → `status: done`
- `updated_at: <old timestamp>` → `updated_at: <current UTC ISO-8601 timestamp>`

Leave the body verbatim. Then produce your report to the orchestrator in the format the task body specified.

CRITICAL FOR THIS DISPATCH (do not skip — these are the HARD RULES from `{plugin_dir}/docs/implementer-common-rules.md` most often forgotten):
- **R9 — COVERAGE block.** Emit BOTH the human-readable `## Requirement coverage` table AND the `<!-- BEGIN COVERAGE -->` JSON block. Count the `FR-X` and `EC-X` lines in your task file body before reporting done — your COVERAGE block must contain one entry per ID, each with a `file:line` enforcement point.
- **R6 — Scope discipline.** Every line in your diff must trace to an FR-X, EC-X, or sub-task line in the task file. If it doesn't, do not write it.
- **R7 — Stop on load-bearing ambiguity.** Do not guess. If a field name, type, status code, or contract shape is ambiguous, return an `## Assumptions` block at the top of your report instead of coding.
- **R8 — Stay in your launched worktree.** Never `git checkout` another branch, never `git worktree add`, never edit outside `{worktree_path}`.

Now: load the task file at the path above and implement the feature within `{worktree_path}`.

