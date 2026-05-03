### Phase 2: Architecture (solution-architect)

Launch the `solution-architect` agent. **Pass file paths, not contents.** **Build the spec list dynamically from the workspace config** — do NOT hardcode service names or paths.

```
Use the solution-architect agent to design the technical architecture for this feature.

Workspace: {workspace.name} (slug: {workspace.slug})

REQUIREMENTS FILE (read this yourself via Read tool):
{pipeline_dir}/outputs/phase-1-requirements.md

WORKSPACE CONFIG (read for service map and domain context):
{workspace_root}/{slug}/config.json

PLATFORM CONTEXT (read for architecture patterns and constraints):
{workspace_root}/{slug}/context/platform.md

SERVICE SPECS (read each to understand current API surface):
{for each service in config.services where spec_policy != "no-api" AND spec_file is set:}
  - {service.key}: {config.repos[service.repo].path}/{service.spec_file}

{if any service has spec_policy "code-first" or "no-api":}
NON-API-FIRST SERVICES (no OpenAPI spec — read repo CLAUDE.md and code to understand contract):
{for each service with spec_policy "code-first":}
  - {service.key} ({config.repos[service.repo].type}, code-first): {config.repos[service.repo].path} — for these services, define the endpoint contract inline in the technical design (method, path, request/response shape, status codes); Phase 3 will not edit any spec file.
{for each service with spec_policy "no-api":}
  - {service.key} ({config.repos[service.repo].type}, no-api): {config.repos[service.repo].path} — event-driven worker; the contract is the event schema (see CONTRACT repos below), not HTTP.

{if any repo has role "contract":}
CONTRACT REPOS (shared schemas — JSON Schema / Avro / Protobuf — edited BEFORE service specs in Phase 3a):
{for each repo with role "contract":}
  - {repo.key} ({repo.type}): {repo.path}

{if any repo has role "frontend":}
FRONTEND REPOS (read CLAUDE.md for conventions):
{for each repo with role "frontend":}
  - {repo.key}: {repo.path}

{if any repo has role "infrastructure":}
INFRA REPOS:
{for each repo with role "infrastructure":}
  - {repo.key}: {repo.path}

Produce the Technical Design Document using the required section delimiters.

CRITICAL FOR THIS DISPATCH:
- Emit the AFFECTED_SERVICES section as a fenced ```json block matching `{plugin_dir}/templates/blocks/affected-services.example.json`. Downstream phases extract it programmatically — prose-only is a defect.
- Emit the TASK_SKELETON section as a fenced ```json block matching `{plugin_dir}/templates/blocks/task-skeleton.example.json`. Phase 4.5's task-planner consumes this — without it the planner falls back to LLM-parsing RISKS prose, which is fragile. Every `D` sub-task in the skeleton must cite its corresponding RISKS sub-bullet via `deferral_reason`.
- Include AFFECTED_CONTRACTS and CONTRACT_DESIGN sections if (and only if) any contract repo is affected.
- Identify ALL affected services AND contracts — the user did not pre-select. Missing one breaks downstream phases.
- Name the runner-up alternative in one sentence and explain why you ruled it out (per your system prompt's simplicity-first rule).

Now: design the technical architecture for the feature in {pipeline_dir}/outputs/phase-1-requirements.md and write the full design document.
```

**After**: Present to user. Wait for approval.

**ADR gate** (after user approves): ask once:

> "Any decisions in this design worth recording for future reference? Examples: chose SQS over polling, ruled out Lambda, kept uploads in one service. (yes / no)"

- **yes** → dispatch the `solution-architect` agent: `"Append one ADR entry to {workspace_root}/{slug}/agent-memory/solution-architect/adrs.md for the key decision(s). Create the file if it doesn't exist."` Wait, then continue.
- **no** → continue immediately.

**Materialize per-block side files**: after writing `outputs/phase-2-architecture.md`, run:

```bash
node {plugin_dir}/scripts/split-design.js {pipeline_dir}/outputs/phase-2-architecture.md
```

This scans every `<!-- BEGIN X -->` block, extracts each `\`\`\`json` fence, and writes one file per block to `{pipeline_dir}/outputs/blocks/<slug>.json` (e.g., `affected-services.json`, `api-design.json`, `data-model.json`, `infrastructure-impact.json`, `contract-design.json`, `task-skeleton.json`). Prose-only blocks are skipped silently. **Loud-fails on JSON parse error** — exit 3 means the architect emitted malformed JSON; halt the pipeline and surface the error to the user.

**Verify TASK_SKELETON exists**: after `split-design.js` runs, check that `{pipeline_dir}/outputs/blocks/task-skeleton.json` was produced. If missing (architect skipped the block), do NOT proceed — Phase 4.5 will fail without it. Re-dispatch the architect via `SendMessage` with: `"Your output is missing the TASK_SKELETON block. Read templates/blocks/task-skeleton.example.json and emit the block now — same conversation, do not redo the rest of the design."`

Downstream phases (3, 4, 5) read these side files instead of the markdown. The orchestrator no longer pulls `phase-2-architecture.md` into context — that file is the human-narrative artifact for the Phase 2 gate review only.

**Update scratchpad**: Set Phase 2 Status to COMPLETED. Write full approved tech design to `outputs/phase-2-architecture.md`. Extract and store in active.md: Affected Contracts, Affected Services, Contract Edit Order, Spec Edit Order, and the auto-detected phase flags:
- Contracts Required = Yes if architect's AFFECTED_CONTRACTS is non-empty (not `N/A`)
- Frontend Required = Yes if architect's design includes frontend changes AND config has a frontend repo
- Mock Required = Yes if config has a mock-server repo AND architect didn't explicitly exclude it
- Infra Required = Yes if architect flagged infrastructure impact AND config has an infra repo

Set Current Phase to "Phase 3a: Contract Edit" if contracts are affected, otherwise "Phase 3b: Spec Edit".

---
