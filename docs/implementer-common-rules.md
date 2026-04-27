# Implementer common rules — framework-agnostic

> Every `*-implementer.md` agent in this plugin references this document. The rules below are universal — they apply regardless of tech stack (Spring Boot, NestJS, FastAPI, React, CDK, …). Stack-specific conventions live in the target workspace's `{workspace_root}/{slug}/context/stacks/{type}.md` and in each repo's own docs.

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

## Rule 1 — Read the workspace's stack standards doc first

Before any code change, read `{workspace_root}/{slug}/context/stacks/{repo.type}.md` — the authoritative engineering-conventions document for the stack you are about to code in. Workspace onboarding (`/discover` Phase B2.5) bootstrapped it from the actual code in the workspace's repos of that type. Every concern you're about to touch (auth, persistence, tests, config, routing, etc.) has a §-numbered section in the doc naming the workspace's established pattern.

- Match those sections. Drift = **Non-critical** finding at review time.
- If your change introduces a concern the doc doesn't cover (§ missing), you're establishing a pattern. Document the shape you chose in your report, flag the doc gap so `/context-refresh` can backfill it.
- If the doc doesn't exist: the workspace skipped or hasn't run Phase B2.5. Note it in your report (*"stacks/{type}.md missing — run `/discover --resume`"*) and fall back to reading existing code to infer the convention.

**Conflict resolution.** When the repo's `CLAUDE.md` (or files it points to under `agent-context/`) and the workspace's `stacks/{type}.md` disagree on a convention, **the repo's CLAUDE.md wins for that repo** — but surface the divergence in your report so it can either be reconciled, or recorded in `platform.md § Per-Service Divergences`.

**Frontend repos — additional UX contract.** Two contracts govern frontend work, orthogonal:
- **Engineering**: `stacks/{type}.md` (e.g., API client factory, OpenAPI types, data fetching, hooks, routing, state, i18n, tests, file layout) — same as above.
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

The test harness is stack-specific and documented in the workspace's `stacks/{type}.md` §Tests (e.g., `@WebMvcTest + @WithMockUser + spring-security-test` for Spring Boot; framework-equivalent fixtures for NestJS, FastAPI, Next.js, etc.). If the harness section reads *"Not established yet"*, this feature is establishing it — pick a shape, document it, flag the doc gap so `/context-refresh` can backfill.

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

If your change crosses workspace-level patterns, also update `{workspace_root}/{slug}/context/stacks/{type}.md` (engineering conventions) and, for frontend repos, `{repo}/agent-context/common/DESIGN_SYSTEM.md` (UX patterns).

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

## When shared and stack-specific rules disagree

The stack standards doc wins for stack-specific details; these common rules win for universal discipline. Example: the Spring Boot standards doc names the security-test harness (`@WebMvcTest + @WithMockUser`); Rule 4 above mandates that *some* security test must exist — the stack doc tells you *which kind*.

If you genuinely need to deviate from a documented standard, surface it in your report with the reason and flag it as a doc-update candidate.
