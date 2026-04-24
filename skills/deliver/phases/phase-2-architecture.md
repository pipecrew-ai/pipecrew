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

Produce the Technical Design Document using the required section delimiters, including the AFFECTED_CONTRACTS and CONTRACT_DESIGN sections if any contract repo is affected.
Identify ALL affected services AND contracts — the user did not pre-select.
```

**After**: Present to user. Wait for approval.

**ADR gate** (after user approves): ask once:

> "Any decisions in this design worth recording for future reference? Examples: chose SQS over polling, ruled out Lambda, kept uploads in one service. (yes / no)"

- **yes** → dispatch the `solution-architect` agent: `"Append one ADR entry to {workspace_root}/{slug}/agent-memory/solution-architect/adrs.md for the key decision(s). Create the file if it doesn't exist."` Wait, then continue.
- **no** → continue immediately.

**Update scratchpad**: Set Phase 2 Status to COMPLETED. Write full approved tech design to `outputs/phase-2-architecture.md`. Extract and store in active.md: Affected Contracts, Affected Services, Contract Edit Order, Spec Edit Order, and the auto-detected phase flags:
- Contracts Required = Yes if architect's AFFECTED_CONTRACTS is non-empty (not `N/A`)
- Frontend Required = Yes if architect's design includes frontend changes AND config has a frontend repo
- Mock Required = Yes if config has a mock-server repo AND architect didn't explicitly exclude it
- Infra Required = Yes if architect flagged infrastructure impact AND config has an infra repo

Set Current Phase to "Phase 3a: Contract Edit" if contracts are affected, otherwise "Phase 3b: Spec Edit".

---
