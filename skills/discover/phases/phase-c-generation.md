## Phase C: Generation

Generate all workspace-layer files. This phase creates the config, CLAUDE.md files, domain agents, and optional agent-context docs.

**Incremental mode** (`discover_mode == incremental`): scope this phase to `new_repos`. Specifically: (1) config.json was already MERGED in B2 — Step 1 just re-validates; (2) Step 2 generates CLAUDE.md + agent-context for the new repos only — existing repos' docs are never touched; (3) **skip domain-agent generation** (Step 3 and the implementer-agent publish) — the workspace `agents/` and published `~/.claude/agents/{slug}-*` already exist and don't change when repos are added; if a new repo's stack has no matching plugin implementer/reviewer, note it for the user instead of generating one; (4) Step 4 appends the new repos' audit findings to the existing `context/audit-findings.md`. Full spec: `{plugin_dir}/rules/incremental-discovery.md` § "Phase C". The steps below otherwise run as written, looping over the new repos.

---

### Transient failure handling (applies to every Agent dispatch in this phase)

Apply the shared retry rules at `{plugin_dir}/rules/transient-failures.md`. Every retry and deferred outcome is also recorded as `retry` / `agent_end` events in `checkpoints.jsonl` per `rules/observability.md`. In the scratchpad, annotate `## Phase Status` notes with any deferrals so `/discover --resume` can pick them up.

---

### Audit Findings contract (applies to every code-analysis Agent in this phase)

During onboarding, analysis agents routinely read actual source files and frequently notice real defects — DB-invalid enum writes, hard-coded 501 responses, documented values that contradict code, beans instantiated with `new` bypassing DI, configs registered but not wired, etc. These observations are the **highest-signal bytes of onboarding** (on the first DAL run, context-manager agents surfaced 7 live bugs this way). If we don't capture them here, they vanish into chat narration and have to be re-discovered later.

Every Agent prompt in Steps 2 and 4 MUST include the following trailing instruction:

> **Audit Findings**: if during your analysis you notice anything that falls into the categories below, end your response with a `## Audit Findings` section — one bullet per finding, formatted as `- [severity] file:line — description (evidence: <short quote or value>)`. Severities: `critical` (will fail at runtime), `high` (latent bug / contract violation), `medium` (inconsistency or footgun), `low` (style/doc drift). Report ONLY things you actually saw in the code; do not speculate. If nothing qualifies, omit the section entirely — do not write "nothing to report".
>
> Qualifying categories:
> 1. **Enum / state value rejected by a DB constraint, schema, or generated type** (e.g., code writes `REJECTED` but the CHECK constraint was narrowed).
> 2. **Endpoint / handler that returns a non-success status unconditionally** (e.g., `return 501`, `throw new NotImplementedException()` in the happy path).
> 3. **Filter / interceptor / listener / bean declared but not registered** (class exists, `@Bean` or `addFilterBefore` missing).
> 4. **Bean instantiated with `new` bypassing DI** when an injectable exists (e.g., `new ObjectMapper()` instead of the configured bean).
> 5. **Documented value that contradicts code** (CLAUDE.md / README says X, code shows Y).
> 6. **Duplicate side effects** — same persistence/event emitted by two independent code paths (e.g., `@DomainEvents` + explicit service call both inserting into the same audit table).
> 7. **Exception type that maps to a surprising HTTP status** (e.g., `FooNotFoundException extends IllegalArgumentException` → 400, not 404).
> 8. **TODO / FIXME / `@deprecated` with a severity word** (`urgent`, `broken`, `do not use`, `replace before`).
> 9. **Hard-coded secrets or credentials** — flag immediately as `critical`.
> 10. **Schema / spec drift** — a field present in DB but not spec, or vice versa.

After the agent returns, parse its `## Audit Findings` section (if present) and append to `{workspace_root}/{slug}/context/audit-findings.md` (create on first finding, one H2 section per source repo). See **Step 4: Collate audit findings** at the end of this phase.

---

### Step 1: Verify workspace config

`config.json` is now generated at the **end of Phase B2** ("Build workspace config (config.json)" in `phases/phase-b2-architect-synthesis.md`) so Phase B2.6's observability extractor can read it. By the time Phase C runs, the file already exists and has been validated — including the `spec_copies` probe and `spec_policy` assignment, which all live in that B2 step.

