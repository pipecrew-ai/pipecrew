# /discover — efficiency enhancement plan

**Goal**: cut a typical 4-repo `/discover` run by ~40-50% wall-clock and tokens with no UX change.

> **Status as of 2026-05-31**: Wins #1, #2, #3, and #5 are CLOSED. Wins #4 and #6 remain open. See "What shipped / what's open" at the bottom. (Note: Win #5 was already shipped before this plan was written — the merged `context-manager` flow lives in `phase-c-generation.md` Step 2. The doc previously listed it as open due to a status-tracking lag.)

**Diagnosis** (still accurate post-B2.5 removal):

- Phase B2 is one Opus dispatch reading every repo's code in series (~80–120k Opus tokens). **This is the dominant remaining cost.**
- Phase C.4 (CLAUDE.md) and Phase C.5 (agent-context) dispatch `context-manager` per repo with mostly overlapping inputs.
- Re-running `/discover` on a workspace re-scans every repo even when nothing changed.

---

## The six wins, with current status

### 1. Pre-scan repos into a manifest (one JS script, no LLM) — ❌ REJECTED

Built `scripts/extract-repo-manifest.js` (zero-deps Node, regex-based) on a feature branch + tested it end-to-end against ABVI (11 repos in 700ms, found 2 real categorizer misses, fixed them). On reflection: the categorizer maintenance burden outweighed the savings. File reads aren't the bottleneck — Opus reasoning is. Stack-aware bucketing creates a maintenance surface that drifts as conventions evolve.

**Decision**: branch dropped, no manifest generated. Conventions stay implicit (architect reads what it needs; R10 keeps implementers from inventing).

If we ever want a *lite* version (just a flat file list + parsed dep manifest, no categorizer), that would be ~100 lines and could be reconsidered. Not on the roadmap right now.

### 2. Run B2.5 in parallel with B2 — ⚪ MOOT

Phase B2.5 was deleted entirely as a bigger simplification (commit `65a90e3` on 2026-05-05). The discipline that B2.5's per-stack convention docs implicitly enforced is now explicit via R10 in `docs/implementer-common-rules.md` and gate-checked by reviewers via the new Pattern Adherence pass. There's no longer a B2.5 to parallelize against B2.

### 3. Split B2 into Sonnet-discovery + Opus-synthesis — ✅ SHIPPED

Same pattern as the recent `/deliver` Phase 2 / 4.5 split. Current B2 = one Opus dispatch reading all repos. Split into:

- **B2.0 — Per-repo discovery**: parallel Sonnet, one `repo-discoverer` agent per repo, scans that repo's code, emits a structured `REPO_PROFILE` JSON (entities, routes, integration points, framework version, key conventions seen, audit findings).
- **B2 — Cross-repo synthesis**: one Opus `solution-architect` dispatch reads just the JSON profiles + per-repo CLAUDE.md (if any), writes platform.md + audit-findings.md + the two diagrams.

Same Opus depth on the synthesis (where it matters); Sonnet does the bulk per-repo reading in parallel.

