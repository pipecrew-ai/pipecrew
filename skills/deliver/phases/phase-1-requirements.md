### Phase 1: Requirements (product-owner)

Launch the workspace's product-owner agent. Onboarding published it to the harness user-level agents dir as `{slug}-product-owner.md` (`~/.claude/agents/` under Claude Code, `~/.cursor/agents/` under Cursor — see onboard Phase C Step 3 "Publish to user-level agents directory"), so it is directly resolvable as a `subagent_type`.

**Tool**: `Agent`
**subagent_type**: `{slug}-product-owner` (substitute the actual workspace slug, e.g., `dal-product-owner`)

**Fallback**: if `{slug}-product-owner.md` does not exist in the harness user-level agents dir (workspace was onboarded with an older plugin version that did not publish agents), warn the user and fall back to `subagent_type: general-purpose` with the prompt `"Read and behave as the agent defined at {workspace_root}/{slug}/agents/product-owner.md, then:"` prepended to the task prompt below. Also suggest the user re-run `/discover --resume --workspace={slug}` to publish the workspace agents.

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

REQUIREMENTS FILE (Write the full requirements document here yourself — you have Write):
{run_dir}/outputs/phase-1-requirements.md

Ask clarifying questions if needed, then produce the requirements document using the four prose sections + the REQUIREMENTS_INDEX JSON block exactly as your system prompt specifies. Use the `<!-- BEGIN/END -->` section delimiters. Write the complete document to the REQUIREMENTS FILE, and make your final message only a gate digest: one-paragraph overview, the FR list and EC list as one line each (id + summary sentence), out-of-scope bullets, open questions (or "none"), and the file path. Do NOT repeat the full document in the final message — the orchestrator presents your digest at the approval gate and validates the JSON block from the file.

CRITICAL FOR THIS DISPATCH (do not skip — these are the rules most often forgotten):
- **Write the document to the REQUIREMENTS FILE; return only the gate digest.** The digest must let the user judge scope (every FR/EC id + one-line summary) without opening the file.
- **REQUIREMENTS_INDEX JSON block is load-bearing.** Emit `<!-- BEGIN REQUIREMENTS_INDEX -->` with a fenced ```json block matching `{plugin_dir}/templates/blocks/requirements-index.example.json`. **Before** the approval gate the orchestrator materializes it to `outputs/blocks/requirements-index.json` (the split step below) — so a missing or malformed block is caught and re-dispatched *before* you approve, never after. Phase 4 task planning reads it to validate `fr_refs` IDs and Phase 5.5 reviewers read it to enumerate the FR-X / EC-X each service owns.
- **Self-consistency.** Every FR-X and EC-X you wrote in the prose MUST appear in the JSON block. Count prose entries, count JSON entries — they must match exactly.
- **WHAT not HOW.** Functional contract only. No endpoint paths, no request/response shapes, no UI layouts, no component choices, no test plans. Each of those belongs to a downstream agent (architect / ux-consultant / implementer + reviewer).
- **FR-X is the test spec.** Write each FR so it is testable as stated — include the acceptance criterion in the sentence. The cross-repo assessor (Phase 6) builds its end-to-end checklist directly from FR-X + the wire contract; you do not need to write a separate test plan.
- **Section delimiters.** Use `<!-- BEGIN/END -->` markers per your output template — the orchestrator reads sections by these markers.
- **Ask before guessing.** If the feature description is ambiguous, emit clarifying questions and STOP. Do not silently fill gaps.

Now: produce the requirements document for the feature above.
```

**After the product-owner returns its final requirements** (clarifying-question loop, if any, resolved per CRITICAL RULE 8) — write and validate the artifact **before** the approval gate, so the user approves the saved document, not a chat paraphrase, and a bad index is caught before they approve:

**Step 1 — verify the document is on disk.** The product-owner writes `{run_dir}/outputs/phase-1-requirements.md` itself per its dispatch contract — verify the file exists, is non-trivial, and contains the section delimiters. If it's missing (the agent returned the full document instead — a legacy-template workspace agent), write its returned document to that path yourself and log a warning suggesting `/discover --resume --workspace={slug}` to regenerate the workspace agents. Either way the file must exist before the gate, not after it — the user approves the saved document, not a chat paraphrase.

**Step 2 — materialize + validate the requirements index (still before the gate).** Split the structured block into its own file — the same pattern Phase 2 uses for the architecture blocks, reusing the same generic script — and verify it materialized:

```bash
node {plugin_dir}/scripts/split-design.js {run_dir}/outputs/phase-1-requirements.md
test -s {run_dir}/outputs/blocks/requirements-index.json
```

The split writes `{run_dir}/outputs/blocks/requirements-index.json`; the prose blocks (OVERVIEW / FUNCTIONAL_REQUIREMENTS / EDGE_CASES / OUT_OF_SCOPE) have no ```json fence and are skipped silently — only REQUIREMENTS_INDEX is materialized. If the split **loud-fails on malformed JSON** (exit 3) or the index file is missing/empty, the product-owner emitted an invalid or absent REQUIREMENTS_INDEX block — do **NOT** open the gate. Re-dispatch the product-owner via `SendMessage`: `"Your REQUIREMENTS_INDEX block is missing or invalid JSON. Re-emit it matching templates/blocks/requirements-index.example.json — same conversation, do not redo the prose."`, then redo Step 1 and re-run this step. Catching it here means the user never approves a document whose index won't materialize (this also mirrors Phase 2's TASK_SKELETON guard).

**Step 3 — present + gate.** Now present the product-owner's **digest** to the user (do not read the saved file into context), pointing them at `{run_dir}/outputs/phase-1-requirements.md` for the full document, and wait for approval (wrap with `gate.js open`/`close` per CRITICAL RULE 5).
- **Rejected / change requested**: re-dispatch the product-owner via `SendMessage` with the user's feedback — it edits the saved file and returns an updated digest; then redo Steps 1–2 (re-verify + re-validate the saved file) before re-presenting. The file on disk always reflects the exact version the user is being asked to approve.
- **Approved**: proceed.

**Update scratchpad**: Set Phase 1 Status to COMPLETED. Set Current Phase to "Phase 2: Architecture".

---