Re-validate it here (cheap — catches drift if Phase A repo confirmations changed after B2 wrote the config):

```bash
node {plugin_dir}/scripts/validate-config.js {workspace_root}/{slug}/config.json
```

**If the file is missing** — e.g., resuming a run that predates this ordering, or B2 was somehow skipped — build it now per the full spec in the **"Build workspace config (config.json)" step of `phases/phase-b2-architect-synthesis.md`** (config shape, `spec_policy` table, and `spec_copies` probe all live there), then re-validate. Do **not** re-prompt the "config already exists" warning for the file B2 just wrote — that early gate (CRITICAL RULE 2) is for configs left over from a *previous* `/discover` run, not the one this run produced in B2.

**Update scratchpad**: confirm `Workspace config` is COMPLETED in `## Generation Status` (B2 sets it; leave as-is if already done).

---

### Step 2: Generate CLAUDE.md + agent-context per repo (merged flow)

**Replaces the former Step 2 (CLAUDE.md generator) + Step 4 (agent-context generator).** Both artifacts are now produced by a single `context-manager` dispatch per repo — the deep read happens once, agent-context is written first, CLAUDE.md is written as a thin index that references agent-context. See `GENERALIZE-PLAN.md` Section 13 for the full rationale.

**Resume-safe**: for each repo, check the scratchpad's Generation Status. If a repo's CLAUDE.md row is already COMPLETED, skip it.

#### Per-repo gate — ask the user which generation mode to use

For each repo whose CLAUDE.md is missing (or where the user opts to regenerate), present:

```
Repo "{repo-name}" ({type}, {role}) — how should agent docs be structured?

  (a) Full — agent-context/ + CLAUDE.md index (recommended)
      ℹ️ Multi-file deep dive under agent-context/; CLAUDE.md becomes a
      thin index. Best for non-trivial repos — one Read gets you the map,
      deeper Reads only when you need the detail.

  (b) CLAUDE.md only — self-contained, no subdirectory
      ℹ️ Lighter. Right for small/simple repos that don't warrant
      multiple context files. Can be upgraded to (a) later.

  (c) Manual — you run Claude Code's /init yourself
      ℹ️ cd {path} && claude /init in a separate terminal.
      Type "done" here when finished. CLAUDE.md only — no agent-context.
```

**Default**: (a) Full. Complexity signals (>200 source files, >8 endpoints, component library detected, multiple modules) raise the recommendation but don't skip the prompt. If an existing non-empty `agent-context/` is present, the default stays (a) but context-manager will use refresh semantics to merge rather than overwrite.

**If CLAUDE.md already exists** (but user chose to regenerate): show a diff after generation and confirm before overwriting. Never silently overwrite a hand-curated CLAUDE.md.

#### Dispatch — option (a) or (b)

**Tool**: `Agent`
**subagent_type**: `context-manager`
**description**: `"Generate docs ({mode}) for {repo-name}"`

Mode-specific prompts:

For (a):
```
Mode: full
Repo: {repo_path}
Repo type: {type}
Repo role: {role}

Read {repo_path}/CLAUDE.md if it exists, and any existing agent-context/ directory (non-empty → use refresh semantics for that directory; do not destroy-and-rewrite). Then follow the `full` mode instructions in your system prompt.

Template dispatch (per your system prompt):
- role = api-service OR worker → use templates/agent-context-backend/ + templates/repo-CLAUDE-backend.md.template
- role = frontend             → use templates/agent-context-frontend/ + templates/repo-CLAUDE-frontend.md.template
- role = mock-server / infrastructure / contract / other → downgrade to claude-only mode (use templates/repo-CLAUDE.md.template)

Output order:
1. agent-context/ first — fill every *.md.template in the chosen bundle (AGENT_INDEX, business-context, architecture, conventions, plus role-specific singletons). Strip the <!-- AGENT INSTRUCTIONS --> blocks. Preserve <!-- agent-updatable --> / <!-- human-owned --> markers verbatim.
2. For each bounded context (backend) or feature module (frontend) that warrants its own file (see triggers in the bundle's domains/_template.md or features/_template.md), copy the template, rename, and fill.
3. For each external system the repo integrates with (backend) or backend service the repo consumes (frontend), copy the matching _template.md and fill.
4. CLAUDE.md second, using the role-specific template, referencing agent-context.

Validate CLAUDE.md with: node {plugin_dir}/scripts/validate-claude-md.js {repo_path}/CLAUDE.md
On exit 1, fix the flagged issues and re-validate. On exit 2, record warnings but continue.

Audit Findings: apply the contract from the top of Phase C. End your response with a `## Audit Findings` section if you observed qualifying issues. Put findings in your REPLY, never in the generated files.
```

For (b):
```
Mode: claude-only
Repo: {repo_path}
Repo type: {type}
Repo role: {role}

