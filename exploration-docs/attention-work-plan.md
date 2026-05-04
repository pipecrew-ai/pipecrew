# Plan: attention work, one point at a time

**Date**: 2026-04-26
**Source**: derived from the seven recommendations in [`attention-and-caching.md`](./attention-and-caching.md). That doc explains the *why*; this doc enumerates the *what* and *in what order*.
**Status**: planning only — no edits applied yet. Each pass below is independently approvable.

---

## What this plan covers

The seven anti-forgetting recommendations from `attention-and-caching.md`, regrouped into five execution **passes** so each pass touches a coherent set of files and concerns. Recommendations that share a surface (long dispatch prompts) are bundled into one pass; recommendations that need investigation before edits are explicitly marked as audit-driven.

Goal: **the model does not forget any instruction.** Cache friendliness is a side effect — never the driver.

---

## Pre-work (housekeeping, ~5 min)

**P0.** Cross-reference `attention-and-caching.md` from `context-engineering.md`. Reframe `context-engineering.md`'s recommendations #2 (cache-friendly ordering) and #4 (lost-in-the-middle pass) to point at the new doc and inherit its attention-first framing. The current wording treats them as separate cache and attention concerns; they're really one concern under the new framing.

---

## Pass A — anti-forgetting on the 3 hot dispatches

**Goal:** apply Recs 1 + 2 + 6 in one careful sweep per file. These three recs share the same surface (long dispatch prompts), so doing them together avoids three separate audits of the same files.

| Step | File | What changes | Effort | Risk |
|------|------|--------------|--------|------|
| **A1** | `skills/deliver/phases/phase-2-architecture.md` (architect dispatch) | (1) Lead with one-sentence imperative naming the feature. (2) Move output-format framing to middle. (3) End with restated critical rules: "emit AFFECTED_SERVICES JSON; cite alternatives ruled out; one-sentence runner-up." (4) End with imperative restatement. | 30 min | Low |
| **A2** | `skills/deliver/phases/phase-5-build.md` (Phase 5b implementer dispatch) | (1) Lead with imperative naming the repo + feature. (2) End with critical rules: "emit COVERAGE block — every FR-X and EC-X above must appear; run scope-drift check; classify each finding." (3) Add integrity check after the FR/EC list ("There are N FRs and M ECs above. Your COVERAGE block must contain at least N+M entries."). | 30 min | Low |
| **A3** | `skills/deliver/phases/phase-5.5-code-review.md` (reviewer dispatch) | (1) Lead with imperative naming what to review. (2) End with critical rules: "emit FINDINGS_SUMMARY first; classify every Critical as mechanical or architectural; do not invent rules outside the system prompt." (3) Add integrity line on findings count. | 45 min | Low (Phase 5.5 is the longest dispatch — careful audit needed) |

