### Phase 2: Architecture (solution-architect)

Launch the `solution-architect` agent. **Pass file paths, not contents.** **Build the spec list dynamically from the workspace config** — do NOT hardcode service names or paths.

```
Use the solution-architect agent to design the technical architecture for this feature.

Workspace: {workspace.name} (slug: {workspace.slug})

REQUIREMENTS FILE (read this yourself via Read tool):
{pipeline_dir}/outputs/phase-1-requirements.md

WORKSPACE CONFIG (read for service map and domain context):
~/.claude/workspaces/{slug}/config.json

PLATFORM CONTEXT (read for architecture patterns and constraints):
~/.claude/workspaces/{slug}/context/platform.md

SERVICE SPECS (read each to understand current API surface):
{for each service in config.services:}
  - {service.key}: {config.repos[service.repo].path}/{service.spec_file}

{if any repo has role "frontend":}
FRONTEND REPOS (read CLAUDE.md for conventions):
{for each repo with role "frontend":}
  - {repo.key}: {repo.path}

{if any repo has role "infrastructure":}
INFRA REPOS:
{for each repo with role "infrastructure":}
  - {repo.key}: {repo.path}

Produce the Technical Design Document using the required section delimiters.
Identify ALL affected services — the user did not pre-select one.
```

**After**: Present to user. Wait for approval.

**ADR gate** (after user approves): ask once:

> "Any decisions in this design worth recording for future reference? Examples: chose SQS over polling, ruled out Lambda, kept uploads in one service. (yes / no)"

- **yes** → dispatch the `solution-architect` agent: `"Append one ADR entry to ~/.claude/workspaces/{slug}/agent-memory/solution-architect/adrs.md for the key decision(s). Create the file if it doesn't exist."` Wait, then continue.
- **no** → continue immediately.

**Update scratchpad**: Set Phase 2 Status to COMPLETED. Write full approved tech design to `outputs/phase-2-architecture.md`. Extract and store in active.md: Affected Services, Spec Edit Order, and the auto-detected phase flags:
- Frontend Required = Yes if architect's design includes frontend changes AND config has a frontend repo
- Mock Required = Yes if config has a mock-server repo AND architect didn't explicitly exclude it
- Infra Required = Yes if architect flagged infrastructure impact AND config has an infra repo

Set Current Phase to "Phase 3: Spec Edit".

---
