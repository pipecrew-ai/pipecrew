# PipeCrew review-gap enhancements

Plugin-level proposals from the `dal-platform` content-rating `/deliver` run (PRs: backoffice #46,
frontend #89, mock #5). A human reviewer + user scrutiny surfaced issues the pipeline shipped past.
This doc records *why* the pipeline missed them and the concrete plugin changes that would close each
gap.

## Status — APPLIED (uncommitted)

E1, E2, and E3 have been implemented in the plugin (not yet committed). Files touched:

- **E1** (nearest-sibling design diff): `agents/solution-architect.md` (new "Nearest-sibling design diff" rule + required `### Nearest-sibling design diff` sub-section in `ARCHITECTURE_DECISION`), `skills/deliver/phases/phase-2-architecture.md` (dispatch bullet), `rules/reviewer-common.md` (Hard check **HC-2** + Step 8 wiring), `skills/deliver/phases/phase-5.5-code-review.md` (reviewer prompts pass the sibling diff + verify HC-2).
- **E2** (hard entity-changed ⇒ migration): `rules/reviewer-common.md` (Hard check **HC-1**, non-droppable, wired into Step 5), and strengthened migration bullets in `agents/spring-boot-reviewer.md`, `agents/django-reviewer.md`, `agents/fastapi-reviewer.md`, `agents/flask-reviewer.md`.
- **E3** (freshly-learned conventions as first-class rules): `rules/reviewer-common.md` (Invariant 8 + Step 1 loads `platform.md § Established Patterns` as a checklist), `skills/deliver/phases/phase-5.5-code-review.md` (both reviewer prompts load the established-patterns checklist).
- **E4** (learner comment-coverage guard): the `/learn` feedback-learner dropped reviewer comments that weren't reusable conventions (no observation → silently lost). Added a comment inventory + per-comment disposition + a validated **Comment coverage** mapping table, and a `code-fix` (CF-n) disposition for reviewer-flagged defects that aren't conventions — routed into the Step 6.5 fix-round ("ask implementer to fix"). Files: `agents/feedback-learner.md` (Steps 3.5 / 5.5, coverage table + CF-n in output, completeness gate in "You are not done until"), `skills/learn/SKILL.md` (dispatch prompt, Step 4.0 coverage gate, Step 6.5 routes CF-n into bundles, Step 6 log records coverage + code-fix tables, Step 7 prints the coverage line).
- **E5** (deterministic comment collection): the coverage guard is only airtight if the comment list it validates against is itself complete. Replaced `/learn` PR-mode's inline, model-parsed `gh` comment-fetching with a predefined script `scripts/collect-pr-feedback.js` (+ `collect-pr-feedback.test.js`, 17 cases) that paginates fully, strips bot/CI noise, normalizes inline + conversation + review-summary comments, and assigns **stable `C-n` ids** the learner adopts verbatim — so coverage is a mechanical count, not a re-derivation. Matches the existing `write-review-diff.js` pattern (shell-out → normalize → write a file the agent Reads; tiny stdout). Wired into `skills/learn/SKILL.md` Step 2a + the dispatch prompt; the learner (`agents/feedback-learner.md` Steps 1 / 3.5) reads the canonical file as its inventory spine.

## Background

The L2 bulk content-rating feature passed every PipeCrew gate (requirements → architecture → spec →
implementation → paired review → cross-repo assessment → live browser verification) and still had:

1. **An architectural divergence** — it round-tripped a Flowable `taskId` through the client
   (list returns `taskId`, client sends it back in `TaskRef`), whereas the established sibling feature
   (`ReviewerTaskService` / `ReviewerTasksController`) takes only `bookId` and resolves the task id
   server-side at action time. The content-rating list even paid an extra Flowable query to attach the
   id. Net: a redundant query + a redundant contract field.
2. **Undocumented-convention misses** — use the existing `BucketProperties` for S3 buckets; roll back
   (not manually revert) on a Flowable failure after a DB write; stream S3→ZIP rather than buffer;
   add a Liquibase changeset for any schema-affecting `@Column` change.
3. **A dropped reviewer finding** — the spring-boot reviewer *did* raise the missing Liquibase
   migration, then dismissed it as a false positive. The human reviewer flagged the same thing and was
   right.

## Root causes (why each slipped through)

- **The pipeline optimizes for internal consistency, not cross-feature consistency.** Every gate checks
  "does the code match the spec, and do the repos agree." The feature was flawlessly consistent on that
  axis. The defect was one altitude up: the *spec itself* diverged from how the org already builds the
  same thing. No agent was anchored on "read the nearest sibling feature and mirror its contract."
- **The reviewer only enforces conventions that are written down.** `BucketProperties`,
  rollback-not-revert, S3 streaming, and Liquibase-per-schema-change were tribal knowledge, absent from
  `platform.md` / the repo `agent-context`. With no rule to check, the reviewer had nothing to flag.
  (These four are now captured via `/learn` — that loop is the existing fix for this class.)
- **Verification proves "works," not "idiomatic."** Round-tripping the `taskId` functions correctly
  when the list returns real ids, so live browser verification gave a green light to a working-but-
  non-idiomatic design. Verification catches "broken," never "redundant" or "divergent."
- **The migration check is a judgment call, not a deterministic gate.** A modified `@Entity` with no
  new changeset is mechanically detectable, but the reviewer treated it as a soft heuristic and dropped
  it.

## Enhancement E1 — Nearest-sibling design diff (architecture + review)

**Problem it closes:** architectural divergence from an existing equivalent feature (gap #1).

**Where:**
- `templates/agents/*` / `pipecrew:solution-architect` (DESIGN phase) — add a required step.
- `skills/deliver/phases/` architecture phase prompt.
- `pipecrew:spring-boot-reviewer` (and the other `*-reviewer`s) — add a check item.

**Change:** Before finalizing the API/contract design, the architect must identify the **nearest
existing feature that solves a structurally similar problem** (same repo, same kind of resource/flow)
and explicitly diff the proposed contract shape against it. Any divergence in *contract shape*
(request/response fields, who-resolves-what, sync vs async, pagination source) must carry a one-line
"why different" justification in the design doc. The reviewer then verifies that justification exists
and is sound — a divergence with no rationale is a finding.

Concretely for this case: the architect would have found `ReviewerTasksController.claimTask(UUID bookId)`
(client sends only `bookId`; `findTaskByBookId` resolves the task id server-side) and had to justify why
content-rating instead exposes and round-trips a `taskId`. There was no good reason — so the divergence
would have been caught at design time.

**Guard against over-firing:** only require the justification for *contract-shape* divergence from a
genuinely analogous feature, not for every implementation detail. The architect names the sibling; if
there is no analogous feature, it records "no sibling" and the check is satisfied.

## Enhancement E2 — Hard "entity changed ⇒ migration exists" reviewer rule

**Problem it closes:** the dropped missing-migration finding (gap #3).

**Where:** `pipecrew:spring-boot-reviewer` (and `django`/`fastapi`/`flask` reviewers where an ORM +
migration tool is in play).

**Change:** Make this a **deterministic, non-droppable** check rather than a heuristic the reviewer may
dismiss. For any modified JPA `@Entity` (or ORM model) in the diff, the reviewer must verify that every
schema-affecting `@Column` change — nullability flip, name, length, added/removed column — has a
corresponding new migration file included in the master changelog. If the entity changed and no matching
changeset is present, it is a **Critical** finding the reviewer is not permitted to downgrade to a false
positive. The only valid "no migration needed" outcome is when the reviewer can point to the existing
changeset that already matches the new mapping (e.g. the column is already nullable) — and it must cite
that file:line.

## Enhancement E3 — Treat freshly-learned conventions as first-class review rules

**Problem it closes:** undocumented-convention misses (gap #2) — reinforcing the existing `/learn` loop.

**Where:** `pipecrew:*-reviewer` prompts + `skills/deliver` review phase.

**Change:** This class is already addressed by `/learn` writing conventions into `platform.md` /
`agent-context`. The reinforcement: the reviewer phase should explicitly load the workspace
`platform.md § Established Patterns` and the target repo's `agent-context` convention docs as
**checklist input**, and confirm the diff complies with each applicable rule — so that a convention the
team taught the pipeline last week is actually enforced this week. (Without this, newly-learned rules sit
in docs the reviewer doesn't systematically check against.)

## Meta

PipeCrew is strong at *"build what the spec says, correctly, consistently, and prove it runs."* It is
weak at *"should the spec have looked like this, given how we already solved the same problem?"* — that
is senior-design-review judgment, currently leaning entirely on the human gate. E1 moves a slice of that
judgment into the pipeline (sibling diff + justification); E2 hardens one mechanical check that was
fumbled; E3 makes the human's taught conventions actually bite on the next run.
