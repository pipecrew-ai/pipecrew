# Structured-Block Extractor Enhancement

**Date**: 2026-04-26
**Branch**: `feat/multi-stack-spec-policy`
**Commits**: `daf272c` (scaffold) + `d0dda7f` (rollout) + this round (multi-stack frontend + docstring tightening)
**Independent of the Karpathy assessment** — this is a separate efficiency optimization, not a principle alignment.

---

## Problem

Phase outputs (architect, product-owner, implementers, reviewers) are markdown files written for humans first. But several pieces of data inside them — service lists, requirement IDs, finding counts, coverage maps — are extracted programmatically by downstream phases.

Before this enhancement, every consumer LLM-parsed the entire prose file to pull those data points. The same architect output (`outputs/phase-2-architecture.md`, typically 3–5K tokens) was re-read by Phases 3, 4, 5, 5.5, and 7 — five separate full-file reads per `/deliver` run, each one with attention spent on extracting structured fields from sentences.

## Solution

A two-piece pattern:

1. **Producers embed a fenced ```` ```json ```` code block** inside each `<!-- BEGIN BLOCK_NAME -->` section. The JSON is the canonical source of truth; prose follows for human context but never overrides the JSON.
2. **Consumers call a generic Node script** that pulls the JSON out, parses it, and emits compact JSON to stdout. No LLM parsing.

```bash
node {plugin_dir}/scripts/extract-block.js outputs/phase-2-architecture.md AFFECTED_SERVICES
# → {"services":[{"name":"publisher-service","spec_policy":"api-first",...}],"frontend_required":true,...}
```

Schema definitions for every block live in a single canonical location: `templates/blocks/{name}.example.json`. Both the producer agent prompt and `docs/file-formats.md` reference the example file rather than duplicating the schema inline. Add a field → edit one file.

---

## What was built

### Script
| File | Lines | Description |
|------|-------|-------------|
| `scripts/extract-block.js` | 70 | Zero-dep Node. Schema-agnostic — works for any future block. Exit codes for file-missing / block-missing / no-fence / parse-error. |

### Canonical template files (single source of truth per block)
| File | Block | Producer | Consumers |
|------|-------|----------|-----------|
| `templates/blocks/affected-services.example.json` | `AFFECTED_SERVICES` | `solution-architect` | Phases 3, 4, 5, 5.5 |
| `templates/blocks/requirements-index.example.json` | `REQUIREMENTS_INDEX` | workspace `product-owner` | Phases 4, 5.5, 6 |
| `templates/blocks/coverage.example.json` | `COVERAGE` | every implementer (R9) | code reviewers |
| `templates/blocks/findings-summary.example.json` | `FINDINGS_SUMMARY` | every reviewer | Phase 5.5 Step 2 (gate decision) |

### Documentation
| File | Purpose |
|------|---------|
| `docs/file-formats.md` | Schema reference for all 4 blocks. Explains the pattern + how to add a new block. |
| `skills/deliver/SKILL.md` § Utility scripts | Inventory of all 5 plugin scripts so the orchestrator knows what's available before any phase runs. |

### Migrated consumer phases
- `skills/deliver/phases/phase-3-spec-edit.md` — Step 0 uses extractor
- `skills/deliver/phases/phase-4-plan.md` — Phase 4.5 task generation uses extractor
- `skills/deliver/phases/phase-5-build.md` — Phase 5a dispatch loop uses extractor
- `skills/deliver/phases/phase-5.5-code-review.md` — Step 1 dispatch + Step 2 gate decision use extractor

### Multi-stack frontend (this round)
- Phase 5b (`phase-5-build.md`) — frontend implementer dispatch is now type-aware via `TYPE_TO_AGENT` (`react` → `react-feature-implementer`, `nextjs` → `nextjs-implementer`). Was hardcoded to react.
- Phase 5.5 frontend reviewer — same fix applied. Was hardcoded to `react-code-reviewer`.
- Frontend reviewer dispatch prompt is now framework-agnostic — drops React-specific phrasing, delegates "framework-specific passes" to the reviewer's system prompt.
- Brittle step-number references in the dispatch (`per your system prompt (step 7)`) replaced with descriptive references (`per your system prompt's scope-drift step`). Stable across reviewer agent renumbering.
- Step 1.5 docstring tightened — drops "Step 8 of the dispatch prompt" indirection; now points directly at the reviewer's classification step.

---

## Impact estimates

### Token cost — per `/deliver` run, before vs. after

The cost model: each LLM-parse of a phase output reads the entire file into context to extract a few structured fields. Replacing that with the extractor means a tiny stdin/stdout JSON exchange, no full-file LLM pass.

