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

## Adding a new structured block

1. Define the schema here under "Defined block schemas".
2. Update the producer agent (e.g., the architect) to emit a ```` ```json ```` block at the top of the named section.
3. Update consumer phase files to call `node {plugin_dir}/scripts/extract-block.js {file} {NAME}` instead of asking the LLM to re-parse prose.
4. Keep prose under the JSON for human context only — never have prose contradict the JSON.

The extractor script is schema-agnostic (any valid JSON works) — no script changes needed when you add a new block.
