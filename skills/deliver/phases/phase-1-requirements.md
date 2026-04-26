### Phase 1: Requirements (product-owner)

Launch the workspace's product-owner agent. Onboarding published it to `~/.claude/agents/{slug}-product-owner.md` (see onboard Phase C Step 3 "Publish to user-level agents directory"), so it is directly resolvable as a `subagent_type`.

**Tool**: `Agent`
**subagent_type**: `{slug}-product-owner` (substitute the actual workspace slug, e.g., `dal-product-owner`)

**Fallback**: if `~/.claude/agents/{slug}-product-owner.md` does not exist (workspace was onboarded with an older plugin version that did not publish agents), warn the user and fall back to `subagent_type: general-purpose` with the prompt `"Read and behave as the agent defined at {workspace_root}/{slug}/agents/product-owner.md, then:"` prepended to the task prompt below. Also suggest the user re-run `/discover --resume --workspace={slug}` to publish the workspace agents.

**Build the prompt dynamically from the workspace config** — do NOT hardcode service names, spec paths, or assume a frontend exists.

```
Analyze this feature request.

Feature: {feature description}
{if --service hint was passed: "Starting service hint: {service}"}

Workspace: {workspace.name}

Services in this workspace (read their specs to understand current capabilities):
{for each service in config.services:}
  - {service.key}: {service.description}
    Spec: {config.repos[service.repo].path}/{service.spec_file}

{if any repo has role "frontend":}
Frontend context:
{for each repo with role "frontend":}
  - {repo.key} at {repo.path}
    Read CLAUDE.md and any agent-context docs.
{else:}
No frontend in this workspace.

Ask clarifying questions if needed, then produce detailed requirements.
Use the section delimiters (<!-- BEGIN/END -->) in your output template.

After the prose requirements, emit a structured index block that downstream phases extract programmatically:

<!-- BEGIN REQUIREMENTS_INDEX -->
```json
{ ... matches {plugin_dir}/templates/blocks/requirements-index.example.json ... }
```
<!-- END REQUIREMENTS_INDEX -->

The JSON must include every FR-X and EC-X you wrote in the prose, with their summary text. This is the canonical source — downstream agents (Phase 4 task generation, reviewers, Phase 6 assessor) extract it via `node {plugin_dir}/scripts/extract-block.js outputs/phase-1-requirements.md REQUIREMENTS_INDEX` rather than re-parsing the prose. Schema in `{plugin_dir}/docs/file-formats.md`.

IMPORTANT: Focus on WHAT (functional requirements, API contract, edge cases, testing) — NOT on HOW the UI should look. UX design decisions will be made by the UX consultant agent in a later phase.
```

**After**: Present requirements to the user. Wait for approval.

**Update scratchpad**: Set Phase 1 Status to COMPLETED. Write the full approved requirements to `outputs/phase-1-requirements.md`. Set Current Phase to "Phase 2: Architecture".

---