**Verification per step:** read the file end-to-end; re-run `node eval/run.js` (only structural — won't catch attention regressions, but catches accidental breakage of script refs / template refs).

**Investigation needed before A2/A3:** read the current dispatch prompts to verify current state before promising specific edits.

---

## Pass B — Rec 7: stable rules → system prompts

**Goal:** for each of the 3 dispatches above, find content that is identical across dispatches of the same agent. Move that content into the agent's `.md` system prompt. Leave per-call values in the dispatch.

This is **audit-driven**. No pre-commitment to specific edits without reading the current state of each dispatch alongside its agent file.

| Step | What | Effort | Risk |
|------|------|--------|------|
| **B1** | Audit architect dispatch vs. `agents/solution-architect.md` for stable content overlap. List what to move. | 20 min | Low (audit only) |
| **B2** | Apply moves from B1. | 20 min | Medium — moving content between attention tiers can change behavior; verify with a smoke test if practical. |
| **B3** | Same audit for Phase 5b implementer dispatches vs. each `agents/{language}-{role}-implementer.md`. | 30 min (multiple agents) | Low (audit only) |
| **B4** | Apply moves from B3. | 30 min | Medium |
| **B5** | Same audit + apply for Phase 5.5 reviewer dispatches vs. each reviewer agent file. | 30 min | Medium |

**Risk to flag:** moving content from dispatch (user message) to agent prompt (system prompt) changes the *attention tier* the model treats it with. System-prompt rules feel more authoritative; user-message rules feel more "this turn." Some content may belong in dispatch precisely because it's a per-call instruction, not a standing rule. Audit must distinguish.

---

## Pass C — Rec 3: trim what doesn't earn its budget

**Goal:** small, surgical trims on always-loaded content. One trim per commit so each is independently revertible.

| Step | Target | Specific trim candidate | Effort | Risk |
|------|--------|------------------------|--------|------|
| **C1** | `skills/deliver/SKILL.md` "Utility scripts" inventory (~250 always-loaded tokens) | Either: split into per-phase references (highest savings, most work), OR keep but trim each entry's description to one line. | 20 min for the trim version; 1 hour for full split | Low (trim) / Medium (split) |
| **C2** | Architect dispatch output-format framing | Replace verbose format spec with reference: "Emit blocks per `docs/file-formats.md` and the example files cited there." Loads on demand instead of always. | 20 min | Low — `docs/file-formats.md` already exists |
| **C3** | Implementer common-rules — second pass | Re-read with fresh eyes; cut anything Karpathy missed. (Likely small cuts at this point.) | 30 min | Low |

---

## Pass D — Rec 5: continue structured-block migration

**Goal:** apply the `AFFECTED_SERVICES` pattern to the next-most-consumed architect blocks. One block per commit; consumers migrated in the same commit as the producer change.

| Step | Block | Producer change | Consumer changes | Effort | Risk |
|------|-------|----------------|------------------|--------|------|
| **D1** | `API_DESIGN` | Add JSON block to architect output spec; add `templates/blocks/api-design.example.json`; update `docs/file-formats.md`. | Phase 3 spec-editor + Phase 5 implementers (api-first / code-first paths). | 2 hours | Medium — `API_DESIGN` has the most field variation; example needs careful design |
| **D2** | `DATA_MODEL` | Same pattern. | Phase 5 implementers that touch DB. | 1.5 hours | Low-Medium |
| **D3** | `INFRASTRUCTURE_IMPACT` | Same pattern. | `terraform-implementer`, `cdk-stack-implementer`. | 1.5 hours | Low — these consumers are smaller |

**Defer for now:** `RISKS`, `FRONTEND_ARCHITECTURE`, `CONTRACT_DESIGN` — narrative blocks with weaker structured-consumption patterns. Migrate only if a specific consumer pain emerges.

**Eval harness coverage:** each new block adds an entry to `eval/tests/01-templates-parse.js` shape checks and `eval/tests/03-template-refs-resolve.js` orphan check (automatic — they iterate the directory).

---

## Pass E — Rec 4: replace inlined long lists with file references

**Goal:** where dispatches embed long enumerable content, write it to a file the agent reads instead.

This is **investigation-first**. Need to check current state:

| Step | What | Effort |
|------|------|--------|
| **E1** | Audit Phase 5 dispatch — is the FR/EC list embedded in the dispatch, or already passed via task file? | 15 min |
| **E2** | Same audit for Phase 5.5 — does the reviewer get a list of files-to-review embedded, or via reference? | 15 min |
| **E3** | Apply file-reference pattern wherever lists are still embedded. | 30 min per call site |

**Likely outcome:** Phase 4 already writes task files; the FR/EC list may already be referenced rather than embedded. Worth verifying before changing anything.

---

## Recommended execution order

Reasoning: **highest leverage first, lowest risk first, audit-driven passes after direct passes.**

```
P0    (housekeeping)           — 5 min
A1, A2, A3  (Pass A)           — 1.5 hours total, 3 commits
C1, C2, C3  (Pass C, in order) — 1 hour total, 3 commits   ← quick trims while in the same files
B1, B3      (Pass B audits)    — 50 min, no commits        ← audit reports back to you
B2, B4, B5  (Pass B applies)   — 1.5 hours, 3 commits      ← only after audit approval
E1, E2      (Pass E audits)    — 30 min, no commits
E3          (Pass E applies)   — variable                  ← only if E1/E2 surface inlined lists
D1          (Pass D — API_DESIGN) — 2 hours, 1 commit      ← biggest single piece
D2, D3      (Pass D continues) — only after D1 ships and lands cleanly
```

Stop after each pass; re-evaluate. **Pass D's D2/D3 are explicitly conditional on D1 being a clean win.**

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Bloating prompts to make them "more cacheable" | Discipline from `attention-and-caching.md`: rearrangement only, no addition. Each commit's diff must be net-neutral or net-negative on token count. |
| Moving rules from system prompt to dispatch (or vice versa) changes behavior | Pass B requires explicit audit-then-apply, with audit results visible before any edit. |
| `docs/file-formats.md` and `templates/blocks/*.example.json` get out of sync | The eval harness already enforces this. Run `node eval/run.js` after every change. |
| Pass D breaks downstream consumers | One block per commit; one consumer-list per commit. Easy revert. |
| Spec drift in architect output (downstream phases expect specific JSON shape) | New JSON block goes in alongside existing prose first; consumers migrate one at a time; prose stays as fallback during transition. |

---

## Approval gates before execution

Before any edit:

1. **Order** — confirm or reorder the recommended execution order above.
2. **Scope** — drop or add any pass.
3. **Cadence** — one long working session, or pause after each pass for review.
4. **Pass D timing** — include D1 (API_DESIGN migration) in this batch, or defer to its own session given it's the biggest piece (~2 hours of focused work).

Once confirmed, start with P0 + Pass A (housekeeping + the three hot dispatch upgrades) and pause for review before continuing.

---

## Cross-references

- [`attention-and-caching.md`](./attention-and-caching.md) — the principle this plan operationalizes
- [`context-engineering.md`](./context-engineering.md) — the broader signal-vs-noise framing
- [`extractor-enhancement.md`](./extractor-enhancement.md) — the `AFFECTED_SERVICES` precedent that Pass D extends
- [`karpathy-assessment-v3.md`](./karpathy-assessment-v3.md) — the prior trim work that Pass C continues
- [`eval/`](./eval/) — the harness that verifies structural correctness after each pass
