# Implementer common rules — framework-agnostic

> Every `*-implementer.md` agent in this plugin references this document. The rules below are universal — they apply regardless of tech stack (Spring Boot, NestJS, FastAPI, React, CDK, …). Stack-specific conventions live in the target workspace's `{workspace_root}/{slug}/context/stacks/{type}.md` and in each repo's own docs.

These rules compose on top of each agent's stack-specific invariants. Where a shared rule conflicts with a repo-specific convention, the repo convention wins — but in practice they should agree.

---

## Rule 0 — Task file is your source of truth (HARD RULE)

You are dispatched by an orchestrator that creates a task file at a known path and passes that path in your launching message. **Your FIRST action is always: read that task file.** Its body contains everything you need to do the work:

- Feature summary + linked requirements (FR-X / EC-X)
- Sub-task checklist
- Data model + API design from the architect
- Endpoint list with exact spec field names
- IMPLEMENTATION_SPEC from the ux-consultant (frontend) or equivalent design block
- Worktree path you must work in
- YAML frontmatter with cumulative metrics

**Do not ask the caller to repeat anything that's in the task file.** If a section seems missing, re-read the file — sections are clearly delimited. If genuinely absent, stop and report which section is missing rather than guessing.

**The task file — not the chat — is the single source of truth.** Conversation context may be empty or stale (especially on `/deliver --resume`). Trust the file.

**On completion, update the task file** per the rules in `{plugin_dir}/skills/deliver/phases/dispatch-rules.md`: append your Work Log entry and bump the YAML frontmatter metrics.

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

**Structural integrity** is as important as parse success. If the file is hierarchical (YAML, TOML), confirm you did not change the nesting level of an existing key — the most common silent config bug is accidentally un-nesting a key during a whitespace-sensitive edit (e.g., moving `sqs:` out from under `aws:`). Before-and-after path listings help:

```bash
# YAML example — print the tree of top-level paths, compare before/after the edit
yq eval '... | path | join(".")' {file}
```

Any structural change that wasn't requested is a **Critical** regression. Unintentional indentation / nesting changes ship broken configs silently; downstream runtime errors won't point here.

---

## Rule 3 — `git status` hygiene before reporting done

Run `git status --short` in your working directory. Every file listed must be something you deliberately wrote, modified, or staged. If you see:

- JVM / language-runtime crash artefacts: `hs_err_pid*.log`, `replay_*.log`, `*.hprof`, `core`, `core.*`
- Editor / IDE artefacts: `.idea/`, `.vscode/`, `*.iml`, `*.swp`
- Harness artefacts: `.claude/settings*.json`, `.claude/worktrees/`, `.claude/agent-memory/`
- Build artefacts that shouldn't be tracked: `target/`, `build/`, `dist/`, `node_modules/`
- Local environment files: `.env.local`, `.env.*.local`

…do NOT stage them. Either:

1. The repo's `.gitignore` should cover them. If it does, they won't appear in `git status` — investigate why they're showing up.
2. The `.gitignore` is missing the pattern. Append the missing pattern to `.gitignore` (never overwrite existing entries), commit the `.gitignore` change alongside your real change, and re-run `git status` to confirm the noise is gone.
3. If the harness is running inside a worktree and the IDE dropped crash logs there (common with VS Code / IntelliJ JDT-LS), add the pattern to `.gitignore` at the repo root — the logs are never the repo's concern.

Only files you intentionally changed should be present in the working tree when you report done.

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

The repo's `CLAUDE.md` itself typically specifies its own documentation-update rules — re-read them before reporting done. Where the repo's rules are stricter than this rule, the repo wins.

---

## When shared and stack-specific rules disagree

The stack standards doc wins for stack-specific details; these common rules win for universal discipline. Example: the Spring Boot standards doc names the security-test harness (`@WebMvcTest + @WithMockUser`); Rule 4 above mandates that *some* security test must exist — the stack doc tells you *which kind*.

If you genuinely need to deviate from a documented standard, surface it in your report with the reason and flag it as a doc-update candidate.
