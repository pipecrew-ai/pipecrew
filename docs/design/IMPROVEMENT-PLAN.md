# Improvement Plan — Closing the gaps in agentic spec-driven development

**Status**: roadmap, not committed work. Each item has a clear trigger for when it becomes worth doing.

**Framing**: the plugin is an agentic SDD orchestrator. OpenAPI is the contract, a crew of stack-specialized agents implements in parallel, and review/assess agents close the loop. That puts it ahead of single-agent tools (`spec-kit`, CrewAI clones) on multi-repo parallelism and stack-specialized review. The gaps below are what separates "ships features" from "spec is genuinely the source of truth".

---

## 1. The spec surface is OpenAPI-only

**Problem**. Real systems have contracts OpenAPI can't describe: event payloads (SQS, Kafka, EventBridge), DB schemas / migration semantics, UI contracts (Storybook stories, Figma tokens, design-system props), state machines (e.g. `ContractStatus DONE|CANCELED` has no formal transitions — today that's documented in prose), and workflow definitions (Flowable, Temporal, Step Functions). Half the system is spec-driven, half is agent-guessed.

**Proposal**.
- Add **AsyncAPI** support to `openapi-spec-editor` (or a sibling `asyncapi-spec-editor`) for event payloads. The DAL workspace already has SQS events — they should have contracts.
- Promote **state machines** to a first-class artifact. Small YAML format: states + transitions + triggers. Generated Mermaid diagrams for humans, guards for implementers. `solution-architect` writes it; reviewers check entity status fields match it.
- Add **UI contract** awareness: the `ux-consultant` already produces an IMPLEMENTATION_SPEC, but it's prose. Consider a structured block (component name, props, i18n keys, states) that `react-feature-implementer` consumes as a machine input.
- Leave DB migrations alone for now — Liquibase is already the spec. But add a reviewer rule: "if an entity gains a `nullable=false` column without a Liquibase NOT NULL constraint, flag it" (we hit this exact case in the contract-status refactor).

**Trigger**. When a feature spans SQS/events *and* a parallel mock needs to know event shapes, the lack of AsyncAPI bites first. State machines next when a third status enum appears.

**Effort**. AsyncAPI: medium (new agent, new template). State machines: small (format + reviewer rule). UI contract schema: small.

---

## 2. Verification is circular

**Problem**. The implementer writes the code *and* the tests, so tests inherit its blind spots. A green test suite today means "the implementer agrees with itself" — not "the implementation matches the spec". This is the single biggest threat to the "spec = source of truth" claim.

**Proposal**.
- **Spec-derived test generation before implementation.** Add a phase between Phase 3 (spec edits approved) and Phase 5 (implementation) that dispatches a `spec-test-generator` agent to produce:
  - **Schemathesis** runs against the OpenAPI spec (HTTP contract fuzzing — free 200s/400s/500s/auth checks).
  - **Pact consumer contracts** from frontend → backend (the frontend's expected shape, not the backend's claimed shape).
  - **Property-based tests** on schema types (e.g. Hypothesis for Python, jqwik/jcheck for Java).
- Implementers must make these tests pass. They cannot edit them (enforced by reviewer rule: "spec-derived tests are read-only for implementers — changes require spec edit").
- Persist the generated tests alongside the spec; regenerate when the spec changes.

**Trigger**. Do this before any claim of "production-grade". Today a false-positive green run is plausible; for anything user-facing, fix this.

**Effort**. Medium-large. New agent + tool integrations (Schemathesis / Pact / property-test libs) per stack. Reviewer rule is small.

---

## 3. No platform-level spec

**Problem**. Cross-repo `assess` reads git diffs after the fact. There's no machine-readable model of the platform: which services exist, what endpoints they expose, what events they publish/subscribe, what data they own, what upstream dependencies they have. The `solution-architect` reasons about blast radius from its context window and `platform.md` prose — fine today, fragile at 10+ services.

