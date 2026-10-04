# Acceptance test cases + regression (design)

Status: **slice 1 shipped — standalone only** (test-designer agent + durable storage, dispatched
directly via the Agent tool; NOT wired into /deliver or /discover by explicit user decision —
pipeline integration comes later) · **slice 2 deferred** (regression-runner agent +
`/pipecrew:run-regression` skill — verb-named per house convention, user's pick over
`run-tests`/`regress`). Decided 2026-10-03/04 (solution-architect consultation + user
direction).

## Problem

PipeCrew ships features across repos but keeps no durable, re-runnable acceptance record.
Reviewer and assessor outputs are run-scoped — they die with the run. Wanted: feature-level
test cases per feature (not unit-granular), accumulated into a regression suite the team can
run after each release, plus a UAT first-pass and a production smoke layer.

## Decision: author/run split (two agents over one durable store)

Authoring is pure analysis and works in every workspace; execution needs a runnable
environment many workspaces don't have. Combining them forces executor baggage onto every
authoring dispatch and invites "silent pass" on unverifiable cases. The split mirrors the
plugin's existing implementer/reviewer and deliver/assess pairs.

- **`pipecrew:test-designer`** (shipped) — authors + maintains the suite. Modes: `deliver`
  (FR/EC + technical design → cases; no code reads) and `baseline` (platform.md +
  REPO_PROFILEs + specs → characterization cases for existing features; targeted spot-reads
  only, never repo sweeps). Phases: `draft` (caller's draft_dir only) → user gate →
  `persist` (durable files + INDEX.md, supersede-with-retire on re-author).
- **`pipecrew:regression-runner`** (deferred) — executes/verifies stored cases, emits
  `pass | fail | unverifiable` per case. Hard charter rule: no runtime evidence → never
  `pass`. Second hard rule: never execute a mutating step against a production target,
  even if a case is mistagged.

## Case format + granularity

Feature-level Given/When/Then, **3–8 active cases per feature** (one per FR + one per
load-bearing EC). Each case: Covers / Surface / prod_safe / Preconditions / When / Then /
Repos touched (+ optional `assumption:` for anything the source material didn't pin down).
Full format spec lives in `agents/test-designer.md`.

**Outermost-surface rule**: write each case at the outermost surface its actors actually
use — UI journey when a frontend path exists (subsumes the API; never both), API contract
for client-facing capabilities, event for queue/topic entries, CLI for tooling. Infra repos
are never a surface; infra correctness appears as observable side effects in other cases.

## Durable storage

`{workspace_root}/{slug}/testcases/` — one file per feature slug + regenerated `INDEX.md`.
Synced to the team memory repo: `testcases` is in the `sync-memory.js` ALLOW list, the
redaction loop, and the memory-repo `.gitignore` allow-list (with an in-place self-heal for
repos bootstrapped before this existed). Retired cases stay in-file under `## Retired`
with provenance — never deleted.

**Read-isolation (deliberate)**: the suite is consumed ONLY by the test-designer and the
regression runner. No pointer from platform.md, AGENTS.md, repo context docs, or the
repos-parent routing file — an ever-growing suite must not ride in ambient session context
(see the v1.14.0 orchestrator token-cost analysis).

## Invocation (shipped: standalone skill)

**`/pipecrew:design-tests`** (`skills/design-tests/SKILL.md`) is the front door — it
resolves the workspace, dispatches the `pipecrew:test-designer` agent's `draft` phase,
runs the user gate (yes / adjust / no), dispatches `persist` on approval, and offers a
memory sync. Named as a verb per house convention; "design" pairs with the agent name.

- `/design-tests` — baseline mode: one suite per existing feature (`--only=` to scope);
- `/design-tests --run=<run_id>` — deliver mode: cases from a past /deliver run's
  FR/EC + technical design;
- `/design-tests status` — renders `testcases/INDEX.md` (the only sanctioned way to
  look at the suite without pulling case files into context).

Direct agent dispatch remains possible (caller provides mode/phase/draft_dir and runs
the gate itself), but the skill is preferred — it guarantees the gate. Persisted cases
reach the team via the normal memory sync (`/pipecrew:memory-sync sync` or any skill's
auto-sync) — `testcases` is in the allow-list.

## Deferred: pipeline integration

By explicit user decision, slice 1 does NOT touch /deliver or /discover. The agreed shape
when integration happens (was drafted, then pulled back out): `/deliver` Phase 8 gains an
always-offered gated step (draft → approve/adjust/skip → persist, placed before the
feedback offering and before the memory-sync step so cases ride the same push), and
`/discover` Phase C gains an optional gated baseline step that skips features with an
existing active suite.

## Deferred: regression-runner + /pipecrew:run-regression

Agreed shape, to be built as slice 2:

- **Named environments** per workspace in `config.json` (e.g. `uat`, `staging`,
  `production: true`) — not a hardcoded pair. `--env=<name>` selects the target.
- **Three tiers**: UAT = full suite, per-feature scope, before release (the runner's report
  doubles as the human UAT sign-off sheet — agent verifies behavior, human accepts intent);
  staging/UAT full-suite run = the release gate; production = **`prod_safe` subset only**
  (read-only smoke), every release. Mutating cases run against production only if a
  workspace later builds synthetic-tenant support (an `env` field on cases is reserved
  for that; no workspace has it today).
- **Scope flag**: `--scope=feature:<slug>` (UAT) vs `--scope=all` (regression).
- **Credentials**: supplied by the operator at run time, never stored in case files;
  production credentials should be read-only at the credential level, not just by charter.
- Where no environment exists at all, the runner verifies scenarios against current code
  and reports honestly (`unverifiable` where code-reading can't settle it). For the plugin
  workspace itself, regression ≈ code-grounded verification + `node eval/run.js`.

## Explicitly out of scope (all slices)

Booting services / driving frontends from the runner, CI integration, auto-retirement
heuristics, synthetic-tenant implementation inside target products.

## Rejected alternatives

- **One combined test-engineer agent** — conflates analysis with environment-dependent
  execution; silent-pass risk.
- **Extending the assessor** — its charter is cross-repo integration of one branch,
  run-scoped by design; wouldn't yield a durable suite and still leaves regression unsolved.
- **Full mutating regression in production** — test debris in business data, real emails /
  payments / webhooks, flaky preconditions, and an LLM holding prod write credentials.
