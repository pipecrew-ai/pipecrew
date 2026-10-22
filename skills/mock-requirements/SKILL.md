---
name: mock-requirements
description: "Author a feature's requirements + static HTML mock screens in a capped 2-round product-owner↔ux-consultant session. Persists a complete artifact under {workspace_root}/{slug}/mocks/{feature-slug}/ on approval. Artifact is reused by /deliver --from-mock to skip Phase 1 (product-owner) and inject the IMPLEMENTATION_SPEC into Phase 5b. Standalone — does not start /deliver automatically."
---

## Usage
```
/mock-requirements <feature description> [--workspace=<slug>]   # create or update an artifact
/mock-requirements status [--workspace=<slug>]                   # list artifacts under {ws}/mocks/
```

### Flags
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--workspace` | no | auto-detect | Workspace slug — resolved via the registry |

### Examples
```
/mock-requirements "publishers choose contract type"
/mock-requirements "bulk book status change" --workspace=dal-platform
/mock-requirements "add 2FA to login flow"
/mock-requirements status
/mock-requirements status --workspace=dal-platform
```

## Instructions

### CRITICAL RULES

1. **Read-isolation.** The directory `{workspace_root}/{slug}/mocks/` is consumed ONLY by
   this skill (writer) and `/deliver --from-mock` (reader). **Never** add a pointer to it in
   `platform.md`, `AGENTS.md`, repo context docs, or any ambient-context file. `status` reads
   only the directory listing — never file contents. This invariant is identical to the one for
   `testcases/` in `/design-tests`.
2. **Gate before persist.** Artifacts are written to `{ws}/mocks/{feature-slug}/` ONLY after
   the Developer explicitly approves at the gate. No exceptions, including re-runs over an
   existing artifact.
3. **Never hand-edit artifacts.** All writes to `mocks/` go through this skill's persist step.
   If something looks wrong in a persisted file, re-run the skill — do not patch inline.
4. **Full-scope product-owner.** The product-owner MUST be dispatched at FULL scope: all WHAT
   (functional, visual, AND non-visual behavior, edge cases). Never scope it to screens only —
   the whole point of this skill is that `/deliver --from-mock` skips Phase 1, so partial
   requirements would propagate downstream unseen.
5. **Reject means no files written.** If the Developer rejects the draft at the gate without
   requesting an adjustment, zero bytes are written or overwritten under `{ws}/mocks/`.

---

### Step 1: Resolve workspace + mode

Resolve the workspace from the registry:

```bash
node {plugin_dir}/scripts/workspace-registry.js --resolve --json
```

(Add `--workspace=<slug>` if it was passed.) On success it prints `{slug, path, root}` — set
`{slug}` = `.slug` and `{workspace_root}` = `.root`. If it exits 3, ask which slug if several;
tell the user to run `/discover` first if none.

Mode check:
- `status` argument → **Step 5 (status)** only.
- Otherwise → set `{feature_description}` from the invocation argument and enter the draft flow.

---

### Step 1.5: Check for existing artifact (overwrite warning)

Derive the feature slug from the feature description (see Step 2 — slug rule). Then check
whether the artifact directory already exists:

```bash
node {plugin_dir}/scripts/mock-artifact.js --validate={feature-slug} --mocks-dir={workspace_root}/{slug}/mocks
```

If the directory exists (exit code 0 or 1 — present but possibly invalid), print this warning
**before** starting the draft phase:

```
⚠ A prior artifact exists for `{feature-slug}` and will be replaced if you approve the new
  draft. The existing artifact is left intact if you reject.
