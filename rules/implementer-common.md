# Implementer common rules — framework-agnostic

> Every `*-implementer.md` agent in this plugin references this document. The rules below are universal — they apply regardless of tech stack (Spring Boot, NestJS, FastAPI, React, CDK, …). Stack-specific conventions live in each repo's `CLAUDE.md` + `agent-context/`; cross-cutting workspace patterns live in `platform.md § Established Patterns`; generic stack anti-patterns are pre-injected into per-task files by the task-planner from `{plugin_dir}/anti-patterns/{type}.md`.

These rules compose on top of each agent's stack-specific invariants. Where a shared rule conflicts with a repo-specific convention, the repo convention wins — but in practice they should agree.

> **Notation used throughout this document and the pipeline:**
> `FR-X` = a **functional requirement** ID (e.g. FR-1, FR-2) assigned by the product-owner in Phase 1. It names something the feature must do.
> `EC-X` = an **edge case** ID (e.g. EC-1, EC-2) from the same Phase 1 output. It names a boundary condition or failure mode the feature must handle.
> Both IDs appear in task files, implementation reports, and review findings — they are the shared thread that links a requirement all the way to a line of code.

---

## Rule 0 — Task file is your source of truth (HARD RULE)

Read your task file first. It contains everything: feature summary, requirements, sub-tasks, data model, API design, endpoint list, worktree path, and cumulative metrics. **Trust it over conversation context**, which may be stale on `/deliver --resume`. Do not ask the caller to repeat anything in it; if a section seems absent, re-read before reporting it missing.

On completion, update the task file per `{plugin_dir}/skills/deliver/phases/dispatch-rules.md`: append your Work Log entry and bump the YAML metrics.

---

## Rule 1 — Read the repo's CLAUDE.md + agent-context first

Before any code change, read `{repo_path}/CLAUDE.md` and the agent-context docs it points to (typically `{repo_path}/agent-context/`). These are the authoritative repo-specific conventions: how this repo handles auth, persistence, tests, config, routing, error mapping, naming. CLAUDE.md is the per-repo source of truth.

For workspace-wide patterns (cross-cutting decisions like "we use JWT auth" or "all services log to CloudWatch"), the architect captured them in `{workspace_root}/{slug}/context/platform.md` § `Established Patterns`. That section is small and worth a read pass once per dispatch.

For stack-conventional traps that apply to any workspace using this stack (e.g., Spring Boot's `Exception → HTTP status` convention, React's useCallback dependency stability), the task-planner has already pre-injected the relevant ones into your task file's `## Known Anti-Patterns` section. You do not need to load `{plugin_dir}/anti-patterns/{type}.md` separately — the planner pulls from it. Treat the anti-patterns section in your task file as the active checklist.

**Pattern discipline** — see Rule 10 (`Inherit, don't invent`). Before writing any new code, find the closest analog in this repo and follow its shape. Inventing a new pattern when an existing one exists is the most common review-flagging issue and is a Critical or Non-critical finding at review time depending on whether the invention is architectural or mechanical.

**Frontend repos — additional UX contract.** A frontend feature has two orthogonal contracts:
- **Engineering**: `{repo_path}/CLAUDE.md` + agent-context (API client factory, OpenAPI types, data fetching, hooks, routing, state, i18n, tests, file layout).
- **UX**: the repo's `DESIGN_SYSTEM.md` (component-tree patterns, tab shells, row actions, modals, tokens, RTL vocabulary).

Resolve the DESIGN_SYSTEM.md path in this order:
1. Read `{workspace_root}/{slug}/config.json`. If `repos[repo-name].design_system_path` is set, use `{repo.path}/{design_system_path}`.
2. Otherwise probe the canonical path `{repo.path}/agent-context/common/DESIGN_SYSTEM.md`.
3. If neither yields a file, note the gap in your report and follow the IMPLEMENTATION_SPEC's references directly without a canonical UX source.

A change can violate engineering and UX independently — both need to match.

---

## Rule 2 — Validate config files you edit

After editing any config file (YAML / TOML / JSON / XML / properties / ini / dotenv), run a parse check before reporting done:

| Format | Check |
|---|---|
| `*.yaml` / `*.yml` | `npx yaml-lint {file}` or `python -c "import yaml; yaml.safe_load(open('{file}'))"` or `yq eval . {file}` |
| `*.json` | `python -m json.tool {file}` or `node -e "JSON.parse(require('fs').readFileSync('{file}','utf8'))"` |
| `*.toml` | `python -c "import tomllib; tomllib.load(open('{file}','rb'))"` (Python 3.11+) or equivalent |
| `*.xml` (e.g. `pom.xml`) | `xmllint --noout {file}` |
| `*.properties` | Trivially `grep -n '=' {file}` to verify every non-empty / non-comment line has `=` |

