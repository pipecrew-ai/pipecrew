# /discover — efficiency enhancement plan

**Goal**: cut a typical 4-repo `/discover` run by ~40-50% wall-clock and tokens with no UX change.

> **Status as of 2026-05-31**: Wins #1, #2, #3, #5, and #6 are CLOSED. Win #4 (outline gate) and Win #7 (downstream artifact caching) are open. See "What shipped / what's open" at the bottom. (Note: Win #5 was already shipped before this plan was written — the merged `context-manager` flow lives in `phase-c-generation.md` Step 2. The doc previously listed it as open due to a status-tracking lag.)

**Updated diagnosis** (post-Win-#6):

- Phase B2.0 cost is now amortized via the head_sha cache (Win #6) — re-runs on unchanged repos pay near-zero.
- **Phase C is now the dominant remaining cost**. `context-manager` runs in `full` mode per repo on every run, even when inputs are byte-identical to the prior run. With 11 repos, that's ~200-400k tokens spent rewriting CLAUDE.md and agent-context/ docs that should be cache hits.
- Phase B2 (architect synthesis) is the second remaining cost. ~50-100k Opus per run, also unconditional.
- Re-running `/discover` on a fully-cached workspace today still pays Phases B2 + C in full. The B2.0 saving alone is partial — the downstream regeneration eats most of the headroom.

---

## The seven wins, with current status

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

### 6. Cache per-repo scan output across runs (head_sha-keyed) — ✅ SHIPPED

Shipped as `scripts/discover-cache.js` (plan + commit subcommands). Phase B2.0 calls `plan` before any `repo-discoverer` dispatch and `commit` after profiles are validated.

State file: `{workspace_root}/{slug}/runs/discover/state.json` — per-repo `head_sha`, `branch`, `scanned_at`, `profile_path`, `profile_schema_version`.

Invalidation rules (any one triggers rescan):
- No cache entry for the repo
- `HEAD` SHA mismatch
- Branch mismatch (e.g., main → feature branch)
- Cached `profile_schema_version < schema_version` from the canonical example (bumping the example file's `schema_version` invalidates every cache entry on the next run — automatic schema-drift handling)
- Cached `profile_path` file missing or unparseable
- `git rev-parse` fails (detached HEAD, non-git, unreadable) — defensive fallback

User can force-rescan via `/discover --refresh-cache`; the cache is still written for the next run (the flag name reflects both halves — "rescan now, update saved state").

Test coverage: `scripts/discover-cache.test.js` — 17 tests against real ephemeral git repos (no git stubbing). Covers every invalidation rule + the plan/commit round-trip + mixed-fleet scenarios + corrupt-state-file recovery.

### 7. Cache downstream artifacts (platform.md + per-repo CLAUDE.md + agent-context) — 📋 OPEN

Win #6 made Phase B2.0 cheap on re-runs. But Phases B2 and C still run unconditionally — even when every input is byte-identical to the prior run. With ~11 repos in a typical workspace, Phase C alone burns ~200-400k tokens regenerating context docs that have no reason to change.

**Pattern**: same as Win #6, one layer higher in the pipeline. Hash the inputs that produce each downstream artifact; skip the dispatch when the hash matches.

**Two artifact families to cache**:

1. **`platform.md` (Phase B2 output)** — inputs: all REPO_PROFILE files + B1 domain answers + schema_version. If `inputs_hash` matches the last successful generation, skip architect dispatch and reuse the on-disk `platform.md`.
2. **Per-repo `CLAUDE.md` + `agent-context/` (Phase C output)** — inputs: that repo's REPO_PROFILE + `platform.md` + schema_version. If hash matches, skip `context-manager` dispatch for that repo.

**State extension** (extends `state.json` from Win #6):

```json
{
  "repos": { "...": "Win #6 cache as today" },
  "platform_md": {
    "inputs_hash": "<sha256 of profile hashes + b1 answers + schema_version>",
    "generated_at": "2026-05-31T10:00:00Z",
    "path": "platform.md"
  },
  "context": {
    "publisher-service": {
      "inputs_hash": "<sha256>",
      "generated_at": "...",
      "claude_md_path": "publisher-service/CLAUDE.md",
      "agent_context_dir": "publisher-service/agent-context/"
    },
    ...
  }
}
```

**Invalidation rules** (any one triggers regeneration of the affected artifact):

- No prior entry
- `inputs_hash` mismatch (any input changed)
- Output file/dir missing on disk
- `schema_version` drift
- User passed `--force-rescan` (transitively invalidates downstream — changed profile → changed hash → forced regen)

**Estimated saving on a no-change re-run**: ~95% of remaining `/discover` cost. The run becomes "git rev-parse every repo, hash a few JSON files, print 'nothing changed, skipping B2 and C'."

**Risk**: low. Same mechanical pattern as Win #6, same test approach (ephemeral repos, real file ops). The main design choice is *what counts as an input*. Conservative answer: everything in the upstream block + schema_version, no fancier dependency tracking.

**Estimated effort**: ~150 lines of script logic + Phase B2 and Phase C wiring changes. Builds on `discover-cache.js`.

**Naturally pairs with Win #6.** Together they make `/discover --resume` genuinely cheap, not just partially cheap.

---

## Smaller cleanups worth bundling

- **B3 ↔ B2 overlap**: have B2 emit a `FRONTEND_SIGNALS` block (component library, design system signals, etc.). B3 only runs if B2 didn't capture enough or wants depth. Avoids re-reading every component file. Becomes mostly free once Win #3 lands — the per-repo discoverer for frontends can populate FRONTEND_SIGNALS directly.
- **Phase D inline report**: today the orchestrator writes the Phase D summary inline. Could route through the existing `reporter` agent (Haiku, ~5k) for richer trend comparison across discover runs. Optional.

---

## Updated sequencing (after closing #1, #2, #3, #5, #6)

1. **Win #7** — biggest remaining cost lever. Extends the Win #6 pattern to platform.md and per-repo context output. Without it, `/discover --resume` is only partially cheap.
2. **Win #4** — outline gate. Lowers the cost of a *rejected* full run (orthogonal to caching).

After both: a `/discover --resume` on an unchanged workspace runs in seconds and costs near-zero tokens. A re-run after editing one repo pays only for that repo's profile + its single CLAUDE.md + agent-context regeneration; everything else stays cached. A rejected first run costs the outline pass, not the full Opus synthesis.

---

## What shipped / what's open

| # | Win | Status | Branch / commit |
|---|---|---|---|
| 1 | Pre-scan manifest | ❌ Rejected | branch dropped |
| 2 | Parallel B2 + B2.5 | ⚪ Moot (B2.5 deleted) | `65a90e3` (B2.5 removal) |
| 3 | Split B2 (Sonnet + Opus) | ✅ Shipped | merged in PR #7 (`ec12019`) — Phase B2.0 dispatches `repo-discoverer` per repo in parallel; Opus B2 synthesizes from per-repo `REPO_PROFILE` JSON files |
| 4 | Outline gate | 📋 Open | — pairs naturally with Win #3; cheap Sonnet preview before Opus synthesis |
| 5 | Merge C.4 + C.5 | ✅ Shipped (pre-dating this plan) | `phase-c-generation.md` Step 2 already merges CLAUDE.md + agent-context into a single `context-manager` dispatch per repo in `mode: full` — likely landed in `7f6b62e` (role-based agent-context templates) |
| 6 | head_sha cache | ✅ Shipped | `feat/discover-head-sha-cache` — `scripts/discover-cache.js` + REPO_PROFILE `schema_version` field + Phase B2.0 plan/commit calls; keys off the `REPO_PROFILE` `head_sha` field |
| 7 | Downstream artifact cache (platform.md + per-repo context) | 📋 Open, builds on #6 | — extends `state.json`/`discover-cache.js`, gates Phase B2 + Phase C dispatch |
| — | B3↔B2 overlap (sub-cleanup) | 📋 Open, unblocked by #3 | — `repo-discoverer` already populates `frontend_signals` per repo; B3 could now read those instead of re-walking |
| — | Phase D reporter agent | 📋 Open, optional | — |

---

## Open question

`/discover` doesn't currently dispatch a `reporter` agent at Phase D. The `reporter` could be reused at end-of-run to produce a richer summary + trend comparison across `runs/discover/{run_id}/checkpoints.jsonl` files. This is orthogonal to the seven wins but would make `state.json` (Win #6) more useful to a human reader.
