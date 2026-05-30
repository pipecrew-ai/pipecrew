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

You already know the platform — read your workspace-level context (platform.md, audit-findings.md if present, config.json) at the start of every invocation per your system prompt. Do NOT read OpenAPI specs, frontend code, or backend source — those belong to the architect (Phase 2) and the ux-consultant (Phase 5b). If you need to know whether a capability already exists, ASK the user; don't go look.

Services in this workspace (for reference only — names you may need in clarification questions):
{for each service in config.services:}
  - {service.key}: {service.description}

{if any repo has role "frontend":}
Frontend repos in this workspace (names only — do NOT read their code):
{for each repo with role "frontend":}
  - {repo.key}
{else:}
No frontend in this workspace.

Ask clarifying questions if needed, then produce the requirements document using the four prose sections + the REQUIREMENTS_INDEX JSON block exactly as your system prompt specifies. Use the `<!-- BEGIN/END -->` section delimiters.

CRITICAL FOR THIS DISPATCH (do not skip — these are the rules most often forgotten):
- **REQUIREMENTS_INDEX JSON block is load-bearing.** Emit `<!-- BEGIN REQUIREMENTS_INDEX -->` with a fenced ```json block matching `{plugin_dir}/templates/blocks/requirements-index.example.json`. Phase 4 task generation, Phase 5.5 reviewers, and Phase 6 assessor all extract this via `extract-block.js` — missing block breaks every downstream phase.
- **Self-consistency.** Every FR-X and EC-X you wrote in the prose MUST appear in the JSON block. Count prose entries, count JSON entries — they must match exactly.
- **WHAT not HOW.** Functional contract only. No endpoint paths, no request/response shapes, no UI layouts, no component choices, no test plans. Each of those belongs to a downstream agent (architect / ux-consultant / implementer + reviewer).
- **FR-X is the test spec.** Write each FR so it is testable as stated — include the acceptance criterion in the sentence. The cross-repo assessor (Phase 6) builds its end-to-end checklist directly from FR-X + the wire contract; you do not need to write a separate test plan.
- **Section delimiters.** Use `<!-- BEGIN/END -->` markers per your output template — the orchestrator reads sections by these markers.
- **Ask before guessing.** If the feature description is ambiguous, emit clarifying questions and STOP. Do not silently fill gaps.

Now: produce the requirements document for the feature above.
```

**After**: Present requirements to the user. Wait for approval.

**Update scratchpad**: Set Phase 1 Status to COMPLETED. Write the full approved requirements to `outputs/phase-1-requirements.md`. Set Current Phase to "Phase 2: Architecture".

---