**Proposal**.
- Introduce `platform-manifest.yaml` at the workspace root. Schema: `services[].{name, repo, stack, endpoints[], events_published[], events_consumed[], data_owned[], depends_on[]}`. 
- `context-manager` in `full` mode emits a per-service fragment from each repo's CLAUDE.md + spec; workspace-level tooling merges fragments into the manifest.
- `solution-architect` reads the manifest first (not prose) to compute blast radius. A feature touching `contracts` shows up as "publisher-service writes, backoffice-service reads via SQS event X".
- `assess` compares the pre-feature manifest diff against actual changes — if a service added an event producer but no consumer was updated, flag it.

**Trigger**. When a feature affects >2 services and the cross-repo assess reports "wire-shape disagreement" more than once. Current DAL workspace is close to that threshold.

**Effort**. Medium. Schema + fragment emitters + merger script. `solution-architect` prompt update is small.

---

## 4. Approval gates are binary

**Problem**. Phase 3, Phase 4, Phase 7 gates ask "approve?" with y/n. Human feedback is the slowest step in any agentic loop; the plugin treats it as a checkpoint rather than an optimization target. No partial-approve, no redline-on-spec, no dry-run.

**Proposal**.
- **Partial approval**. At Phase 3 (spec edits), allow `approve services A,B; reject C`. Orchestrator re-dispatches `openapi-spec-editor` with a focused fix list for C, leaves A/B alone.
- **Redline mode**. The spec-editor outputs the diff as a review-able PR-style doc (not just a summary). User edits the diff directly → plugin re-applies the edited diff. Treats the spec diff as the collaboration surface, not the spec file.
- **Dry-run / what-if**. Before Phase 3, a `solution-architect --dry-run "add field X to Y"` that returns the spec diff + impacted services + test burden + migration burden, without actually editing anything. Lets the human compare 2–3 design options cheaply.

**Trigger**. When the user rejects Phase 3 twice in one run, the redline mode pays off. Partial approval first — it's the simplest.

**Effort**. Small to medium. Partial approval is mostly orchestrator logic. Redline mode is a UX shift. Dry-run is a new solution-architect mode.

---

## 5. Non-functional requirements are invisible

**Problem**. Latency budgets, retention, compliance flags, error-rate SLOs, PII classification — none of these have a slot in the spec. They live in the architect's head, maybe in prose somewhere. When a feature violates a budget, nobody notices until production.