Read {repo_path}/CLAUDE.md if it exists. Then follow the `claude-only` mode instructions in your system prompt to produce a self-contained CLAUDE.md at {repo_path}/CLAUDE.md, using the template at {plugin_dir}/templates/repo-CLAUDE.md.template. Include the `<!-- claude-only-mode -->` sentinel at the top so the validator skips the mandatory-bullet check.

Validate with: node {plugin_dir}/scripts/validate-claude-md.js {repo_path}/CLAUDE.md
On exit 1, fix the flagged issues and re-validate. On exit 2, record warnings but continue.

Audit Findings: apply the contract from the top of Phase C. End your response with a `## Audit Findings` section if you observed qualifying issues. Put findings in your REPLY, never in the generated files.
```

After the agent returns: extract any `## Audit Findings` section from its response, keyed by repo name, for later collation in Step 4. Do NOT write findings into CLAUDE.md or agent-context — they belong in the workspace-level audit doc.

**Validator is mandatory**: if the agent did not run the validator, run it from the orchestrator now. If exit code is 1, dispatch a fix-round to the same context-manager with the validator output as `fix_list` and re-validate. Only mark the repo COMPLETED when the validator exits 0 or 2.

#### Dispatch — option (c) manual

Print instructions and wait:
```
Run this in a separate terminal:
  cd {repo_path}
  claude /init

Type "done" here when you've finished.
```

Wait for "done". Then verify `{repo_path}/CLAUDE.md` exists and run the validator against it. If the validator fails, surface the errors and ask the user to fix them before continuing — do not auto-fix a human-written CLAUDE.md.

#### Batch behavior (default: all-auto-parallel when ≥2 repos need docs)

If 2+ repos need generation, default to parallel dispatch of (a) for every repo (the recommended mode). Tell the user what's happening, with a clear opt-out:

```
{N} repos need docs. Dispatching all in (a) Full mode in parallel (default for batches ≥2).
Reply with `one-by-one` to switch to interactive per-repo gate,
or `all-b` to use (b) CLAUDE.md-only for all of them.
Otherwise I'll proceed with the default on the next turn.
```

For N=1, use the standard (a)/(b)/(c) interactive prompt.

Parallel dispatch: send ALL Agent tool calls in a single orchestrator message (one tool call per repo) so they run concurrently. On any per-agent failure, apply the **Transient failure handling** rules — retry only the failed call, let the rest finish.

**On transient failure** (529/503/429/network timeout): apply the rules at the top of this phase. If the retry also fails, record the repo under "deferred" in the scratchpad and continue — the user can re-run `/discover --resume` later.

**Update scratchpad**: after each repo finishes, set its CLAUDE.md row in `## Generation Status` to COMPLETED (and its agent-context row if mode was (a)).

---

### Step 3: Generate domain-specific agents

Read the template files from the plugin:
- `{plugin_dir}/templates/agents/product-owner.md.template`
- `{plugin_dir}/templates/agents/assessor.md.template`
- `{plugin_dir}/templates/agents/troubleshooter.md.template`

> **No workspace ux-consultant.** The UX consultant is **not** workspace-generated — it uses the rich, framework-agnostic base plugin agent `pipecrew:ux-consultant` everywhere (B3 discovery mode + `/deliver` Phase 5b design mode), exactly like `solution-architect`. It reads the workspace's design system + `platform.md` at dispatch time, so it needs no baked-in workspace copy. Do not re-add a `{slug}-ux-consultant`.

