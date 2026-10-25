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
6. **Screens are the real product UI, not a scratchpad.** The HTML a stakeholder approves must
   look and behave like the shipped product: one screen = one file (tab panels inline, never one
   file per tab), product copy only (no `FR-/EC-/GAP-`, status-mapping, or developer-voice text in
   the UI), and visibility toggles that actually work on load. These are binding invariants of the
   ux-consultant's `MODE: mock` and are backstopped by the Step-4a scan.

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

If the split fails (exit 3) or the index file is empty, re-dispatch a **fresh** product-owner
(same subagent_type + fallback chain) with: `"The requirements at
{draft_dir}/requirements-round1.md are missing a valid REQUIREMENTS_INDEX block (or its JSON is
malformed). Read that file, fix/re-emit the block in place — do not redo the prose."` Then re-run
the split. (Agents do not persist across dispatches and cannot be continued — always re-dispatch
fresh and point at the on-disk file; never rely on `SendMessage`.) The gate must NEVER open on a
document whose REQUIREMENTS_INDEX doesn't materialize.

#### Requirements gate (after Round-1 PO, BEFORE any UX work)

The Developer approves the requirements **before** the ux-consultant runs — the UX agent must
never work from un-approved requirements.

Open the gate:

```bash
node {plugin_dir}/scripts/gate.js open --run-dir={draft_dir} --phase=requirements --gate=approval --question="Approve requirements for {feature-slug} before mocking?"
```

Present the PO digest (FR count, EC count, summary) and two options:
- `approve` — proceed to the UX dispatch below.
- `adjust` — collect the Developer's pushback verbatim, re-dispatch a **fresh** product-owner
  (same subagent_type + fallback chain as above) with the pushback plus `"Revise the requirements
  at {draft_dir}/requirements-round1.md in place and re-emit the REQUIREMENTS_INDEX block."`,
  re-run the split, then re-open this gate. Requirements adjustments are **not** capped — the flow
  does not continue until requirements are approved.

Close the gate after the answer (both branches):

```bash
node {plugin_dir}/scripts/gate.js close --run-dir={draft_dir}
```

#### Resolve the frontend repo (design-system source for UX)

Read `{workspace_root}/{slug}/config.json` and select the repo whose `role` is `frontend`; set
`{frontend_repo_path}` to its `path`. If exactly one `frontend` repo exists, use it; if several,
pick the one the feature most plausibly targets (ask the Developer if ambiguous); if none, set
`{frontend_repo_path}` = `(none)` — tell the UX consultant there is no design system to match and
to use clean, neutral styling (and say so in the spec).

#### Dispatch the ux-consultant (Round 1)

**Tool**: `Agent`  
**subagent_type**: `pipecrew:ux-consultant`  
**description**: `"Mock screens — {feature-slug} (Round 1)"`

Fallback: if `pipecrew:ux-consultant` is not in the harness agent registry (plugin-namespaced
agents can drop out mid-session), fall back to `general-purpose` with the preamble `"Read and
behave as the agent defined at {plugin_dir}/agents/ux-consultant.md, then:"`. **Apply this same
fallback to every ux-consultant dispatch below** (Round 2, adjust pass, Step-4a scan-fix pass).

Prompt (the `MODE: mock` first line triggers the agent's **Mock Mode** — spec + self-contained
approvable HTML screens; its binding HTML-authoring invariants live in `agents/ux-consultant.md`):