**Structural integrity** matters as much as parse success. For hierarchical formats (YAML, TOML), confirm you didn't accidentally un-nest a key — moving `sqs:` out from under `aws:` parses fine but ships a broken config. Diff the key paths before/after (`yq eval '... | path | join(".")' {file}` for YAML). Any unrequested structural change is a **Critical** regression.

---

## Rule 3 — `git status` hygiene before reporting done

Run `git status --short`. Stage only what you intentionally changed. If noise appears (IDE files, crash logs, build artifacts, harness files), fix `.gitignore` — append the missing pattern, never overwrite entries, then re-run `git status` to confirm it's clean. Only files you deliberately wrote or modified should appear in the working tree when you report done.

---

## Rule 4 — Security tests when auth/role enforcement changes

If your change added, modified, or removed an auth guard, role check, permission rule, or route protection, a security test must accompany it:

- **Allowed role(s)** — one test per role that should pass.
- **Denied role(s)** — at least one test per role that must be rejected (403).
- **Unauthenticated** — one test confirming 401 when no auth is present.

The test harness is stack-specific. Inspect the existing tests in this repo (per R10, the implementer's first move is to read 1-2 existing tests of the same shape — e.g., `@WebMvcTest + @WithMockUser + spring-security-test` for Spring Boot; framework-equivalent fixtures for NestJS, FastAPI, Next.js, etc.) and follow that pattern. If no security test exists yet in this repo, this feature establishes the harness — pick a shape consistent with the repo's other tests, document it in the repo's CLAUDE.md if it's worth establishing as the convention.

Add any necessary test dependency to the project's manifest (`pom.xml`, `package.json`, `pyproject.toml`, …) as part of the change. A missing test dependency is a blocker, not a follow-up.

---

## Rule 5 — Documentation updates are part of done (HARD RULE)

Your change is not complete until the documentation that describes it is also up to date. **Reviewers MUST flag missing updates as Critical findings.** A PR without updated agent-context for an architecturally significant change is incomplete.

**Triggers — update agent-context if any apply:**

- New feature (controller / endpoint / page / component / handler / event consumer)
- Refactor that changes architecture, naming conventions, file organization, package structure, or established patterns
- Enhancement that touches a documented pattern (auth, persistence, validation, state machines, integrations)
- New entity, status enum, role, permission, or domain concept
- New integration with an external system (SQS / SNS / S3 / Kafka / DB / external API)
- New exception type, error code, or HTTP status mapping
- Removal of any of the above

**Where to update.** Start from `{repo}/agent-context/AGENT_INDEX.md` — it indexes every other doc in the repo (feature catalogue, architecture, conventions, per-endpoint reference). Update `AGENT_INDEX.md` AND every downstream file it points to that became stale by your change. The actual filenames vary per repo; the index is the authoritative map.

If your change crosses workspace-level patterns (a convention worth all repos of this stack adopting), surface it in your report as a `## Doc-update candidate` so a `/learn` run can promote it to `platform.md § Established Patterns`. For frontend repos with UX-level changes, update `{repo}/agent-context/common/DESIGN_SYSTEM.md` directly.

**Do NOT routinely edit `{repo}/CLAUDE.md`.** It's the stable repo-wide index + agent guidelines + must-knows. Touch it ONLY when you're introducing a new top-level topic that needs a Deep-context table row, or a new must-know rule that applies repo-wide. Routine feature work lands in `agent-context/`, not in `CLAUDE.md`.

**Deferral is allowed only with explicit, written reason.** If conventions are in flux and the doc would be premature, surface it in your report exactly like this so `/context-refresh` can pick it up:

> AGENT-CONTEXT-DEFERRED: {what wasn't updated} ({why}) — `/context-refresh` follow-up needed.

Where the repo's own `CLAUDE.md` rules are stricter than this rule, the repo wins.

---

## Rule 6 — Scope discipline (HARD RULE)

Touch only what the task names. Every line you add, modify, or delete should trace to an `FR-X`, `EC-X`, or sub-task line in the task file. If a line in your diff has no such trace, you should not have written it.

**Common scope traps to avoid:**

- New abstractions (base classes, mixins, helper modules) when one concrete site is enough
- Config flags, feature toggles, or "knobs" the task does not name
- Extensibility hooks for features that may never ship
- Defensive layers (try/catch, retries, fallbacks) for failures that cannot happen given the requirements
- Refactoring adjacent code the task does not ask you to touch
- Renaming variables or files for "consistency" when the task is about behavior

When you find yourself adding something the task doesn't name, **stop and ask the orchestrator**. Do not silently grow the scope.

**Read the task file's `## Out of Scope` section** if present — it lists what the user or architect already decided to defer. If a feature you'd "naturally" add appears there, don't add it.

**Pre-existing dead code is not yours to fix.** If you spot unused imports, dead functions, or commented-out code that you didn't introduce, report it in your output, do not delete it. The exception: orphaned code created by your own change (e.g., a function whose only caller you removed) — clean up your own mess.

The downstream code reviewer will flag any diff hunk that has no FR/EC trace as a Scope finding. Saving them that work means writing less code, not more.

---

## Rule 7 — State assumptions before coding (HARD RULE)

Ambiguity in the task file is a stop signal, not a guess invitation.

**Before writing code**, scan the task file for unresolved questions:

- Field names, types, or enum values not present in the spec / inline contract
- Sub-task lines that could be read two ways (e.g., *"add audit logging"* — to which events? at what level?)
- FR / EC lines that depend on behavior the task file doesn't specify
- Cross-cutting choices not pinned down (e.g., reuse an existing utility vs. write new)

Classify each ambiguity:

- **Stylistic** — same observable behavior either way (e.g., *"method on the service or the controller?"*). You decide; mention it once in your report.
- **Load-bearing** — different choices produce different behavior, different contracts, or different test outcomes (e.g., *"is this field required or optional?"*). **Stop. Do not guess.** Return to the orchestrator with an `## Assumptions` block listing what's ambiguous and what you'd need to proceed.

**`## Assumptions` block format** — emit at the **top** of your report, before any "Files created" section:

```markdown
## Assumptions
- {ambiguity 1}: {what you'd assume if forced to proceed} — {why this needs confirmation}
- {ambiguity 2}: ...
```

If the orchestrator already answered the question in the dispatch prompt or in the task file body, do not list it as an assumption — read more carefully first.

**For `code-first` services**, the inline contract IS the spec. Ambiguity in the inline contract is load-bearing by definition — never guess field names, status codes, or error shapes. Stop and report.

---

## Rule 8 — Stay in your launched worktree (HARD RULE)

The orchestrator launches you with a specific worktree path in your task file. **All your file edits MUST land inside that worktree.** Do not:

- Run `git checkout <other-branch>` or `git switch <other-branch>` — you'll desync from the orchestrator's parallel dispatch model and overwrite work in other worktrees.
- Run `git worktree add` — the orchestrator owns worktree creation; a second worktree on the same branch breaks Phase 5.5 + Phase 6 path resolution.
- Edit files in the main repo checkout (the path the worktree was created from).
- Edit files in any other repo's worktree, even if they look related — cross-repo changes are different tasks dispatched to different agents.

**If you need to read code from another branch** (e.g., to see how an existing feature is implemented on `main`), use `git show <branch>:<path>` or `git diff <branch>..HEAD` — read-only operations that don't move you off your branch.

**If your task genuinely requires touching another repo**, stop and report — the orchestrator will dispatch a separate task there. Cross-repo writes from one agent are a parallelism hazard.

---

## Rule 9 — Verify requirement coverage before reporting done (HARD RULE)

Before you write your final report, walk every functional requirement (FR-X) and edge case (EC-X) listed in your task file and identify the `file:line` that enforces each one. Emit this in **two forms** in your report:

**1. A human-readable `## Requirement coverage` table:**

```markdown
## Requirement coverage
| ID   | Enforcement point           |
|------|-----------------------------|
| FR-1 | BookService.java:84         |
| FR-2 | BookController.java:42      |
| EC-1 | BookService.java:91 + BookServiceTest.java:120 |
```

**2. A structured `<!-- BEGIN COVERAGE -->` JSON block** (so the reviewer extracts it programmatically via `extract-block.js` instead of re-parsing the table):

```markdown
<!-- BEGIN COVERAGE -->
```json
{ ... matches {plugin_dir}/templates/blocks/coverage.example.json ... }
```
<!-- END COVERAGE -->
```

Both must list the same IDs. If any FR or EC has no enforcement point you can name, **fix it before reporting done** — do not leave a gap for the reviewer to discover. A reviewer finding an unenforced requirement costs a full fix round; catching it yourself costs nothing.

---

## Rule 10 — Inherit, don't invent (HARD RULE)

The implementer's job is faithful continuation of an existing system, not greenfield design. Before writing any new code, identify how this repo (and sibling repos of the same `type`) solves analogous problems, and follow that pattern.

**How to apply**:

1. Read `{repo_path}/CLAUDE.md` and the agent-context docs it points to (Rule 1).
2. Search this repo for the closest analog to what you're about to write:
   - **Adding a controller / route handler / endpoint?** Read 1–2 existing ones in this service. Match imports, exception handling, logging pattern, test layout.
   - **Adding a hook / component?** Read 1–2 existing hooks/components. Match React Query usage, error boundaries, naming style.
   - **Adding a migration?** Read the most recent migration in `db/changelog` / `db/migration` / `alembic/versions` / `migrations/`. Match naming + format.
   - **Adding a service / repository / DTO?** Same idea — find the nearest sibling, follow its shape.
3. If no analog exists in **this** repo, scan sibling repos of the same `type` (the orchestrator's dispatch prompt names them — they're listed in `config.repos`). Read-only. The first matching analog is your reference.
4. Only when neither this repo nor sibling repos have an analog, fall back to (a) the plugin anti-patterns already injected into your task file's `## Known Anti-Patterns`, and (b) your own training. In that case, **record the choice in your `## Assumptions` section** so the reviewer knows it was a deliberate decision, not an oversight.

**Anti-patterns to avoid**:

- Importing a library the repo doesn't already use (e.g., adding `lodash` to a repo using native helpers; adding a new HTTP client when the repo has a documented one).
- Inventing a new test layout / framework when an existing one exists.
- Using a new error-handling style when the repo has a documented one (e.g., manual `try/catch` + `ResponseEntity` when the repo uses a `GlobalExceptionHandler`).
- Adding a new top-level directory under `src/` without a precedent.
- Picking a different naming style (snake_case vs camelCase, `*Service` vs `*Manager`, etc.) than the existing files.

**Self-test for adherence**: ask yourself — *"Could a reviewer point to an existing file in this repo that uses the same pattern I just wrote?"* If no, you're inventing — stop, scan, re-anchor. If you genuinely need a new pattern (the existing pattern doesn't fit, or you have a load-bearing reason to deviate), flag it as an architectural decision in your `## Assumptions` block rather than slipping it in as implementation.

**At review time**: the reviewer runs a Pattern Adherence pass against this rule. Mechanical inventions (off-by-one naming, slightly different log format) become Non-critical findings. Architectural inventions (new dependency, new directory, new framework usage, new test harness) become Critical and gate-block the run unless explicitly authorized via `## Assumptions`.

---

## When the existing pattern is itself a documented anti-pattern

R10 prevents *unmotivated* invention — adding a new approach when an established one already exists. It does NOT force you to copy a documented bug.

If the existing pattern in this repo matches a bullet in your task file's `## Known Anti-Patterns` section (or in `audit-findings.md` for the files you touch), the anti-pattern wins. Deviating from the existing shape in that case is *motivated* — not invention.

**Priority when patterns conflict** (most specific wins):

1. **Workspace audit findings** (`audit-findings.md`) — bugs the architect identified in this codebase during `/discover`. Strongest signal because evidence-based and workspace-specific.
2. **Stack anti-patterns** (`{plugin_dir}/anti-patterns/{type}.md`, pre-injected into your task file by Phase 4.5) — common failure modes for this stack.
3. **Existing repo pattern** (R10) — what the code does today.
4. **Your training** — fallback when none of the above pin the decision.

**After deviating**:

- Name the trigger in your `## Assumptions` block — which audit-finding ID or anti-pattern bullet drove the deviation, and what you chose instead. The reviewer recognises that as deliberate correction, not invention.
- **R5 governs what happens next.** A deviation that changes an "established pattern" or touches a "documented pattern" (R5's triggers) requires updating the relevant `agent-context/` doc to reflect the new convention. If the new convention should propagate workspace-wide, surface it as a `## Doc-update candidate` so a `/learn` run can promote it to `platform.md § Established Patterns`.

If you find what looks like an anti-pattern in this repo but it is **not** listed in audit-findings or your task's Known Anti-Patterns, default to R10 (follow the pattern) and flag the concern in your report. Implementer dispatches are not the right place to relitigate decisions the architect didn't surface — that's a `/learn` or `/context-refresh` job.

---

## When the repo CLAUDE.md and broader workspace patterns disagree

The repo's `CLAUDE.md` wins for that repo. If the architect's `platform.md § Established Patterns` documents a workspace-wide rule that THIS repo doesn't follow, that's a divergence — the implementer follows the repo's actual pattern, but flags the divergence in the report so it can be either reconciled or explicitly recorded.

If you genuinely need to deviate from a documented convention, surface it in your `## Assumptions` block with the reason and flag it as a doc-update candidate (under `/learn` or `/context-refresh`).