Replace placeholders using data from B1 + B2:

| Placeholder | Source |
|-------------|--------|
| `{{WORKSPACE_SLUG}}` | workspace config |
| `{{WORKSPACE_NAME}}` | workspace config |
| `{{QUALITY_STANDARDS}}` | Default quality bar (can be customized later). Include: "Backend: all spec endpoints implemented, DTOs match, tests cover happy path + main error. Frontend: all FR- requirements implemented, types match spec, i18n both languages. Mock: all endpoints covered, shapes match spec." |

Note: the older `{{DOMAIN_CONTEXT}}` and `{{DESIGN_SYSTEM_CONTEXT}}` placeholders were removed from the templates. Agents now read `{workspace_root}/{slug}/context/platform.md` and `design-system.md` directly at dispatch time. This keeps the agents' knowledge always fresh (no summary-drift risk) and leaves no baked-in copy of workspace context to go stale between onboarding refreshes. If older templates with these placeholders are encountered, treat them as pointers — replace their value with the "read the file" instruction already present in the current templates.

Write the filled agents to `{workspace_root}/{slug}/agents/`:

```bash
mkdir -p {workspace_root}/{slug}/agents
```

Write:
- `{workspace_root}/{slug}/agents/product-owner.md`
- `{workspace_root}/{slug}/agents/assessor.md`
- `{workspace_root}/{slug}/agents/troubleshooter.md`

#### Publish to user-level agents directory (B1)

The workspace-local agent files above are the canonical copies — they're version-controlled alongside workspace config and can be hand-edited. But Claude Code's `Agent` tool only resolves `subagent_type` against `~/.claude/agents/` (user-level) and `.claude/agents/` (project-level). So `dal-assessor` (referenced by `phase-6-assess.md`) will not resolve unless we also publish a copy there.

After writing the three workspace-local files, also publish them to `~/.claude/agents/` with the slug-prefixed names that downstream phase files already use:

```bash
mkdir -p ~/.claude/agents
```

For each of (`product-owner`, `assessor`, `troubleshooter`):

1. **Conflict check (B2)**: before copying, check whether `~/.claude/agents/{slug}-{role}.md` already exists.
   - If it does **and** the `name:` frontmatter value already matches `{slug}-{role}`, it's our own file from a prior onboarding — overwrite silently.
   - If it exists with a **different** `name:` value, stop and ask the user:
     ```
     ~/.claude/agents/{slug}-{role}.md already exists with name: '{other-name}'.
     Overwrite? (yes / no / rename-existing-to-{slug}-{role}-backup.md)
     ```
     Act on the user's answer. Do NOT silently clobber.
2. Copy the workspace-local file to the user-level path:
   ```bash
   cp {workspace_root}/{slug}/agents/{role}.md ~/.claude/agents/{slug}-{role}.md
   ```

After all three publish, verify Claude Code can see them:
```bash
ls ~/.claude/agents/{slug}-{product-owner,assessor,troubleshooter}.md
```

Print a one-liner to the user: `Workspace agents published: {slug}-product-owner, {slug}-assessor, {slug}-troubleshooter — downstream pipeline phases will dispatch them by name. (UX consultant uses the base pipecrew:ux-consultant.)`

#### Placeholder substitution discipline

Placeholders may appear more than once in a template (e.g., a shared slug referenced in frontmatter and body). Every substitution MUST be global:

- When using `Edit`, pass `replace_all: true` for every placeholder replacement.
- When using `sed`, use the `g` flag (`s|{{PLACEHOLDER}}|value|g`).

After writing each agent file, verify zero placeholders remain:

```bash
grep -c '{{' {workspace_root}/{slug}/agents/{product-owner,assessor,troubleshooter}.md
```

Every file must report `0`. If any file reports ≥1, halt, run `grep -n '{{' <file>` to list remaining placeholders by line, and fix before continuing. Do **not** ship an agent file with an unfilled placeholder — it will produce confusing behavior at runtime when the agent reads its own system prompt.

**Update scratchpad**: set `Domain agents` to COMPLETED in `## Generation Status`.