| Operation | Before (LLM parse) | After (extract-block.js) | Per-run delta |
|-----------|-------------------:|------------------------:|--------------:|
| Phase 3 reads `AFFECTED_SERVICES` | ~3-5K | ~0.2K | −2.8 to −4.8K |
| Phase 4 reads `AFFECTED_SERVICES` | ~3-5K | ~0.2K | −2.8 to −4.8K |
| Phase 5 reads `AFFECTED_SERVICES` | ~3-5K | ~0.2K | −2.8 to −4.8K |
| Phase 5.5 reads `AFFECTED_SERVICES` | ~3-5K | ~0.2K | −2.8 to −4.8K |
| Phase 4 reads `REQUIREMENTS_INDEX` | ~2-4K | ~0.3K | −1.7 to −3.7K |
| Phase 5.5 reads `REQUIREMENTS_INDEX` | ~2-4K | ~0.3K | −1.7 to −3.7K |
| Phase 6 reads `REQUIREMENTS_INDEX` | ~2-4K | ~0.3K | −1.7 to −3.7K |
| Reviewer reads each implementer's `COVERAGE` | ~1-2K × N implementers | ~0.2K × N | −0.8 to −1.8K × N |
| Phase 5.5 Step 2 counts `FINDINGS_SUMMARY` | ~1-3K × N reviewers | ~0.1K × N | −0.9 to −2.9K × N |

**Per-run total (typical 3-service feature with 1 frontend):**
- Lower bound: ~17K tokens saved
- Upper bound: ~30K tokens saved

**Cost added (loaded once at run start):**
- Utility scripts inventory in SKILL.md: ~250 tokens
- Net: still 16-29K saved per run.

### Iteration impact

Token reduction matters less in absolute terms than what it enables:
- Larger features fit in a single `/deliver` run without auto-compaction kicking in mid-pipeline.
- Resumes from `--resume` are cheaper because the orchestrator re-loads less prose to rebuild state.
- Phase 5.5 gate decision is now a deterministic CLI call rather than an LLM-counted-rows-and-might-miscount judgment.

### Reliability impact (harder to quantify, real)

| Class of failure | Before | After |
|------------------|--------|-------|
| LLM miscounts FINDINGS rows → wrong gate decision | Possible | Eliminated (script counts pre-computed by reviewer) |
| LLM hallucinates a service name not in the architect's list | Possible | Eliminated (script returns exact JSON from producer) |
| Schema drift between docs and agent prompt | Frequent risk | Single source of truth in `templates/blocks/` |
| Step-number drift in dispatch prompts | Caused stale references | Replaced with descriptive references that survive renumbering |

---

## What's NOT migrated (out of scope for this round)

- `outputs/phase-2-architecture.md` blocks other than `AFFECTED_SERVICES` — `API_DESIGN`, `DATA_MODEL`, `INFRASTRUCTURE_IMPACT`, `RISKS`, `FRONTEND_ARCHITECTURE`, `CONTRACT_DESIGN` are still prose-only. They're consumed less frequently and the prose has narrative value (rationale, context). Could be migrated later if a specific consumer benefits.
- Phase 1 dispatch prompt — the workspace product-owner agent template (`templates/agents/product-owner.md.template`) was NOT updated. Existing workspace agents already follow the phase-1 dispatch instructions (which now require the structured block), so the change propagates at run time. The template update is cosmetic and can come later.
- The `nextjs-reviewer` migration assumes a workspace's frontend repo has `type: nextjs` configured in `config.json`. Workspaces onboarded before nextjs detection landed may need `/discover --resume` to update.

---

## Reproducibility — how to verify

```bash
# 1. Verify all canonical example files are valid JSON.
cd {plugin_dir}
for f in templates/blocks/*.example.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "OK $f"
done

# 2. End-to-end smoke test: synthesize a markdown with all 4 blocks, extract each.
# (See the test in commit d0dda7f's commit message body for the exact fixture.)
```

Both passed at commit time. Re-run after any schema change.

---

## Next opportunities (not committed)

1. **Migrate the remaining architect blocks** (`API_DESIGN`, `DATA_MODEL`, etc.) if a clear consumer pain emerges.
2. **Add an `--validate` flag to extract-block.js** that checks output against a JSON Schema co-located with the example file. Cost: ~30 lines + a JSON Schema per block. Value: catches producer drift early.
3. **Add a `--field` filter to extract-block.js** so consumers can pull a single field without piping to `jq`. Cost: ~10 lines. Value: shorter consumer commands.
4. **Update `templates/agents/product-owner.md.template`** so newly-discovered workspaces emit `REQUIREMENTS_INDEX` natively without depending on the phase-1 dispatch prompt.