```

Then **continue** — do NOT stop here. The overwrite happens only on gate approval.

---

### Step 2: Slug derivation

Derive `{feature-slug}` from the feature description: lowercase, replace any run of
non-alphanumeric characters with a single `-`, strip leading/trailing dashes, truncate to
24 characters.

Example: `"Publishers choose contract type"` → `publishers-choose-contrac`

This is the same rule `/deliver`'s pre-flight uses (Step 2 in `phases/pre-flight.md`), so
`--from-mock=<slug>` resolves to the same path.

Set `{draft_dir}` = `{workspace_root}/{slug}/runs/mock-requirements/{YYYY-MM-DD-HHMMSS}/`
and create it (runs/ is local-only — never synced).

---

### Step 3: Orchestration — Capped 2-round PO↔UX collaboration

#### Round 1

**Dispatch the workspace product-owner at FULL scope.**

**Tool**: `Agent`  
**subagent_type**: `{slug}-product-owner`  
**description**: `"Mock requirements — {feature-slug} (Round 1)"`

Fallback: if `{slug}-product-owner.md` is not in the harness user-level agents dir, fall back
to `general-purpose` with the preamble `"Read and behave as the agent defined at
{workspace_root}/{slug}/agents/product-owner.md, then:"`.

Prompt the product-owner with:

```
Produce a COMPLETE requirements document for this feature. This is the FULL scope — all WHAT
(functional, visual, AND non-visual behavior, edge cases). Do NOT scope to screens only.
Do NOT include HOW (no endpoint paths, request/response shapes, UI layouts, component choices).

Feature: {feature_description}

REQUIREMENTS FILE: {draft_dir}/requirements-round1.md

Produce all FR-X and EC-X items. You MUST include a valid REQUIREMENTS_INDEX block:

<!-- BEGIN REQUIREMENTS_INDEX -->
```json
{ "requirements": [...], "edge_cases": [...] }
```
<!-- END REQUIREMENTS_INDEX -->

Write the complete document to the REQUIREMENTS FILE. Return only a digest: FR count, EC count,
summary paragraph. The digest must let the user judge scope without opening the file.

CRITICAL: The REQUIREMENTS_INDEX block is load-bearing — a missing or malformed block will
cause this run to fail. Emit it even if requirements are still evolving. Self-check: every
FR-X and EC-X in the prose must appear in the JSON block (counts must match).
```

After the product-owner returns: verify `{draft_dir}/requirements-round1.md` exists. Run:

```bash
node {plugin_dir}/scripts/split-design.js {draft_dir}/requirements-round1.md
test -s {draft_dir}/blocks/requirements-index.json
```

If the split fails (exit 3) or the index file is empty, re-dispatch the product-owner via
`SendMessage`: `"Your REQUIREMENTS_INDEX block is missing or invalid JSON. Re-emit it — same
conversation, do not redo the prose."` Then re-run the split. The gate must NEVER open on a
document whose REQUIREMENTS_INDEX doesn't materialize.

**Dispatch the ux-consultant.**

**Tool**: `Agent`  
**subagent_type**: `pipecrew:ux-consultant`  
**description**: `"Mock screens — {feature-slug} (Round 1)"`

Prompt:

```
Produce a structured IMPLEMENTATION_SPEC and one self-contained static HTML file per screen,
based on the requirements below.

REQUIREMENTS:
{content of {draft_dir}/requirements-round1.md}

IMPLEMENTATION_SPEC FILE: {draft_dir}/implementation-spec-round1.md
SCREENS DIR: {draft_dir}/screens/

Output format for the spec file:
<!-- BEGIN IMPLEMENTATION_SPEC -->
{structured spec — screens list, component descriptions, flow notes}
<!-- END IMPLEMENTATION_SPEC -->

For each screen named in the spec, write a self-contained HTML file to
{draft_dir}/screens/{screen-name}.html. SELF-CONTAINMENT RULE (non-negotiable):
- ALL CSS must be in an inline <style> block — no external stylesheets
- No CDN script tags (no <script src="https://...">)
- No external font imports (@import url(https://...))
- No framework build steps
The HTML must render correctly from the local filesystem.

Write the full spec to the IMPLEMENTATION_SPEC FILE. Return only a digest: screen count,
key design decisions.
```

After the ux-consultant returns: verify `{draft_dir}/implementation-spec-round1.md` exists
and contains the `<!-- BEGIN IMPLEMENTATION_SPEC -->` delimiters.

#### Round 2

**Re-dispatch the product-owner (coverage validation) via `SendMessage`.**

Send to the still-open product-owner agent:

```
Validate that every FR and EC you produced is addressed by the UX consultant's
IMPLEMENTATION_SPEC and screens. Identify any uncovered requirements.

UX IMPLEMENTATION_SPEC:
{content of {draft_dir}/implementation-spec-round1.md}

Produce requirements-round2.md at {draft_dir}/requirements-round2.md incorporating any
clarifications. Retain the REQUIREMENTS_INDEX block — update it if any FR/EC changed.
Return a coverage gap summary (or "no gaps found").
```

**Re-dispatch the ux-consultant (finalize) via `SendMessage`.**

Send to the still-open ux-consultant agent:

```
Finalize based on the product-owner's round-2 coverage review.

PO COVERAGE REVIEW:
{PO's round-2 response summary}

Update your IMPLEMENTATION_SPEC and HTML screens as needed.
Write the final spec to {draft_dir}/implementation-spec-round2.md.
Write updated HTML screens to {draft_dir}/screens/ (overwriting as needed).
Return a digest of what changed.
```

**HARD CAP**: After round 2, STOP regardless of remaining coverage gaps. Surface any gaps
in the draft (Step 4). Do NOT dispatch a third round.

---

### Step 4: EC-7 self-containment check + draft presentation + gate

#### 4a: EC-7 self-containment check (BEFORE the gate)

For each `*.html` file in `{draft_dir}/screens/`, scan for external resource patterns:
- `src="http` or `src="//`
- `href="http` or `href="//`
- `<link rel=` pointing outside the file
- `@import url(http`

If any match is found: flag the specific file and pattern in the draft with a
`[SELF-CONTAINMENT VIOLATION]` marker, then send a `SendMessage` to the ux-consultant asking
it to inline the resource (CSS into `<style>`, small SVG/icon inline) before the gate opens.
Re-check after the UX agent responds. If the violation persists after one fix attempt, surface
it in the draft as an unresolved warning — do not loop.

The gate MUST NOT open on an HTML file with unresolved external resource references.

#### 4b: Draft render

Print the following draft for the Developer's review:

```
--- MOCK REQUIREMENTS DRAFT for: {feature-slug} ---

REQUIREMENTS (from {draft_dir}/requirements-round2.md):
{paste full content of requirements-round2.md}

IMPLEMENTATION_SPEC:
{paste content between <!-- BEGIN IMPLEMENTATION_SPEC --> / <!-- END IMPLEMENTATION_SPEC -->
from {draft_dir}/implementation-spec-round2.md}

HTML SCREENS ({N} files):
{for each file in {draft_dir}/screens/: print filename, line count, <title> value, first visible heading}

{if PO round-2 identified coverage gaps:}
**Coverage gaps (no third round — approve or request adjustment):**
{list the gaps from the PO round-2 output}
```

#### 4c: Gate

Open the gate before presenting the prompt:

```bash
node {plugin_dir}/scripts/gate.js open --run-dir={draft_dir} --phase=draft --gate=approval --question="Persist mock artifact for {feature-slug}?"
```

Present three options to the Developer:
- `approve` — persist the artifact (Step 4d below)
- `reject` — abort, no files written (Step 4e)
- `adjust` — one adjustment pass, then re-gate (Step 4f)

After receiving the Developer's answer:

```bash
node {plugin_dir}/scripts/gate.js close --run-dir={draft_dir}
```

Always close the gate — in all three branches.

#### 4d: Approve branch

Proceed to Step 4g (persist).

#### 4e: Reject branch (EC-5 — no files written)

Print:
```
No artifact persisted. The draft is available at {draft_dir} for reference.
```

**Do NOT write or overwrite any file under `{ws}/mocks/{feature-slug}/`**. Stop the skill.

#### 4f: Adjust branch (FR-5 — one pass only)

Collect the Developer's pushback verbatim. Re-dispatch the product-owner and/or ux-consultant
via `SendMessage` with the adjustment text (one pass — the gate re-presents after this; if the
Developer rejects again, the EC-5 branch applies: abort cleanly with no files written).