---

### Step 3.25: Auto-generate per-workspace stack implementers (hybrid fallback)

For every repo in the workspace config whose `type` does NOT have a plugin-shipped implementer (see the `TYPE_TO_AGENT` table in `{plugin_dir}/skills/deliver/phases/dispatch-rules.md`), generate a workspace-local implementer by filling the generic-implementer template with the repo's actual conventions. This makes `/deliver` work even for stacks the plugin doesn't ship a dedicated agent for (Rails, Phoenix, Laravel, Go/Gin, .NET, Kotlin/Ktor, etc.).

**Selection rule** — iterate `config.repos` and build the generation list:

```
for each repo where config.repos[{repo}].role in ("api-service", "worker", "frontend", "mock-server", "infrastructure"):
  type = config.repos[{repo}].type
  if TYPE_TO_AGENT[type].implementer is present:
    skip  # plugin ships an agent for this type
  else:
    add {type} to the generation list (deduplicate — one agent per distinct type, not per repo)
```

Skip the whole step if the generation list is empty — every type in the workspace already has a plugin agent.

**For each type in the generation list**, dispatch an onboarding agent to fill the template:

**Tool**: `Agent`
**subagent_type**: `general-purpose` (this is context-reading + template-filling, not deep architectural reasoning)
**description**: `"Generate workspace-local implementer for {type} (reading {example_repo_name})"`
**prompt**:

