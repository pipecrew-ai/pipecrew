# The `rules/*.md` shared-instruction pattern

**Status**: investigation notes (saved 2026-06-01) — reference for future doc edits and any work on resume semantics. Original investigation pre-dated PR #19, which moved the agent-facing instruction files from `docs/` into a dedicated `rules/` directory; paths below reflect the post-PR-#19 layout.

---

## The pattern

Files in `rules/*.md` are **agent-facing instruction docs**, not human reading material. They get cited by reference from skill markdown files using language like *"Apply the shared rules at `{plugin_dir}/rules/X.md` — A, B, and C are defined there."*

When Claude is executing a skill and hits a scenario the shared doc covers (interruption, retry, diagram authoring, etc.), it reads the referenced doc and applies its rules.

**Why this exists**: DRY. Instead of duplicating identical rules into every skill/agent, the rules live in one canonical doc. Skills *include by reference*, the same way code imports a shared helper.

**Why it's load-bearing, not optional**: if you delete `rules/interruption-and-resume.md`, `/discover --resume` and `/deliver --resume` lose their behavioral contract. The skills would still parse, but Claude would have to improvise when interruption happens — inconsistent behavior across sessions and across skills.

---

## Map of shared docs and where they're cited (as of 2026-06-01)

| File | Used by | What it defines |
|---|---|---|
| `interruption-and-resume.md` | `skills/discover/SKILL.md:203`, `skills/deliver/phases/phase-7-report.md:209` | `skip`/`stop`/`restart from phase X` commands; auto-interruption triggers; scratchpad `Status` vocabulary; `checkpoints.jsonl` events; the full `--resume` flow |
| `transient-failures.md` | Skills/agents that retry — confirm citations before edits | Retry/backoff behavior, what counts as transient vs. non-retryable |
| `observability.md` | Every skill that writes `checkpoints.jsonl` | Event schema (run_start, phase_start/end, agent_start/end, run_end), required fields, JSON encoding |
| `flag-conventions.md` | Skills defining CLI flags | Flag naming (`--kebab-case`), defaults, `--resume` / `--workspace=<slug>` conventions |
| `implementer-common.md` | Every per-stack implementer agent (R1-R10) | The rules every implementer follows regardless of stack: no inventing conventions, no overwriting human files, etc. |
| `discovery-diagrams.md` | `/discover` Phase B2 architect | How to author the discovery (C4 context + component) diagrams |
| `c4-diagrams.md` | `/discover` Phase B2 architect, possibly others | C4 syntax and convention rules |

`docs/PIPECREW-DISCOVERY.md` is the **only** human-facing doc in this directory — it's the high-level pipeline overview.

**Removed from this catalog**: `site-view-notifications.md` was previously listed here, claimed to be loaded by "skills emitting UI events." Grep proved otherwise — no skill or agent cites it. It is documentation of the site-view notification subsystem, not a rule. Relocated to `docs/site-view-notifications.md` and `docs/design/site-view-notifications-history.md`.

---

## Resume semantics — quick reference

Pulled from `interruption-and-resume.md` for context; the doc itself is the canonical source.

### State files that survive a crash

| File | Purpose |
|---|---|
| `scratchpad.md` | Human-readable phase status (which phases done, which in-progress) |
| `checkpoints.jsonl` | Append-only event log (`run_start`, `phase_end`, `run_end`) |
| `state.json` | Per-repo profile cache (Win #6, /discover only) |
| `outputs/` | Per-phase artifacts |

### Interruption triggers

| Trigger | Handling |
|---|---|
| User `stop` | Scratchpad → `INTERRUPTED`, emit `run_end` with `aborted` |
| User `skip` | Current phase → `SKIPPED`, move to next |
| User `restart from phase X` | Phase X → current, archive prior outputs, re-enter |
| Context window limit | Scratchpad persists; user resumes in new session |
| Non-429 Agent error | Treated as user `stop` |
| Terminal kill | No cleanup; next `--resume` finds `IN_PROGRESS`, asks to continue |
| Parallel agent fails mid-batch | Mark that one `FAILED`, continue siblings, ask at batch end |

### Resume granularity in `/discover`

| Phase | Granularity | On mid-phase crash |
|---|---|---|
| A — Repo discovery | Phase | Whole phase re-runs (cheap) |
| B1 — Domain Q&A | Phase | Mostly skipped (answers in scratchpad) |
| **B2.0 — Per-repo discoverer** | **Per-repo (Win #6)** | Finished repos reused via cache; only in-flight repo rescans |
| B2 — Architect synthesis | Phase | Architect re-runs (~50-100k Opus) |
| B2.6 — Observability | Phase | Re-runs |
| B3 — Design system | Phase | Re-runs |
| **C — CLAUDE.md + agent-context per repo** | **Phase** | All N per-repo dispatches re-run, even finished ones |
| D — Verification | Phase | Re-runs (cheap) |

### What can't be resumed

- Partial CLAUDE.md files in target repos (phase re-runs from scratch, may produce slightly different output)
- Approval decisions already given (persisted; resume doesn't re-ask)

---

## Open improvements relevant to this area

- **Win #7** (downstream artifact cache) would extend per-repo resume granularity from Phase B2.0 to Phase C. Same head_sha-style pattern, one layer up. See `discover-enhancement.md` Win #7 for the full plan.
- **Win #4** (outline gate) doesn't affect resume but affects what gets persisted between phases.

---

## When editing shared docs — checklist

Before changing any `rules/*.md`:

1. Grep for citations: `grep -rn "rules/<filename>" skills/ agents/`
2. Review every caller — your edit changes their behavior.
3. If a rule changes shape (not just wording), bump the skills/agents that cite it to mention the new behavior in their own prose.
4. Tests don't catch this — there's no compile-time check that the citation contract holds. Manual review only.