After the adjustment pass:
- Re-run the EC-7 self-containment check on the updated screens
- Re-render the draft (Step 4b)
- Re-open the gate (Step 4c) — showing only `approve` and `reject` (no second adjust)

#### 4g: Persist

Create the artifact layout:

```bash
mkdir -p {workspace_root}/{slug}/mocks/{feature-slug}/screens
```

Write the artifact files:

1. `{ws}/mocks/{feature-slug}/requirements.md` — copy from `{draft_dir}/requirements-round2.md`
   (must retain the REQUIREMENTS_INDEX block byte-for-byte)
2. `{ws}/mocks/{feature-slug}/implementation-spec.md` — copy from
   `{draft_dir}/implementation-spec-round2.md` (must retain the BEGIN/END IMPLEMENTATION_SPEC
   delimiters)
3. Copy each `{draft_dir}/screens/*.html` to `{ws}/mocks/{feature-slug}/screens/`
4. Write `{ws}/mocks/{feature-slug}/MOCKS_INDEX.md` listing every file and its role:

```markdown
# Mocks Index — {feature-slug}

Generated: {timestamp}

| File | Role |
|------|------|
| `requirements.md` | Full FR/EC list + REQUIREMENTS_INDEX block (reused by /deliver --from-mock Phase 1) |
| `implementation-spec.md` | UX IMPLEMENTATION_SPEC (reused by /deliver --from-mock Phase 5b) |
{for each HTML file:}
| `screens/{name}.html` | Static HTML mock — {screen description from spec} |
```

**Post-persist self-check**: run the validator to confirm the artifact is FR-8 valid:

```bash
node {plugin_dir}/scripts/mock-artifact.js --validate={feature-slug} --mocks-dir={workspace_root}/{slug}/mocks
```

If the validator exits non-zero, warn the Developer — the artifact is physically present but
invalid per FR-8. Describe the specific defect from the validator's JSON output. This should
not happen if the above steps completed correctly, but the check makes the writer/reader
contract testable in-skill.

Print:
```
[mock-requirements ✔] Artifact persisted at {ws}/mocks/{feature-slug}/
  requirements.md  ({N} FR, {M} EC)
  implementation-spec.md  ({K} screens)
  screens/  ({K} HTML files)

Reuse in /deliver: /deliver "{feature_description}" --from-mock={feature-slug}
```

---

### Step 5: status

Run:

```bash
node {plugin_dir}/scripts/mock-artifact.js --list --mocks-dir={workspace_root}/{slug}/mocks
```

Render each returned slug as one line. If no slugs:

```
No mock artifacts yet — run `/mock-requirements <feature>` to create one.
```

---

## Notes

- **Relationship to `/deliver --from-mock`**: this skill is the writer; `/deliver --from-mock`
  is the reader. The artifact layout this skill persists (`requirements.md` with REQUIREMENTS_INDEX,
  `implementation-spec.md` with IMPLEMENTATION_SPEC delimiters, `MOCKS_INDEX.md`) is the exact
  layout `/deliver` validates with `scripts/mock-artifact.js`. Contract changes here must be
  mirrored there.
- **Structural parallel to `/design-tests`**: this skill is modeled on `/design-tests` — same
  draft → gate → persist flow, same read-isolation invariant, same `{ws}/mocks/` privacy contract.
  The key differences: two agents (PO + UX) vs one (`test-designer`); per-feature subdirectory
  (`mocks/{slug}/`) vs flat; full-replace overwrite vs supersede-with-retire.
- **Product-owner scope**: the product-owner must run at FULL scope — all WHAT, visual AND
  non-visual. This is not a screens-only requirement pass. The rationale: when `/deliver
  --from-mock` skips Phase 1, it seeds `phase-1-requirements.md` directly from this artifact.
  Partial requirements would propagate through the entire delivery pipeline unseen.
- **The round cap is absolute**: exactly 2 rounds, period. Coverage gaps surfaced after round 2
  appear in the draft for the Developer to decide — they do NOT trigger a third round.
- **ADR-002**: the design decisions and alternatives considered for this skill are recorded in
  `context/adrs/ADR-002-mock-requirements-skill.md`.
