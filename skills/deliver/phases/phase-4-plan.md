### Phase 4: Sync Specs

**Skip if**: no repos in the config have `spec_copies`. This means no downstream repos consume copies of the service specs — nothing to sync.

For each affected service, find all repos that have `spec_copies` entries referencing that service, and copy the updated spec:

```bash
# For each repo that has spec_copies:
{for each repo in config.repos where repo.spec_copies exists:}
  {for each [service_key, relative_path] in repo.spec_copies:}
    {if service_key is in the affected services list:}
      cp {config.repos[config.services[service_key].repo].path}/{config.services[service_key].spec_file} {repo.path}/{relative_path}
```

Report which repos received which spec copies. If no copies were needed, report "No spec_copies configured — Phase 4 skipped."

**Update scratchpad**: Set Phase 4 Status to COMPLETED (or SKIPPED). Set Current Phase to "Phase 4.5: Implementation Plan".

---

### Phase 4.5: Implementation Plan + Context Budget

Build the implementation task list from the architect's output + workspace config.

Phase plan comes from rule #2 — read it from the scratchpad's Architecture Flags section. Create tasks only for running phases, based on `AFFECTED_SERVICES` + the repo map.

CLI flag combinations:
- Phase 5a runs if: spec was edited OR architect listed affected services AND `--frontend-only` not passed
- Phase 5b runs if: `frontend_required = Yes` AND `--backend-only` not passed
- Phase 5c runs if: `mock_required = Yes` AND `--no-mock` not passed AND `--backend-only` not passed

**Context budget check**: Estimate the token count of each output file. If Phase 5b combined input (requirements + frontend architecture + agent prompts) exceeds ~30K tokens, warn the user and suggest compressing the requirements further.

**Update scratchpad**: Populate the Implementation Tasks table with all tasks that will run (status: PENDING). Set any skipped tasks to SKIPPED with reason. Record context budget estimates.

**Create sub-task breakdown for EACH implementation task** — not just frontend. Break down based on the architecture output:

#### Backend sub-task breakdown template (per service):
```
Backend: {service}
  1. DTOs/Models — Create request/response DTOs matching spec schemas
  2. Repository — New/modified repository methods
  3. Service layer — Business logic for each endpoint group
  4. Controller — REST endpoints matching spec paths
  5. Tests — Unit tests (service) + integration tests (controller)
  6. Run tests — mvn test
```

#### Frontend sub-task breakdown template:
```
Frontend:
  1. API layer — Types, endpoint constants, service methods, error classes
  2. Hooks — React Query hooks (queries + mutations)
  3. Core components — Status badges, table columns, shared UI
  4. Page + routing — Dashboard page, tabs, route, role guard
  5. Detail view — Detail dialog with read-only data display
  6. Actions — {group 1} — {e.g., Claim/unclaim}
  7. Actions — {group 2} — {e.g., Document approve/reject with rejection modal}
  8. Actions — {group 3} — {e.g., Contract approve/reject with confirmation}
  9. i18n — EN + AR translation keys
  10. Tests — Unit + integration tests
  11. Agent context — Update agent-context-v2 docs
```

#### Mock sub-task breakdown template:
```
Mock:
  1. Mock data — Generate realistic mock data arrays
  2. Endpoints — {N} route handlers matching spec
  3. Filters/pagination — Query param support
```

Present the plan to the user with sub-tasks visible:

```
## Implementation Plan

### Feature: {feature name}
### Service(s): {list}

### Backend: {service} (abvi-{service}-service)
| # | Sub-Task | Status |
|---|----------|--------|
| 1.1 | DTOs/Models — {N} DTOs matching spec | PENDING |
| 1.2 | Repository — {summary} | PENDING |
| 1.3 | Service layer — {summary} | PENDING |
| 1.4 | Controller — {N} endpoints | PENDING |
| 1.5 | Tests — unit + integration | PENDING |

### Frontend (abvi-pms-frontend)
| # | Sub-Task | Status |
|---|----------|--------|
| 2.1 | API layer — types, services, config, errors | PENDING |
| 2.2 | Hooks — {N} query + mutation hooks | PENDING |
| 2.3 | Core components — badges, columns | PENDING |
| 2.4 | Page + routing + tabs | PENDING |
| 2.5 | Detail view — {dialog/panel} | PENDING |
| 2.6 | Actions — {group 1} | PENDING |
| 2.7 | Actions — {group 2} | PENDING |
| 2.8 | i18n — EN + AR | PENDING |
| 2.9 | Tests | PENDING |
| 2.10 | Agent context update | PENDING |

### Mock (abvi-backends-mock)
| # | Sub-Task | Status |
|---|----------|--------|
| 3.1 | Mock data generation | PENDING |
| 3.2 | {N} endpoint handlers | PENDING |

### Context Budget
- Requirements on disk: ~{N} tokens | Architecture on disk: ~{N} tokens
- Avg task file: ~{N} tokens | Max task file: ~{N} tokens (task {id})
- Total tasks this run: {N}
- Each dispatch loads only the task file it's given, not requirements/architecture in full — so per-dispatch input is roughly (task file size + 2K boilerplate)

### Skipped
- {Phase}: {reason}

Approve this plan to start implementation, or adjust?
```

**Include sub-task lists in each agent's prompt** so the agent knows the full scope and can work through items systematically. After each agent completes, cross-check its output against the sub-task list and update statuses in the scratchpad.

**Wait for user approval.**

---

#### Phase 4.5 — After approval: persist sub-tasks as markdown files

Once the user approves the plan, **persist each sub-task as a markdown file** under `~/.claude/dal-pipeline/tasks/` and replace the plan text in the scratchpad with an IDs-only table. This is where the context-lean contract starts paying off: the full plan body drops out of the orchestrator's live context and every downstream agent fetches its own sub-task on demand via the Read tool.

Read the feature slug from the scratchpad (set during Pre-flight).

**Step 1 — Read the source material once.** Read `outputs/phase-1-requirements.md` and `outputs/phase-2-architecture.md` via the Read tool. These stay in the orchestrator's context for the duration of Phase 4.5 task creation and are dropped afterward.

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