```
MODE: mock

Produce a structured IMPLEMENTATION_SPEC and a set of self-contained static HTML screens that
together simulate the feature's flow, based on the requirements below. Follow every Mock Mode
invariant in your system prompt (one screen = one file with tab panels inline, product copy only
— no FR/EC/GAP or status-mapping text in the UI, a CSS default-state rule for every JS-toggled
class, self-containment, design-system match).

REQUIREMENTS:
{content of {draft_dir}/requirements-round1.md}

TARGET FRONTEND REPO: {frontend_repo_path}   (or "none — use neutral styling")
DESIGN SYSTEM: read this repo's DESIGN_SYSTEM.md (resolve via config.repos[*].design_system_path,
else probe agent-context*/common/DESIGN_SYSTEM.md, docs/DESIGN_SYSTEM.md, DESIGN_SYSTEM.md) and
study 1–2 existing feature screens for established layout/component patterns. Name the REAL
design-system components (the actual table / card / button / dialog components) per screen in the
IMPLEMENTATION_SPEC so /deliver Phase 5b builds with them.

IMPLEMENTATION_SPEC FILE: {draft_dir}/implementation-spec-round1.md
SCREENS DIR: {draft_dir}/screens/   (write ONE file per screen as {screen-name}.html)

Output format for the spec file:
<!-- BEGIN IMPLEMENTATION_SPEC -->
{structured spec — screens list with the REAL component names per screen, per-screen states, and
an explicit FLOW section: the entry screen and the ordered screen-to-screen transitions}
<!-- END IMPLEMENTATION_SPEC -->

Write the full spec to the IMPLEMENTATION_SPEC FILE. Return only a digest: screen count, the entry
screen, key design decisions, and which design system you matched.
```

After the ux-consultant returns: verify `{draft_dir}/implementation-spec-round1.md` exists
and contains the `<!-- BEGIN IMPLEMENTATION_SPEC -->` delimiters.

#### Round 2

> Agents do not persist across dispatches and cannot be continued — both Round-2 steps dispatch a
> **fresh** agent and pass the prior artifacts by path/content. Never rely on `SendMessage`.

**Dispatch a FRESH product-owner (coverage validation).** Same `{slug}-product-owner` +
fallback chain as Round 1.

```
You previously authored the requirements for this feature. Validate that every FR and EC is
addressed by the UX consultant's IMPLEMENTATION_SPEC and screens; identify any uncovered
requirements.

YOUR ROUND-1 REQUIREMENTS: {draft_dir}/requirements-round1.md    (read this file)
UX IMPLEMENTATION_SPEC:    {draft_dir}/implementation-spec-round1.md  (read this file)

Produce {draft_dir}/requirements-round2.md incorporating any clarifications. Retain the
REQUIREMENTS_INDEX block — update it if any FR/EC changed. Return a coverage gap summary
(or "no gaps found").
```

Re-run the split on `requirements-round2.md` and confirm the index still materializes (same check
+ fresh re-dispatch recovery as Round 1).

**Dispatch a FRESH ux-consultant (finalize).** Same subagent_type + fallback as the Round-1 UX
dispatch.

```
MODE: mock

You are finalizing mock screens drafted for this feature. Incorporate the product-owner's round-2
coverage review. Every Mock Mode invariant in your system prompt still applies (one screen = one
file with tab panels inline, product copy only — no FR/EC/GAP/status-mapping text in the UI, a CSS
default-state rule for every JS-toggled class, self-containment, design-system match).

PO COVERAGE REVIEW: {PO's round-2 response summary}
ROUND-1 SPEC:    {draft_dir}/implementation-spec-round1.md    (read this file)
ROUND-1 SCREENS: {draft_dir}/screens/    (read the existing files — build on them, don't start over)
TARGET FRONTEND REPO: {frontend_repo_path}    — keep matching its design system (see Round 1).

Write the final spec to {draft_dir}/implementation-spec-round2.md (retain the IMPLEMENTATION_SPEC
delimiters, the real component names, and the FLOW section with the entry screen + transitions).
Update the HTML screens in {draft_dir}/screens/ (overwrite as needed), preserving the
self-containment rule and the review-only relative-link navigation between screens.
Return a digest of what changed.
```

**HARD CAP**: After round 2, STOP regardless of remaining coverage gaps. Surface any gaps
in the draft (Step 4). Do NOT dispatch a third round.

---

### Step 4: pre-gate screen scan + draft presentation + gate

#### 4a: pre-gate screen scan (BEFORE the gate)

Run three mechanical scans over each `*.html` file in `{draft_dir}/screens/`. Scans **B** and **C**
look only at rendered markup — ignore matches inside `<!-- -->` comments and `<script>` bodies.

**Scan A — self-containment (EC-7).** External-resource patterns:
- `src="http` or `src="//`
- `href="http` or `href="//`
- `<link rel=` pointing outside the file
- `@import url(http`

(Relative `.html` links between screens are the review-only flow aid — NOT violations; this scan
only flags `http`/`//` and external `<link>`.)

