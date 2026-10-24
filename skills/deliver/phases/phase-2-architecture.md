### Phase 2: Architecture (solution-architect)

Launch the `solution-architect` agent. **Pass file paths, not contents.** **Build the spec list dynamically from the workspace config** — do NOT hardcode service names or paths.

```
Use the solution-architect agent to design the technical architecture for this feature.

Workspace: {workspace.name} (slug: {workspace.slug})

REQUIREMENTS FILE (read this yourself via Read tool):
{run_dir}/outputs/phase-1-requirements.md

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

{if scratchpad Run Info `from_mock_valid: true`:}
APPROVED MOCKS — AUTHORITATIVE UX (read these; they are a binding constraint, not a suggestion):
  - Requirements:          {from_mock_source}/requirements.md
  - UX IMPLEMENTATION_SPEC: {from_mock_source}/implementation-spec.md
  - Approved screens:       {from_mock_source}/screens/   (open the entry screen and walk the flow)
  This feature was delivered with `--from-mock`: a human (often a stakeholder) already approved
  these screens and the flow between them as the REAL UX. You MUST design the technical solution
  to REALIZE this approved UX — not to re-decide it. Specifically:
  - Treat the approved screens, their components, and the screen-to-screen flow as FIXED. Do NOT
    redesign a screen, change page-vs-modal, drop/add/reorder screens, or substitute components.
    Your `FRONTEND_ARCHITECTURE` must map the approved screens to routes/components/state and the
    `IMPLEMENTATION_SPEC` is reused verbatim downstream (Phase 5b) — align to it, do not supersede it.
  - You still own ALL the HOW the mocks do not: backend, API contracts, data model, cross-repo
    integration, and the technical plumbing (routing/state wiring) that makes the approved UX work.
  - If — and only if — an approved screen is genuinely INFEASIBLE as drawn (it needs data the system
    cannot provide, or it contradicts a hard platform constraint), do NOT silently change it: add a
    `### Mock conflict` subsection under `ARCHITECTURE_DECISION` naming the screen, the exact
    conflict, and the minimal change you propose. The orchestrator surfaces this at the Phase 2 gate
    for the human to accept or send back to `/mock-requirements` — the approved UX is never
    overridden without that explicit sign-off.

{if any repo has role "infrastructure":}
INFRA REPOS:
{for each repo with role "infrastructure":}
  - {repo.key}: {repo.path}

DESIGN FILE (Write the complete Technical Design Document here yourself — you have Write):
{run_dir}/outputs/phase-2-architecture.md

Produce the Technical Design Document using the required section delimiters, Write it to the DESIGN FILE, and make your final message only the gate digest per your system prompt's design-mode output rules: headline decision + rationale (2–3 sentences), affected repos/services/contracts (one line each), endpoint list (method + path only), data-model deltas (table + change kind only), top risks and open assumptions, the runner-up alternative and why it lost, and the DESIGN FILE path. Do NOT repeat the full document in the final message — the orchestrator presents your digest at the approval gate and extracts the structured blocks from the file.

