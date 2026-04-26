# Machine-readable file formats

Phase outputs in PipeCrew are markdown files written for humans first, but several pieces of data inside them are extracted programmatically by downstream phases. This document defines the structured blocks that downstream consumers depend on, so the producer (typically the `solution-architect`) and the consumer (a phase orchestrator) agree on schema.

## How structured blocks work

Each structured block sits inside a normal HTML-comment delimited section (`<!-- BEGIN X -->` … `<!-- END X -->`) and contains a ```` ```json ```` fenced code block as its first element. Prose follows the JSON for human context — the JSON is the source of truth.

To extract a block:

```bash
node {plugin_dir}/scripts/extract-block.js {markdown-file} {BLOCK_NAME}
```

The script emits the parsed JSON to stdout (compact, single line). Exit code 0 = success. See `scripts/extract-block.js` for other exit codes.

The orchestrator (an LLM) can read the script's stdout as-is — JSON is its natural input format. No `jq` filtering required; the LLM picks the fields it needs.

---

## Defined block schemas

### `AFFECTED_SERVICES`

**Producer**: `solution-architect` (Phase 2 design output)
**Consumers**: Phase 3 (spec edit), Phase 4 (plan), Phase 5 (build), Phase 5.5 (review), Phase 7 (report)
**File**: `{run_dir}/outputs/phase-2-architecture.md`
**Canonical example**: [`templates/blocks/affected-services.example.json`](../templates/blocks/affected-services.example.json) — the single source of truth for the structure. Update that file when the schema changes; this doc only carries the field reference table below.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `services[].name` | string | Must match a key in `config.services`. |
| `services[].spec_policy` | enum | `api-first` → has OpenAPI spec; `code-first` → contract is in `API_DESIGN` block; `no-api` → event-driven worker. |
| `services[].endpoints_added` | array | HTTP services only. Empty for workers. |
| `services[].endpoints_modified` | array | HTTP services only. |
| `services[].handlers_added` | array of strings | Worker services only (handler function names). |
| `services[].fr_ids` | array of strings | Functional requirement IDs from Phase 1 that this service owns. |
| `services[].ec_ids` | array of strings | Edge case IDs from Phase 1 that this service owns. |
| `spec_edit_order` | array of names | Order to edit specs when multiple `api-first` services are affected. |
| `frontend_required` | boolean | Drives Phase 5b skip decision. |
| `mock_required` | boolean | Drives Phase 5c skip decision. |

---

### `REQUIREMENTS_INDEX`

**Producer**: workspace product-owner agent (Phase 1 dispatch instructs it)
**Consumers**: Phase 4 (task generation), Phase 5.5 (reviewers walking FR/EC), Phase 6 (assessor)
**File**: `{run_dir}/outputs/phase-1-requirements.md`
**Canonical example**: [`templates/blocks/requirements-index.example.json`](../templates/blocks/requirements-index.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `requirements[].id` | string | Functional requirement ID, format `FR-{N}`. |
| `requirements[].summary` | string | One-line description of the requirement. |
| `edge_cases[].id` | string | Edge case ID, format `EC-{N}`. |
| `edge_cases[].summary` | string | One-line description of the boundary condition. |
| `edge_cases[].applies_to` | array of strings | FR IDs this edge case modifies (optional). |

The `services` mapping (which service owns which FR/EC) lives in `AFFECTED_SERVICES`, not here — single source of truth, no duplication.

---

### `COVERAGE`

**Producer**: every implementer agent (per common-rules R9, in its final report)
**Consumers**: code reviewers (Phase 5.5) — verify the implementer's claim against actual diff
**File**: each implementer's report (in-context, then archived to `{run_dir}/outputs/phase-5-implementer-{repo}.md`)
**Canonical example**: [`templates/blocks/coverage.example.json`](../templates/blocks/coverage.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `coverage[].id` | string | An FR-X or EC-X from the implementer's task file. Every ID in the task file MUST appear here. |
| `coverage[].file` | string | Repo-relative path to the file enforcing this requirement. |
| `coverage[].line` | number | Line number of the enforcement point. |
| `coverage[].test` | string | Optional: `path:line` of the test that exercises this requirement. Strongly preferred for EC-X entries. |

---

### `FINDINGS_SUMMARY`

**Producer**: every code reviewer (spring-boot, react, nestjs, nextjs)
**Consumers**: Phase 5.5 Step 2 (gate decision logic)
**File**: each reviewer's report (in-context, then archived to `{run_dir}/outputs/phase-5-5-code-review.md`)
**Canonical example**: [`templates/blocks/findings-summary.example.json`](../templates/blocks/findings-summary.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `critical_total` | number | Count of `critical` rows in the FINDINGS block. |
| `critical_mechanical` | number | Subset where the 5th pipe field is `mechanical`. |
| `critical_architectural` | number | Subset where the 5th pipe field is `architectural`. |
| `non_critical_total` | number | Count of `non-critical` rows. |
| `scope_total` | number | Count of `scope` rows. |

The summary is pre-computed by the reviewer so the orchestrator's gate decision in Phase 5.5 Step 2 is one extract call instead of a row-counting LLM pass per report. Detail rows still live in the FINDINGS block — both are emitted side-by-side.

---

## Adding a new structured block

1. Define the schema here under "Defined block schemas".
2. Update the producer agent (e.g., the architect) to emit a ```` ```json ```` block at the top of the named section.
3. Update consumer phase files to call `node {plugin_dir}/scripts/extract-block.js {file} {NAME}` instead of asking the LLM to re-parse prose.
4. Keep prose under the JSON for human context only — never have prose contradict the JSON.

The extractor script is schema-agnostic (any valid JSON works) — no script changes needed when you add a new block.