```
MODE: generate workspace-local implementer agent

You are generating a NEW implementer-agent file for the {type} stack, specific to the {workspace_name} workspace. A workspace repo using this stack exists at:

  {example_repo_path}

(Pick any repo of this type if multiple exist — their conventions should match.)

Read these files to understand the house style:
1. {example_repo_path}/CLAUDE.md (and any files it points to)
2. Build config — pyproject.toml / Gemfile / Cargo.toml / go.mod / pom.xml / build.sbt / composer.json / package.json / etc. (whichever exists)
3. 2-3 existing features end-to-end (controllers/handlers + services + tests) so you can name the actual testing framework, migration tool, ORM, DI pattern, routing pattern used here.
4. {workspace_root}/{slug}/context/platform.md — workspace context (architecture, integration patterns)
5. {workspace_root}/{slug}/context/audit-findings.md (if it exists) — real bugs spotted during onboarding, filtered to this repo

Then read the template at:

  {plugin_dir}/templates/agents/generic-implementer.md.template

Fill every placeholder in the template:

- `{{WORKSPACE_SLUG}}` = {workspace_slug}
- `{{WORKSPACE_NAME}}` = {workspace_name}
- `{{STACK_KEY}}` = {type} (the config.repos[*].type value — becomes part of the agent filename)
- `{{STACK_NAME}}` = human-friendly name (e.g., "Ruby on Rails", "Phoenix/Elixir", "Laravel/PHP", "Go/Gin") — pick based on what you saw in the repo
- `{{ORIENT_GUIDANCE}}` = a 3-5 bullet list describing what files the implementer should read to orient itself in this specific stack (e.g., for Rails: "the controller + its service + its model + its RSpec file for a similar feature; config/routes.rb; the migration under db/migrate/ for a similar entity"). Reference REAL file paths observed in this repo.
- `{{IMPLEMENT_GUIDANCE}}` = numbered sub-steps describing the implementation order specific to this stack. Name the REAL commands and file locations (e.g., "a. Generate the migration: `bundle exec rails generate migration ...`  b. Define the model in `app/models/`  c. Add the controller action in `app/controllers/`  d. Register the route in `config/routes.rb`").
- `{{TEST_GUIDANCE}}` = the actual test framework + runner this repo uses. Name the real commands (`bundle exec rspec spec/`, `bundle exec rails test`, `go test ./...`, `./mvnw test`, `npm test`, etc.). Describe what coverage to add (unit + integration/e2e).
- `{{KNOWN_ANTI_PATTERNS}}` = 4-8 bullets of real anti-patterns you observed. Draw from: (a) gotchas visible in CLAUDE.md or the repo's conventions docs, (b) patterns you saw implemented one way consistently (imply the wrong way is an error), (c) audit-findings.md entries for this repo, (d) common stack-specific traps you know from training (Rails strong params, Phoenix Ecto changesets, Laravel Eloquent N+1, Go context cancellation, etc. — but only for stacks where you have high confidence). Each bullet MUST be concrete and actionable.
- `{{COMPLETION_CHECKS}}` = 2-4 additional "you are not done until" lines specific to this stack (e.g., for Rails: "- `bundle exec rubocop` passes  - Migration runs cleanly on a fresh DB"). These supplement the default completion checks already in the template.

Return the COMPLETE filled agent file content — nothing else, no preamble, no commentary. The orchestrator will write your output verbatim to `{workspace_root}/{slug}/agents/{type}-implementer.md`.

Self-check before returning:
- Zero `{{` remaining anywhere in the file (grep your own output)
- The `name:` frontmatter value matches `{workspace_slug}-{type}-implementer` exactly
- Every file path referenced is a real path in {example_repo_path} (not a placeholder)
- Every command referenced is runnable (syntax verified from the build config you read)
```

**On agent return**:
1. Write the returned content to `{workspace_root}/{slug}/agents/{type}-implementer.md`
2. Verify zero `{{` remain: `grep -c '{{' {workspace_root}/{slug}/agents/{type}-implementer.md` must print `0`. If not, surface the offending lines and re-dispatch.
3. Publish to `~/.claude/agents/{workspace_slug}-{type}-implementer.md` (same conflict-check pattern as the workspace product-owner/assessor/troubleshooter publish in Step 3 above — if a file with that name already exists under a different `name:` frontmatter value, stop and ask the user before overwriting).
4. Log one line: `Generated workspace implementer: {workspace_slug}-{type}-implementer (for {repo_list})`.

**Idempotency**: if `{workspace_root}/{slug}/agents/{type}-implementer.md` already exists (re-run or hand-edited), show a diff after regeneration and ask the user to keep/overwrite/merge. Default to KEEP — a hand-edited agent is load-bearing and must not be silently clobbered.

**Parallel dispatch**: if the generation list has 2+ distinct types, dispatch all agents in ONE orchestrator message so they run concurrently. Apply the same transient-failure rules as Step 2.

**Update scratchpad**: add a `Per-workspace stack implementers` row to `## Generation Status` listing each generated agent (or `none needed` if every type had a plugin agent). Set Phase C status unchanged — this step is additive.

---

### Step 3.5: Offer to write a `settings.local.json` for approval-free operation (C1 / C2 / C3)

The `/deliver` pipeline triggers many Edit / Write / Bash calls scoped to paths under `{workspace_root}/{slug}/**` and the repos in `config.repos`. Without pre-allow rules, every one prompts for approval, slowing the run and fragmenting flow.

Offer to write a `settings.local.json` under the workspace directory's `.claude/` folder (not in the repos — that scope is each team's decision) that pre-allows the common patterns this pipeline uses. The file is user-scoped (not committed to any repo), so it's safe to write but ONLY with explicit user consent.

**Path matters:** Claude Code only auto-loads project settings from `<dir>/.claude/settings.local.json`, discovered by walking up from the directory `claude` is launched in. A bare `settings.local.json` at the workspace root is **not** on the settings search path and would silently have no effect. Always write it to `{workspace_root}/{slug}/.claude/settings.local.json`.

Prompt:
```
I can write {workspace_root}/{slug}/.claude/settings.local.json that pre-allows:
  - Edit/Write/Read under {workspace_root}/{slug}/**
  - Edit/Write on published workspace agents (~/.claude/agents/{slug}-*.md)
  - Read/Bash on plugin validator scripts
  - Bash on worktree commands (git worktree list/add/remove)
  - Edit/Write on each config repo: {list config.repos paths}

This removes most approval prompts during /deliver runs. You can edit the file later.

Write it? (yes / no / show-me-first)
```

On `show-me-first`: render the template filled with this workspace's values and show it. Then re-prompt `(yes / no)`.

On `yes`:
1. Load the template at `{plugin_dir}/templates/settings.local.json.template`.
2. Substitute `{{WORKSPACE_SLUG}}`, `{{DATE}}`, `{{PLUGIN_DIR}}`.
3. For `{{REPO_ALLOW_ENTRIES}}`, generate one block per repo in `config.repos`:
   ```json
         "Edit({repo.path}/**)",
         "Write({repo.path}/**)",
         "Read({repo.path}/**)",
         "Bash(cd {repo.path} && git *)",
         "Bash(cd {repo.path} && mvn *)",      // only for spring-boot repos
         "Bash(cd {repo.path} && npm *)",      // only for node-based repos
         "Bash(cd {repo.path} && npx *)",      // only for node-based repos
   ```
   (Skip the `mvn` / `npm` lines per repo type as appropriate — check `config.repos[repo].type`.)
4. Create the `.claude/` directory if needed (`mkdir -p {workspace_root}/{slug}/.claude`) and write the file to `{workspace_root}/{slug}/.claude/settings.local.json`.
5. Suggest to the user:
   > "These allow rules load automatically when you start `claude` with the working directory at (or below) `{workspace_root}/{slug}/` — Claude Code reads `.claude/settings.local.json` from the cwd and its parents. If you run `/deliver` from a different directory (e.g. your repos root), the rules won't apply there; in that case either launch from the workspace dir, or copy the `permissions.allow` entries into the `.claude/settings.local.json` of wherever you do launch `claude`. To pick them up mid-session, run `/permissions` and reload."

On `no`: skip. Note in the Phase D summary: "settings.local.json skipped per user choice. Approval prompts will continue during feature runs."

**Update scratchpad**: add a `Settings file` row to `## Generation Status` — `WRITTEN`, `SKIPPED`, or `EXISTED` (if a file was already present and we chose not to overwrite without extra consent).

---

### Step 4: Collate audit findings

Assemble the **single canonical** `{workspace_root}/{slug}/context/audit-findings.md` by merging **two sources**, deduped by `file:line + description` (this is the only audit-findings file — the architect no longer writes a separate one):

1. **Phase B2.0 repo-discoverer findings** — the `audit_findings[]` arrays in each profile at `{run_dir}/outputs/repo-profiles/{repo}.json` (a broad, fast structured scan). Read each profile and collect its findings.
2. **Phase C Step 2 context-manager findings** — the `## Audit Findings` sections the doc-generation agents returned (deeper, full code reads).

When the same `file:line + description` appears in both, keep one entry. When two findings touch the same `file:line` but describe different problems, keep both. Skip this step entirely only if **both** sources are empty.

**File structure:**

```markdown
# Audit Findings — {workspace.name}

Surfaced during /discover on {date}. Each bullet is a real observation from code reading, not speculation. Verify against current code before acting; the underlying file may have moved or been fixed since onboarding.

## Summary
| Severity | Count |
|---|---|
| critical | N |
| high | N |
| medium | N |
| low | N |

## {repo-name-1}
*Sources: repo-discoverer (Phase B2.0 profile) + context-manager (Phase C Step 2 deep read)*

- [severity] file:line — description (evidence: ...)
- ...

## {repo-name-2}
...
```

**Rules:**
- One H2 section per source repo, holding the **merged + deduped** findings from both passes (B2.0 profile `audit_findings[]` and the Phase C context-manager `## Audit Findings`).
- Sort findings within each section by severity descending (critical first).
- Do NOT editorialize or summarize findings — copy verbatim from the agent response. The agents already committed to the format.
- If any finding has severity `critical`, the final Phase D summary MUST surface it prominently (see phase-d-verification.md Step 6).

**Cross-reference from platform.md:** append the following paragraph to the **Known Constraints** section of `{workspace_root}/{slug}/context/platform.md` (or create the section if missing):

> **Onboarding audit findings** (N critical / N high / N medium / N low): see `{workspace_root}/{slug}/context/audit-findings.md` for the full list with file:line references. Review before touching the affected code paths.

If zero findings were reported across the whole phase, write no file and add no cross-reference — silence is a valid signal too.

**Update scratchpad**: add an `Audit findings` row to `## Generation Status`:
- `{N} findings across {M} repos` if any, path to the file
- `none reported` if the phase surfaced no issues
- Set Phase C status to COMPLETED. Set Current Phase to "D. Verification".

---