**Proposal**.
- Extend `platform-manifest.yaml` (see #3) with a `nfrs` block per service: `{latency_p95_ms, availability_pct, retention_days, pii_fields, compliance_tags}`.
- New reviewer rule per stack: "if endpoint response payload contains a field matching a PII classifier and the field is logged, flag". Start small — one hardcoded rule — and grow.
- `solution-architect` surfaces NFR impact in its technical design: "this endpoint's budget is 200ms p95; the proposed N+1 query will break it".

**Trigger**. When the first production incident is "we logged a PII field by accident" or "this endpoint violates latency SLO". Defer until then — NFRs without incidents is busywork.

**Effort**. Small to start (one field on manifest + one reviewer rule); grows with breadth of rules.

---

## 6. Stochastic, not reproducible

**Problem**. Rerun Phase 5 with identical inputs → likely different code. Fine for prototypes; quietly contradicts "spec is the source of truth" for anything auditable. Replay-ability is currently scratchpad + checkpoints — enough to observe a past run, not enough to reproduce it.

**Proposal**.
- **Input hashing**. Each agent dispatch logs a deterministic hash of its inputs (spec snapshot + feature summary + requirements + repo state hash). Rerun with same hash returns cached output unless forced.
- **Seeded cache** as an explicit feature: `/deliver --cache-mode=strict` (replays cached agent outputs for identical inputs), `--cache-mode=refresh` (new runs always), `--cache-mode=auto` (current behavior).
- Not trying to make LLM calls deterministic — making the *pipeline* reproducible given cached agent outputs.

**Trigger**. When an audit question arrives: "show me how this code was produced". Also relevant for plugin marketing: "rerun the demo and get the same result".

**Effort**. Medium. Hash scheme + cache layer in orchestrator. Benign if ignored (default auto mode preserves today's behavior).

---

## 7. No self-observation — the plugin can't see its own inconsistencies

**Problem**. Every `/deliver` run today produces signals the plugin itself should learn from: reviewer flags findings that implementers silently ignore, scratchpad phase markers that don't flip to COMPLETED (the pipeline-view UI bug we already hit), agents citing file paths that don't exist, fix rounds that don't read the fix list, duplicate dispatches, phase gates skipped by the orchestrator, context-manager not dispatched when it should be, agent-context references that point at moved files. These are *plugin* bugs, not feature bugs — and today nobody watches for them. They surface as user-facing friction one at a time and get patched reactively. Meanwhile this plan itself is a manual artifact — it only grows when I notice something worth writing down.

**Proposal**.

A new agent — `pipeline-inspector` — with one job: observe each `/deliver` run and record every plugin-level inconsistency it sees, then surface them at the end of the run for human triage.

- **Inputs**: the run's `checkpoints.jsonl`, the scratchpad, each agent's transcript (already persisted), and the on-disk state of files the agents claimed to touch.
- **Scope** (plugin-level only — NOT the feature code):
  - Reviewer finding X flagged → fix round ran → finding X still present in diff ⇒ leak.
  - Scratchpad phase row says `IN_PROGRESS` after phase checkpoint wrote `completed` ⇒ lock-step bug (recorded in memory, still recurring).
  - Agent cited `file.java:42` that doesn't exist at run end ⇒ hallucination.
  - Fix list had 3 items, reviewer re-review reports 2 items still present ⇒ implementer dropped items silently.
  - Phase N declared complete but a required artifact for Phase N+1 is missing.
  - Agent dispatched twice with same inputs in same phase ⇒ duplicate / retry not logged.
  - `context-manager` should have fired (agent-context points at moved/renamed files post-feature) but didn't.
- **Output**: appends entries to `IMPROVEMENT-PLAN.md` under a new section `## Auto-logged findings` — one entry per inconsistency with: run ID, timestamp, phase, symptom, suspected cause, suggested fix (if obvious), severity (blocker / friction / cosmetic). Deduped against existing entries by symptom signature.
- **End-of-run prompt** to the human: "N plugin inconsistencies detected this run. [V]iew / [F]ix now / [D]efer to plan / [S]uppress specific symptom." `Fix now` routes to a `pipeline-fixer` dispatch scoped to ONLY plugin files (never feature code); `Defer` leaves the entry in the plan; `Suppress` adds a signature to an ignore-list with required rationale.

**Guardrails** (this is the risky item — the plugin editing the plugin):
- `pipeline-fixer` can ONLY edit files under `~/.claude/plugins/{plugin}/` — never feature repos.
- Every auto-fix runs its edit through `validate-claude-md.js` + a new `validate-agent-md.js` (to-be-written) + git diff preview to the user before apply.
- `pipeline-fixer` is gated behind explicit human approval per fix; no batch approve, no "fix all".
- `pipeline-inspector` itself is read-only — it *never* writes anything except the plan append.
- A kill switch in workspace config: `pipeline_inspector.enabled: false` — default opt-in.

**Trigger**. Now-ish. The recurring scratchpad-lockstep bug and the silent fix-list-dropping in recent runs are exactly the class this agent catches. Bootstrap: manually transcribe the last 2-3 runs' known inconsistencies as seed entries to prove the format.

**Effort**. Medium. New agent prompt + checkpoint parser + diff hunter (the plumbing already exists — `reporter` agent reads checkpoints.jsonl, borrow that). End-of-run prompt is a small orchestrator addition. `pipeline-fixer` is the bigger risk surface — start by making it dispatch-only-with-fix-list (never autonomous), so it's effectively a convenience wrapper around manual editing.

**Non-circularity note**. `pipeline-inspector` observing itself would be infinite regress. Solve by keeping it out of its own observation scope: the inspector's transcript is excluded from the checkpoint feed it reads. If the inspector has a bug, a human notices — and that's a meta-entry written by hand.

---

## 8. Pipeline ends at "code committed locally" — no PR step

**Problem**. The pipeline stops at Phase 7 (cross-repo assessment). Branches are committed locally; the human then pushes each repo and raises each PR by hand, copy-pasting the feature summary / requirements / assessment report into each PR description. For a feature spanning backend + frontend + mock + infra, that's four manual PRs plus four sets of copy-paste. Everything the PR description needs is already produced by earlier phases — it just isn't assembled.

**Proposal**.

Add a Phase 8 — `publish` — after Phase 7 passes. A new agent `pr-publisher` (or skill, since it's mostly shell orchestration):

- **Per repo** (parallel):
  - Confirm branch is pushed: `git push -u origin <branch>` (fail loudly if no remote configured).
  - Compose PR body from existing artifacts: feature summary + requirements (FR/EC) + spec-edit diff summary + Phase 7 assessment excerpt for this repo + test results + links to sibling PRs.
  - Create PR via `gh pr create --draft --title "<conventional-commit title>" --body-file <temp>`. Always draft by default.
  - Capture the PR URL.
- **Cross-repo linking** (second pass): after all PRs created, edit each PR body to inject the other repos' PR URLs under a "Related PRs" section. Solves the chicken-and-egg of PR numbers not existing at creation time.
- **Gate**: Phase 8 is skipped if Phase 7 assessment flagged blockers. User must resolve or explicitly override (`/deliver --publish-despite-blockers`).
- **Destination policy** in workspace config: `publish.target_branch: dev | main`, `publish.draft: true | false`, `publish.reviewers: [...]`, `publish.labels: [...]`. Defaults to `dev` + draft + no reviewers.

**Human-in-the-loop gate**. A confirmation prompt before the first push: "About to push N branches and open N draft PRs: [list]. Proceed?" The scope note in CLAUDE.md — *"Actions visible to others or that affect shared state: pushing code, creating/closing/commenting on PRs... by default transparently communicate the action and ask for confirmation before proceeding"* — applies here. No silent pushes, ever.

**PR body template** (sketch):
```markdown
## Summary
{feature_summary}

## Requirements
{FR/EC list}

## Spec changes (this repo)
{openapi-spec-editor diff summary}

## Test results
{test run output}

## Cross-repo assessment
{Phase 7 excerpt scoped to this repo}

## Related PRs
{injected in second pass}

🤖 Generated via /deliver pipeline
```

**Guardrails**:
- Never force-push; always plain `push -u`. If the remote branch diverged, fail with "branch diverged — please rebase and re-run `/deliver --publish-only`".
- Sanitize PR bodies: strip anything matching secret patterns (AWS keys, tokens) before posting.
- Fail gracefully if `gh` CLI is missing or unauthenticated: print exact commands the user can copy-paste to finish manually, don't half-complete.
- Respect repo-level PR templates if present (`.github/PULL_REQUEST_TEMPLATE.md`): merge the generated body into it rather than replacing.

**Trigger**. Now-ish. This is pure automation of a step that already happens manually; the risk is low (draft PRs are reversible) and the time saved per feature is significant — and it closes the loop between "pipeline says done" and "humans can actually review".

**Effort**. Small to medium. Mostly shell + `gh` CLI orchestration + template rendering. Cross-repo linking pass is the fiddly part. Can ship without linking and add it in a follow-up.

---

## 9. One-size-fits-all pipeline — no fast lane for simple tasks

**Problem**. Every feature goes through the full 7-phase ceremony: requirements → architecture → spec edit → sync → plan → parallel implementation (backend/frontend/mock/infra) → review → security → assess → report → context refresh. Budget per run: ~500k–1M tokens, wall time: hours. For a single-field add, a copy tweak, or a bug fix on one already-identified service, that overhead dwarfs the work. Users end up either waiting hours for a 10-minute change, or going around the plugin entirely and doing it manually — which is exactly the churn the plugin was built to eliminate.

**Proposal — "user-asserted simple mode"**. A second pipeline shape invoked as `/pipecrew-simple <service-key> "<description>"`. Service is a required CLI arg — the user naming it is the trust signal that replaces the architect. Skips phases that don't earn their cost:

| Phase | Full | Simple |
|---|---|---|
| 1 Requirements (PO) | agent + gate | **skip** — description is the spec |
| 2 Architecture | architect + gate | **skip** — user named the service |
| 3 Spec edit | editor + gate | runs, auto-commit (no gate) |
| 4 Sync | auto | runs |
| 4.5 Plan + task files | persisted | **skip** — 3 dispatches, no files |
| 5a Backend | N× parallel | **1×** named service |
| 5b Frontend | UX → gate → impl | **impl only** (`--with-ux` opts in) |
| 5c Mock | runs | runs |
| 5d Infra | CDK× | **disallowed** — bail to full if detected |
| 5.5 Review | all repos | **backend + frontend only** |
| 5.75 Security | triggered | **skip unless keyword trigger** |
| 6 Cross-repo assess | runs | **skip** — bounded scope, user vouched |
| 7 Report + context refresh | full | **short summary only** |

Single user gate: after the reviewers — "ship it or fix round?". Budget target: 100–200k tokens, wall time ~15–25 min.

**Qualifying criteria** (all must hold — enforced by a cheap triage step at intake):
- User names the target service as a CLI arg.
- Scope ≤ spec + 1 backend + frontend + mock.
- No cross-service event wiring (no new SQS, bucket, Lambda, Feign client).
- No new/changed role, permission, or auth flow.
- No DB schema change crossing services.

**Safeguards — the trust-earning layer**:
- **Infra-delta sniffer**: after spec editing, grep the diff for `bucket|queue|role|lambda|arn|policy|role_code|stage`. Any hit → abort simple mode, fall through to full.
- **Multi-service schema detector**: if the edited schema is referenced in any other service's `additional_specs` (Feign stub), bail — cross-service in disguise.
- **Reviewer escalation**: if review returns ≥3 critical findings OR the implementer reports "I need to touch X outside my declared service," auto-offer: "this turned out bigger than simple — restart in full mode?" User picks.

**The one real tradeoff**. The architect's "did the user pick the right service?" check is gone. Compensated by: users opting into simple mode know their domain. Wrong-service mistakes surface at review time with a clean escalation path — not catastrophic, one-round-trip cost of the implementer dispatch.

**Trigger**. High-value. Probably covers 60–70% of day-to-day platform work. Ship after #7 (observability) so misclassification rates can be measured; defer #5 / #6 and do this next.

**Effort**. Medium. New CLI entry point + triage function + bail-to-full escalation protocol. Reuses all existing implementer/reviewer agents unchanged. Biggest implementation risk is the infra-delta sniffer false-positive rate — worth prototyping on the existing workspace before shipping.

**Origin**. Discussed 2026-04-17 during the Book Content Upload run as a reaction to that run's ~14h wall time and ~535k tokens for a feature that, once scoped, touched only 3 services + frontend + 2 infra stacks.

---

## Suggested ordering

1. **#2 (non-circular verification)** — biggest credibility gap for feature output.
2. **#7 (pipeline-inspector)** — biggest credibility gap for the plugin itself; cheap relative to what it finds. Do this early so later items land on evidence, not memory.
3. **#9 (simple mode)** — biggest daily-UX win; ship after #7 so misclassification rate is measurable.
4. **#8 (PR publish)** — pure automation of a manual step; low risk, high daily time saving.
5. **#3 (platform manifest)** — unblocks #5 and better #4 decisions.
6. **#1 (AsyncAPI + state machines)** — pays off on first feature that needs them.
7. **#4 (approval gates)** — UX improvement, not structural.
8. **#5 (NFRs)** — defer until first incident.
9. **#6 (reproducibility)** — defer until audit / marketing need.

## What NOT to do (explicit non-goals)

- **More agents for feature work.** The crew is already the moat. #7 adds an *observer* agent, not another implementer — that distinction matters.
- **Proprietary spec format.** Stay on OpenAPI / AsyncAPI / standard formats. Custom DSLs lose the "spec-driven" claim.
- **Replacing human approval.** All of the above keeps human-in-the-loop gates; they just optimize them.
- **Letting `pipeline-fixer` run autonomously.** The plugin editing the plugin without a human read of the diff is how compounding drift starts.