- **Estimated saving**: B2 peak Opus cost ~50% lower (architect's input size collapses from "all repos" to "11 small JSON files + per-repo CLAUDE.md"). Wall-clock similar or slightly better (parallel Sonnet > serial Opus reading even when followed by Opus synthesis).
- **Risk**: medium. New agent + new schema + ordering dependency (B2 must wait for B2.0 to finish).

**Branch**: `feat/split-b2-architect` (in progress — see below).

### 4. Add an outline-gate before full architect synthesis — 📋 OPEN

Sonnet produces a 5k "platform outline" (sections + 1-line each), user approves the structure, then Opus writes the full `platform.md`. Most "I want to redo this" feedback happens at the structural level — catch it after a 5k pass instead of after a 100k pass.

- **Pattern source**: matches `--minimum-only` from `/deliver` Phase 4.5 (cheap preview before expensive commit).
- **Saving**: avoids wasted Opus tokens when the user wants major direction changes — one full `/discover` run rejected at gate today is more wasteful than three preview cycles tomorrow.
- **Risk**: low.

Naturally pairs with Win #3 — once architect synthesis is its own dispatch (post-Win-#3), inserting an outline pass before it is a clean addition.

### 5. Combine Phase C.4 + Phase C.5 into one context-manager dispatch per repo — ✅ SHIPPED (pre-dating this plan)

Already done. `phase-c-generation.md` Step 2 reads: *"Replaces the former Step 2 (CLAUDE.md generator) + Step 4 (agent-context generator). Both artifacts are now produced by a single `context-manager` dispatch per repo — the deep read happens once, agent-context is written first, CLAUDE.md is written as a thin index that references agent-context."* Likely landed in `7f6b62e` (the role-based agent-context templates commit).

The status was tracked as Open in this doc due to a tracking lag — the actual code shipped before this enhancement plan was written.

### 6. Cache per-repo scan output across runs (head_sha-keyed) — 📋 OPEN

Hash each repo's `git rev-parse HEAD`. On `/discover --resume` skip repos whose HEAD hasn't moved since the last run; only re-scan changed ones.

- **Pattern source**: `/context-refresh` already uses `runs/context-refresh/state.json`.
- **Mechanism**: write `{workspace_root}/{slug}/runs/discover/state.json` recording per-repo `head_sha` + `ran_at`. Decision tree at the top of B2.0.
- **Saving**: huge for monorepos where most repos are stable but one moves. First-run benefit is zero.
- **Risk**: low. Read-only optimization that falls back to a full scan on any uncertainty.

Pairs naturally with Win #3 (which introduces the per-repo profile that's the cacheable artifact). Cleanest landing order: #3 → #6.

---

## Smaller cleanups worth bundling

- **B3 ↔ B2 overlap**: have B2 emit a `FRONTEND_SIGNALS` block (component library, design system signals, etc.). B3 only runs if B2 didn't capture enough or wants depth. Avoids re-reading every component file. Becomes mostly free once Win #3 lands — the per-repo discoverer for frontends can populate FRONTEND_SIGNALS directly.
- **Phase D inline report**: today the orchestrator writes the Phase D summary inline. Could route through the existing `reporter` agent (Haiku, ~5k) for richer trend comparison across discover runs. Optional.

---

## Updated sequencing (after closing #1 and #2)

1. **Win #3 (in progress)**. Biggest single lever. Foundation for #6.
2. **Win #5**. Cheapest. Independent of #3.
3. **Win #6**. Compounds with #3 — `state.json` keys per-repo profile reuse.
4. **Win #4**. Tightens the gate UX once #3 has the synthesis dispatch separated out.

After all four: typical `/discover` runs at roughly half the current Opus cost, comparable wall-clock (parallel Sonnet covers the new B2.0 step), and a re-run on an unchanged workspace is nearly free.

---

## What shipped / what's open

| # | Win | Status | Branch / commit |
|---|---|---|---|
| 1 | Pre-scan manifest | ❌ Rejected | branch dropped |
| 2 | Parallel B2 + B2.5 | ⚪ Moot (B2.5 deleted) | `65a90e3` (B2.5 removal) |
| 3 | Split B2 (Sonnet + Opus) | ✅ Shipped | merged in PR #7 (`ec12019`) — Phase B2.0 dispatches `repo-discoverer` per repo in parallel; Opus B2 synthesizes from per-repo `REPO_PROFILE` JSON files |
| 4 | Outline gate | 📋 Open | — pairs naturally with Win #3; cheap Sonnet preview before Opus synthesis |
| 5 | Merge C.4 + C.5 | ✅ Shipped (pre-dating this plan) | `phase-c-generation.md` Step 2 already merges CLAUDE.md + agent-context into a single `context-manager` dispatch per repo in `mode: full` — likely landed in `7f6b62e` (role-based agent-context templates) |
| 6 | head_sha cache | 📋 Open | — would key off the now-shipped `REPO_PROFILE` `head_sha` field |
| — | B3↔B2 overlap (sub-cleanup) | 📋 Open, unblocked by #3 | — `repo-discoverer` already populates `frontend_signals` per repo; B3 could now read those instead of re-walking |
| — | Phase D reporter agent | 📋 Open, optional | — |

---

## Open question

`/discover` doesn't currently dispatch a `reporter` agent at Phase D. The `reporter` could be reused at end-of-run to produce a richer summary + trend comparison across `runs/discover/{run_id}/checkpoints.jsonl` files. This is orthogonal to the six wins but would make `state.json` (Win #6) more useful to a human reader.