**Scan B — product copy only (no traceability text in the UI).** In visible text nodes, flag any:
- requirement identifiers: `FR-\d`, `EC-\d`, `GAP-\d`
- status-code mapping artifacts: `_LEVEL_`, or `→`/`->` between ALL-CAPS status tokens
- developer-voice phrases: `will be treated as`, `will be converted to`, `additive-only`,
  `deduplication`/`dedup`, or a sample/"example" action line baked into a panel

Any hit in rendered text is a defect — that text belongs in the IMPLEMENTATION_SPEC, not on screen.

**Scan C — JS-toggled class has a CSS default-state rule.** For every class the file toggles in
script or ships in markup as a visibility utility (`hidden`, `expanded`, `collapsed`, `active`,
`open`, `show`), confirm the file's `<style>` block has a rule establishing that class's default
state (e.g. `.hidden` is used ⇒ a `.hidden { display: none … }` rule must exist). A used-but-unstyled
toggle class is the defect (it renders in the wrong state on load).

**If any scan matches:** flag the specific file + pattern in the draft (`[SELF-CONTAINMENT
VIOLATION]` for A, `[PRODUCT-COPY VIOLATION]` for B, `[TOGGLE-STATE VIOLATION]` for C), then dispatch
ONE **fresh** ux-consultant (same subagent_type + fallback) in `MODE: mock` with the combined
violation list and: `"Fix the named files under {draft_dir}/screens/ in place — read each file
first. A: inline external resources (CSS into <style>, small SVG/icon inline); keep relative .html
links between screens. B: remove the flagged traceability/developer-voice text, replacing it with
user-facing product copy (move the detail to the IMPLEMENTATION_SPEC if it isn't already there).
C: add the missing CSS default-state rule for each flagged toggle class."` Re-run the scans after it
responds. If a violation persists after one fix attempt, surface it in the draft as an unresolved
warning — do not loop.

The gate MUST NOT open on an HTML file with an unresolved **Scan A** (self-containment) violation.
Unresolved Scan B / Scan C violations do not hard-block the gate (the scans are heuristic) but MUST
be surfaced prominently in the draft so the Developer can `adjust` or `reject`.

#### 4b: Draft render

Print the following draft for the Developer's review:

```
--- MOCK REQUIREMENTS DRAFT for: {feature-slug} ---

REQUIREMENTS (from {draft_dir}/requirements-round2.md):
{paste full content of requirements-round2.md}

IMPLEMENTATION_SPEC:
{paste content between <!-- BEGIN IMPLEMENTATION_SPEC --> / <!-- END IMPLEMENTATION_SPEC -->
from {draft_dir}/implementation-spec-round2.md}

HTML SCREENS ({N} files) — entry screen: {entry screen from the spec's FLOW section}:
{for each file in {draft_dir}/screens/: print filename, line count, <title> value, first visible heading}
To walk the flow, open the entry screen in a browser and follow the in-page links.

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

Collect the Developer's pushback verbatim. Dispatch a **fresh** product-owner and/or ux-consultant
(same subagent_type + fallback chains; dispatch the ux-consultant in `MODE: mock` so its HTML
invariants still bind) with the adjustment text, pointing each at the current round-2 artifacts to
revise in place (`requirements-round2.md` / `implementation-spec-round2.md` / `screens/`) — never
rely on `SendMessage`. One pass only: the gate re-presents after this; if the Developer rejects
again, the EC-5 branch applies (abort cleanly, no files written).

After the adjustment pass:
- Re-run the pre-gate screen scan (Step 4a — all three scans)
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
- **The approved mocks ARE the authoritative UX.** These screens and the flow between them are the
  real UX, approved by a human (often a stakeholder) — not a throwaway sketch. When `/deliver
  --from-mock` runs, the solution-architect (Phase 2) must **design the technical solution to realize
  this approved UX**, treating the screens / components / flow as fixed; it owns the HOW (backend,
  contracts, data model, routing/state plumbing) but does NOT re-decide the UX. If the architect
  finds an approved screen genuinely infeasible, it raises a `### Mock conflict` that the Phase 2
  gate surfaces for the human — the approved UX is never silently overridden. This is why the UX here
  must match the platform design system and simulate the real flow: downstream, it is binding.
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