CRITICAL FOR THIS DISPATCH:
- **Ask before guessing.** Walk the clarification-protocol dimension list in your system prompt. For every dimension not pinned by the requirements or `platform.md`, emit a clarifying question and STOP — do not silently fill gaps. Run the adversarial pass before emitting. Section markers come only after every dimension is either pinned, justifiably skipped as N/A, or captured under a top-level `## Assumptions` block.
- **Run the nearest-sibling design diff.** Per your system prompt's "Nearest-sibling design diff" rule: identify the closest existing feature in the same repo that solves a structurally similar problem, diff the proposed contract shape against it (request/response fields, who-resolves-what, sync vs async, pagination source, identifier ownership), and record the result in the `### Nearest-sibling design diff` sub-section of `ARCHITECTURE_DECISION`. Every contract-shape divergence needs a one-line "why different" justification; a working-but-non-idiomatic divergence (e.g. round-tripping an id the server could resolve itself) with no rationale is a defect the Phase 5.5 reviewer will flag.
- Emit the AFFECTED_SERVICES section as a fenced ```json block matching `{plugin_dir}/templates/blocks/affected-services.example.json`. Downstream phases extract it programmatically — prose-only is a defect.
- **Set `cross_repo_integration` honestly.** In AFFECTED_SERVICES, set `cross_repo_integration: true` if this feature creates or changes ANY integration surface spanning repos — a shared contract/schema, a service-to-service call (`API_DESIGN.cross_service_calls[]`), a cross-stack ref, a frontend→backend endpoint binding, OR any producer/consumer coupling you know of **including coupling through an existing, unedited contract**. Set it `false` ONLY when every modified repo changes independently with none of the above (e.g. the same maintenance applied to two services, or two unrelated changes bundled). Add a one-sentence `cross_repo_rationale`. This drives whether the Phase 6 cross-repo assessor runs at all — a wrong `false` skips integration verification the feature actually needs; a lazy `true` spends assessor tokens on nothing to check.
- Emit the TASK_SKELETON section as a fenced ```json block matching `{plugin_dir}/templates/blocks/task-skeleton.example.json`. Phase 4.5's task-planner consumes this — without it the planner falls back to LLM-parsing RISKS prose, which is fragile. Every `D` sub-task in the skeleton must cite its corresponding RISKS sub-bullet via `deferral_reason`.
- Include AFFECTED_CONTRACTS and CONTRACT_DESIGN sections if (and only if) any contract repo is affected.
- Identify ALL affected services AND contracts — the user did not pre-select. Missing one breaks downstream phases.
- Name the runner-up alternative in one sentence and explain why you ruled it out (per your system prompt's simplicity-first rule).

Now: design the technical architecture for the feature in {run_dir}/outputs/phase-1-requirements.md and write the full design document.
```

**After**: Verify the architect wrote `{run_dir}/outputs/phase-2-architecture.md` (exists, non-trivial, contains the section markers — if not, the architect violated its output contract: re-dispatch via `SendMessage` telling it to Write the file). Present the architect's **digest** to the user — do NOT read the full design file into your context; the digest is the gate presentation, and the user can open the file for detail (name its path when presenting). If the user asks about a specific section, extract just that block (`node {plugin_dir}/scripts/extract-block.js {run_dir}/outputs/phase-2-architecture.md {SECTION}`) rather than reading the whole file. Wait for approval. Wrap the wait in a gate so the
site-view banner lights (CRITICAL RULE 5) — open before you present, close once
the user answers:

```bash
node {plugin_dir}/scripts/gate.js open --run-dir={run_dir} --phase=2 --gate=approval --question="Approve the technical architecture to proceed to spec/contract edits?"
# … present the design, wait for the user's decision …
node {plugin_dir}/scripts/gate.js close --run-dir={run_dir}
```

**If this run used `--from-mock`** (`from_mock_valid: true`): before presenting, extract any mock-conflict the architect raised (`node {plugin_dir}/scripts/extract-block.js {run_dir}/outputs/phase-2-architecture.md ARCHITECTURE_DECISION` and look for the `### Mock conflict` subsection). If present, surface it at the TOP of the gate presentation as a **⚠ Mock conflict** — name the approved screen, the conflict, and the architect's proposed minimal change — and make the gate question explicit that approving accepts a change to the stakeholder-approved UX (the alternative is to reject and re-run `/mock-requirements` to re-approve the screen). If no `### Mock conflict` subsection exists, state in one line that the design honors the approved mocks as-is.

**ADR gate** (after user approves): ask once:

> "Any decisions in this design worth recording for future reference? Examples: chose SQS over polling, ruled out Lambda, kept uploads in one service. (yes / no)"

- **yes** → dispatch the `solution-architect` agent: `"Write one new ADR file under {workspace_root}/{slug}/context/adrs/ for the key decision(s). Determine the next ADR number by listing the existing ADR files in context/adrs/ and adding 1 (start at 1 if the directory is missing or empty; ignore INDEX.md when counting). Filename pattern: 'ADR-NNN-<kebab-slug>.md' where NNN is zero-padded to 3 digits and <kebab-slug> is a short title (e.g., 'ADR-007-bulk-upload-idempotency.md'). The file body must include: H1 title, Decision, Rationale, Dimensions pinned, Status (proposed/accepted/superseded). Then append a one-line index entry to context/adrs/INDEX.md using the format '- ADR-NNN [tag1, tag2]: one-line decision summary. → ADR-NNN-<slug>.md' — tags MUST cite the affected service and/or the dimension(s) the ADR pins (e.g., [bulk-upload, idempotency], [auth, tenancy]). Create the context/adrs/ directory and INDEX.md if they don't exist. INDEX.md is capped at 200 lines."` Wait, then continue.
- **no** → continue immediately.

**Materialize per-block side files**: after the gate approves (the architect already wrote `outputs/phase-2-architecture.md`), run:

```bash
node {plugin_dir}/scripts/split-design.js {run_dir}/outputs/phase-2-architecture.md
```

This scans every `<!-- BEGIN X -->` block, extracts each `\`\`\`json` fence, and writes one file per block to `{run_dir}/outputs/blocks/<slug>.json` (e.g., `affected-services.json`, `api-design.json`, `data-model.json`, `infrastructure-impact.json`, `contract-design.json`, `task-skeleton.json`). Prose-only blocks are skipped silently. **Loud-fails on JSON parse error** — exit 3 means the architect emitted malformed JSON; halt the pipeline and surface the error to the user.

**Verify TASK_SKELETON exists**: after `split-design.js` runs, check that `{run_dir}/outputs/blocks/task-skeleton.json` was produced. If missing (architect skipped the block), do NOT proceed — Phase 4.5 will fail without it. Re-dispatch the architect via `SendMessage` with: `"Your design file is missing the TASK_SKELETON block. Read templates/blocks/task-skeleton.example.json and add the block to {run_dir}/outputs/phase-2-architecture.md now — same conversation, do not redo the rest of the design."` Then re-run `split-design.js`.

Downstream phases (3, 4, 5) read these side files instead of the markdown. The orchestrator no longer pulls `phase-2-architecture.md` into context — that file is the human-narrative artifact for the Phase 2 gate review only.

**Update scratchpad**: Set Phase 2 Status to COMPLETED. The approved design already lives at `outputs/phase-2-architecture.md` (architect-written — do not re-write or re-read it). From the `outputs/blocks/*.json` side files (not the markdown), extract and store in the scratchpad (`{run_dir}/scratchpad.md`): Affected Contracts, Affected Services, Contract Edit Order, Spec Edit Order, and the auto-detected phase flags:
- Contracts Required = Yes if architect's AFFECTED_CONTRACTS is non-empty (not `N/A`)
- Frontend Required = Yes if architect's design includes frontend changes AND config has a frontend repo
- Mock Required = Yes if config has a mock-server repo AND architect didn't explicitly exclude it
- Infra Required = Yes if architect flagged infrastructure impact AND config has an infra repo
- Cross-Repo Integration = the architect's AFFECTED_SERVICES `cross_repo_integration` boolean (drives the Phase 6 assessor spin-up decision; store `cross_repo_rationale` alongside it for the skip log)

Set Current Phase to "Phase 3a: Contract Edit" if contracts are affected, otherwise "Phase 3b: Spec Edit".

---
