## Phase C: Generation

Generate all workspace-layer files. This phase creates the config, AGENTS.md files, domain agents, and optional agent-context docs.

**Incremental mode** (`discover_mode == incremental`): scope this phase to `new_repos`. Specifically: (1) config.json was already MERGED in B2 — Step 1 just re-validates; (2) Step 2 generates AGENTS.md + agent-context for the new repos only — existing repos' docs are never touched; (3) **skip domain-agent generation** (Step 3 and the implementer-agent publish) — the workspace `agents/` and published `~/.claude/agents/{slug}-*` already exist and don't change when repos are added; if a new repo's stack has no matching plugin implementer/reviewer, note it for the user instead of generating one; (4) Step 4 appends the new repos' audit findings to the existing `context/audit-findings.md`. Full spec: `{plugin_dir}/rules/incremental-discovery.md` § "Phase C". The steps below otherwise run as written, looping over the new repos.

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
> 5. **Documented value that contradicts code** (AGENTS.md / README says X, code shows Y).
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

### Step 2: Generate AGENTS.md + agent-context per repo (merged flow)

**Replaces the former Step 2 (AGENTS.md generator) + Step 4 (agent-context generator).** Both artifacts are now produced by a single `context-manager` dispatch per repo — the deep read happens once, agent-context is written first, AGENTS.md is written as a thin index that references agent-context. See `GENERALIZE-PLAN.md` Section 13 for the full rationale.

**Resume-safe**: for each repo, check the scratchpad's Generation Status. If a repo's AGENTS.md row is already COMPLETED, skip it.

#### Per-repo gate — ask the user which generation mode to use

For each repo whose AGENTS.md is missing (or where the user opts to regenerate), present:

```
Repo "{repo-name}" ({type}, {role}) — how should agent docs be structured?

  (a) Full — agent-context/ + AGENTS.md index (recommended)
      ℹ️ Multi-file deep dive under agent-context/; AGENTS.md becomes a
      thin index. Best for non-trivial repos — one Read gets you the map,
      deeper Reads only when you need the detail.

  (b) AGENTS.md only — self-contained, no subdirectory
      ℹ️ Lighter. Right for small/simple repos that don't warrant
      multiple context files. Can be upgraded to (a) later.

  (c) Manual — you run Claude Code's /init yourself
      ℹ️ cd {path} && claude /init in a separate terminal.
      Type "done" here when finished. AGENTS.md only — no agent-context.
```

**Default**: (a) Full. Complexity signals (>200 source files, >8 endpoints, component library detected, multiple modules) raise the recommendation but don't skip the prompt. If an existing non-empty `agent-context/` is present, the default stays (a) but context-manager will use refresh semantics to merge rather than overwrite.

**If AGENTS.md already exists** (but user chose to regenerate): show a diff after generation and confirm before overwriting. Never silently overwrite a hand-curated AGENTS.md.

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

Read the existing context file if present — prefer {repo_path}/AGENTS.md, else {repo_path}/CLAUDE.md (a legacy workspace) — and any existing agent-context/ directory (non-empty → use refresh semantics for that directory; do not destroy-and-rewrite). If only a legacy CLAUDE.md exists, migrate: write its content to AGENTS.md and (under Claude Code) replace CLAUDE.md with a one-line `@AGENTS.md` shim — show a diff, never silently clobber hand edits. Then follow the `full` mode instructions in your system prompt.

Template dispatch (per your system prompt):
- role = api-service OR worker → use templates/agent-context-backend/ + templates/repo-AGENTS-backend.md.template
- role = frontend             → use templates/agent-context-frontend/ + templates/repo-AGENTS-frontend.md.template
- role = infrastructure       → use templates/agent-context-infra/ + templates/repo-AGENTS-infra.md.template (top-level files only — no domains/ or integrations/ subfolders)
- role = mock-server / contract / other → downgrade to claude-only mode (use templates/repo-AGENTS.md.template)

Output order:
1. agent-context/ first — fill every *.md.template in the chosen bundle (AGENT_INDEX, business-context, architecture, conventions, plus role-specific singletons). Strip the <!-- AGENT INSTRUCTIONS --> blocks. Preserve <!-- agent-updatable --> / <!-- human-owned --> markers verbatim.
2. For each bounded context (backend) or feature module (frontend) that warrants its own file (see triggers in the bundle's domains/_template.md or features/_template.md), copy the template, rename, and fill.
3. For each external system the repo integrates with (backend) or backend service the repo consumes (frontend), copy the matching _template.md and fill.
4. AGENTS.md second, using the role-specific template, referencing agent-context.
5. Context shim: run `node {plugin_dir}/scripts/workspace-root.js --context-shim` — if it prints a filename (`CLAUDE.md` under Claude Code; nothing under Cursor/others), write that file containing exactly one line: `@AGENTS.md`. This keeps Claude Code's native loading pointed at the one canonical AGENTS.md. Never duplicate content into the shim.

Validate AGENTS.md with: node {plugin_dir}/scripts/validate-claude-md.js {repo_path}/AGENTS.md
On exit 1, fix the flagged issues and re-validate. On exit 2, record warnings but continue.

Audit Findings: apply the contract from the top of Phase C. End your response with a `## Audit Findings` section if you observed qualifying issues. Put findings in your REPLY, never in the generated files.
```

For (b):
```
Mode: claude-only
Repo: {repo_path}
Repo type: {type}
Repo role: {role}

Read the existing context file if present — prefer {repo_path}/AGENTS.md, else {repo_path}/CLAUDE.md (legacy). Then follow the `claude-only` mode instructions in your system prompt to produce a self-contained AGENTS.md at {repo_path}/AGENTS.md, using the template at {plugin_dir}/templates/repo-AGENTS.md.template. Include the `<!-- claude-only-mode -->` sentinel at the top so the validator skips the mandatory-bullet check. Then write the context shim if `node {plugin_dir}/scripts/workspace-root.js --context-shim` prints one (`CLAUDE.md` = one line `@AGENTS.md`, under Claude Code only).

Validate with: node {plugin_dir}/scripts/validate-claude-md.js {repo_path}/AGENTS.md
On exit 1, fix the flagged issues and re-validate. On exit 2, record warnings but continue.

Audit Findings: apply the contract from the top of Phase C. End your response with a `## Audit Findings` section if you observed qualifying issues. Put findings in your REPLY, never in the generated files.
```

After the agent returns: extract any `## Audit Findings` section from its response, keyed by repo name, for later collation in Step 4. Do NOT write findings into AGENTS.md or agent-context — they belong in the workspace-level audit doc.

**Validator is mandatory**: if the agent did not run the validator, run it from the orchestrator now. If exit code is 1, dispatch a fix-round to the same context-manager with the validator output as `fix_list` and re-validate. Only mark the repo COMPLETED when the validator exits 0 or 2.

#### Dispatch — option (c) manual

Print instructions and wait:
```
Run this in a separate terminal:
  cd {repo_path}
  claude /init

Type "done" here when you've finished.
```

Wait for "done". Then verify `{repo_path}/AGENTS.md` exists and run the validator against it. If the validator fails, surface the errors and ask the user to fix them before continuing — do not auto-fix a human-written AGENTS.md.

#### Batch behavior (default: all-auto-parallel when ≥2 repos need docs)

If 2+ repos need generation, default to parallel dispatch of (a) for every repo (the recommended mode). Tell the user what's happening, with a clear opt-out:

```
{N} repos need docs. Dispatching all in (a) Full mode in parallel (default for batches ≥2).
Reply with `one-by-one` to switch to interactive per-repo gate,
or `all-b` to use (b) AGENTS.md-only for all of them.
Otherwise I'll proceed with the default on the next turn.
```

For N=1, use the standard (a)/(b)/(c) interactive prompt.

Parallel dispatch: send ALL Agent tool calls in a single orchestrator message (one tool call per repo) so they run concurrently. On any per-agent failure, apply the **Transient failure handling** rules — retry only the failed call, let the rest finish.

**On transient failure** (529/503/429/network timeout): apply the rules at the top of this phase. If the retry also fails, record the repo under "deferred" in the scratchpad and continue — the user can re-run `/discover --resume` later.

**Update scratchpad**: after each repo finishes, set its AGENTS.md row in `## Generation Status` to COMPLETED (and its agent-context row if mode was (a)).

**Seed the context-refresh baseline** (mode (a) Full repos only — those that got an `agent-context/`). The docs were just generated *from* the current code, so they are correct as of the repo's current `HEAD`. Stamp that so the FIRST `/context-refresh` on this workspace is incremental instead of a full re-read (and so the baseline ships to the whole team when the docs are committed):

```bash
node {plugin_dir}/scripts/refresh-state.js seed --repo={repo_path} --repo-key={repo-key}
```

This writes a committed `agent-context/.refresh-state.json` (baseline `{head_sha, branch, mode:full, by:discover}`). Skip for claude-only repos — the script no-ops when there's no `agent-context/`. The file commits alongside the generated docs (it's inside `agent-context/`), so do NOT add it to `.gitignore`. See `docs/design/refresh-state.md`.

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
| `{{TEMPLATE_VERSION}}` | The plugin version these agents were generated from — `node -e "console.log(require('{plugin_dir}/.claude-plugin/plugin.json').version)"`. Stamped into each agent's `<!-- pipecrew-template-version: … -->` comment so Phase D (and later runs) can detect when a workspace's generated agents predate the current plugin and need regenerating. |
| `{workspace_root}` | Absolute workspace root — run `node {plugin_dir}/scripts/workspace-root.js --get` and substitute the value verbatim, normalized to forward slashes (e.g. `C:/ABVI/pipecrew-workspaces`). **This is a single-brace *runtime* token and it MUST be substituted now, at generation time.** A dispatched agent reads its own system prompt verbatim — the orchestrator's runtime token substitution never touches a sub-agent's baked-in prompt — so a leftover `{workspace_root}` is an unresolvable path at runtime: the agent guesses (e.g. `~/.claude/{slug}-context/...`) and reads the wrong file or nothing. |
| `{plugin_dir}` | Absolute path to this plugin directory (normalized to forward slashes). Substitute verbatim so `node {plugin_dir}/scripts/...` and doc references baked into the agent (e.g. the troubleshooter's `extract-block.js` call, the product-owner's block-schema references) resolve at runtime. Same single-brace runtime-token rule as `{workspace_root}`. |
| `{{QUALITY_STANDARDS}}` | **Assessor only.** Default quality bar (can be customized later). Include: "Backend: all spec endpoints implemented, DTOs match, tests cover happy path + main error. Frontend: all FR- requirements implemented, types match spec, i18n both languages. Mock: all endpoints covered, shapes match spec." Do **not** inject into the troubleshooter — it is a read-only incident-triage agent, not a quality gate; its template no longer carries this placeholder. |

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

The workspace-local agent files above are the canonical copies — they're version-controlled alongside workspace config and can be hand-edited. But the `Agent` tool only resolves `subagent_type` against the **user-level agents directory** (and the project-level `.claude/agents/` / `.cursor/agents/`). That user-level directory is harness-specific — `~/.claude/agents/` under Claude Code, `~/.cursor/agents/` under Cursor — so resolve it once instead of hardcoding, or `dal-assessor` (referenced by `phase-6-assess.md`) won't resolve:

```bash
AGENTS_DIR=$(node {plugin_dir}/scripts/workspace-root.js --agents-dir)
mkdir -p "$AGENTS_DIR"
```

After writing the three workspace-local files, also publish them to `$AGENTS_DIR` with the slug-prefixed names that downstream phase files already use.

For each of (`product-owner`, `assessor`, `troubleshooter`):

1. **Conflict check (B2)**: before copying, check whether `$AGENTS_DIR/{slug}-{role}.md` already exists.
   - If it does **and** the `name:` frontmatter value already matches `{slug}-{role}`, it's our own file from a prior onboarding — overwrite silently.
   - If it exists with a **different** `name:` value, stop and ask the user:
     ```
     $AGENTS_DIR/{slug}-{role}.md already exists with name: '{other-name}'.
     Overwrite? (yes / no / rename-existing-to-{slug}-{role}-backup.md)
     ```
     Act on the user's answer. Do NOT silently clobber.
2. Copy the workspace-local file to the user-level path:
   ```bash
   cp {workspace_root}/{slug}/agents/{role}.md "$AGENTS_DIR/{slug}-{role}.md"
   ```

After all three publish, verify the harness can see them:
```bash
ls "$AGENTS_DIR"/{slug}-{product-owner,assessor,troubleshooter}.md
```

Print a one-liner to the user: `Workspace agents published: {slug}-product-owner, {slug}-assessor, {slug}-troubleshooter — downstream pipeline phases will dispatch them by name. (UX consultant uses the base pipecrew:ux-consultant.)`

#### Placeholder substitution discipline

Placeholders may appear more than once in a template (e.g., a shared slug referenced in frontmatter and body). Every substitution MUST be global:

- When using `Edit`, pass `replace_all: true` for every placeholder replacement.
- When using `sed`, use the `g` flag (`s|{{PLACEHOLDER}}|value|g`).
- The single-brace **runtime tokens** `{workspace_root}` and `{plugin_dir}` must be substituted globally too (their absolute values from the table above) — they are easy to miss because they don't use the `{{…}}` form, and a leftover one is a silent runtime failure, not a visible placeholder.

After writing each agent file, verify no placeholders **and no unresolved runtime tokens** remain:

```bash
grep -cE '\{\{|\{(workspace_root|plugin_dir|slug)\}' {workspace_root}/{slug}/agents/{product-owner,assessor,troubleshooter}.md
```

Every file must report `0`. If any file reports ≥1, halt, run `grep -nE '\{\{|\{(workspace_root|plugin_dir|slug)\}' <file>` to list the remaining placeholders/tokens by line, and fix before continuing. Do **not** ship an agent file with an unfilled `{{placeholder}}` or an unresolved single-brace `{workspace_root}` / `{plugin_dir}` / `{slug}` token — both produce confusing or broken behavior at runtime when the agent reads its own system prompt.

**Update scratchpad**: set `Domain agents` to COMPLETED in `## Generation Status`.

---

### Step 3.25: Custom-agent gate for unsupported stacks (hybrid fallback)

For every repo in the workspace config whose `type` has no plugin-shipped implementer (see the `TYPE_TO_AGENT` table in `{plugin_dir}/skills/deliver/phases/dispatch-rules.md`), this step either generates a workspace-local implementer or records the user's chosen resolution, so `/deliver` can work even for stacks the plugin does not ship a dedicated agent for (Rails, Phoenix, Laravel, Go/Gin, .NET, Kotlin/Ktor, Claude Code plugins, schema repos, etc.).

> **`--auto-agents` flag**: if this flag was passed at invocation, skip the interactive gate entirely and auto-generate implementers for every unsupported type (same as choosing **Generate** for all). No prompts are shown. Reviewer generation is never auto-triggered — it requires an explicit `--auto-reviewers` flag (or a separate per-type opt-in prompt at the end of the auto pass). Jump directly to the **Dispatch** block below.

**Selection rule** — iterate `config.repos` and build the unsupported-types map (deduplicated by distinct `type`):

```
for each repo in config.repos (all roles — including "other" and "contract"):
  type = config.repos[{repo}].type
  if TYPE_TO_AGENT[type].implementer is present (plugin ships an agent):
    skip  # plugin already covers this type; no gate needed
  else:
    add {type} → {example_repo_name, example_repo_path} to unsupported_types map
    (keep only the first repo seen for each type as the example; dedup)
```

**Incremental mode** (`discover_mode == incremental`): restrict the loop to `new_repos` only — do not re-process types already covered by the existing workspace `agents/`. If a new repo introduces a type that already has a `~/.claude/agents/{slug}-{type}-implementer.md` from a prior run, treat it as already-generated (idempotency rule below applies).

**EC-1**: If `unsupported_types` is empty → every type in the workspace already has a plugin agent. Skip this step entirely — no gate shown.

---

#### Interactive gate (default — no `--auto-agents`)

Present one consolidated gate block listing all unsupported types, then collect a per-type decision:

```
Custom-agent gate — {N} unsupported type(s) found:

The following repo types have no plugin-shipped implementer.
For each type, choose an action:

  Type: {type-1}
  Example repo: {example_repo_name_1} ({example_repo_path_1})
  Role: {role_1}

  Type: {type-2}
  Example repo: {example_repo_name_2} ({example_repo_path_2})
  Role: {role_2}

  ... (one block per type)

For EACH type, reply with one of:
  (a) Generate  — auto-derive conventions from the repo's CLAUDE.md + build config
                  and generate a workspace-local implementer [recommended / default]
  (b) Hand-write — skip generation; note it in the Phase D report so /deliver's
                   fallback chain knows the agent must be authored later
  (c) Map        — use an existing agent: provide the subagent_type name to map to
                   (e.g., "pipecrew:spring-boot-implementer" or a custom agent you
                   already have). The mapping is recorded so /deliver can resolve it.
  (d) Skip       — no action; /deliver will use the generic fallback for this type

Reply format (one line per type):
  {type-1}: a
  {type-2}: c dal-rails-implementer
  {type-3}: b
  {type-4}: d
```

Wait for the user's reply. Parse each line as `{type}: {choice} [{extra}]`.

**EC-2 — Map-to-existing validation**: for any type where the user chose (c), resolve the named `subagent_type`:
- Check whether `~/.claude/agents/{named-agent}.md` exists, OR the name is a known `pipecrew:{agent}` canonical name, OR `.claude/agents/{named-agent}.md` exists in any repo in the config.
- If it resolves → record the mapping (see below). Continue.
- If it does NOT resolve → warn the user:
  ```
  Warning: '{named-agent}' does not resolve to a known agent file.
  Choose: re-enter a valid name | fall back to (a) Generate | skip (d)
  ```
  Re-prompt for that type only. Never record an unresolvable mapping.

**Recording decisions in the scratchpad** (for `/deliver`'s resolution chain):

After collecting all decisions, record them in the scratchpad under a new `## Custom-Agent Decisions` block:

```markdown
## Custom-Agent Decisions (Phase C Step 3.25)
| Type | Decision | Detail |
|------|----------|--------|
| {type} | generate | generated: {workspace_slug}-{type}-implementer |
| {type} | hand-write | agent not generated; /deliver will need a hand-authored agent |
| {type} | map | mapped to: {named-subagent_type} |
| {type} | skip | /deliver will use generic fallback |
```

For (c) **map** decisions, also write a `{workspace_root}/{slug}/agents/type-map.json` sidecar (create or merge):

```json
{
  "{type}": "{named-subagent_type}",
  ...
}
```

`/deliver`'s resolution chain reads this file at fallback-chain step 1 when `~/.claude/agents/{slug}-{type}-implementer.md` is absent — it picks up the mapped agent name before falling through to the generic fallback. (See `{plugin_dir}/skills/deliver/phases/dispatch-rules.md` § "Implementer resolution".)

Only proceed to **Dispatch** for types where the decision was (a) Generate. Types with (b)/(c)/(d) are fully resolved — no dispatch needed for them.

---

#### Dispatch — generate implementer(s)

For each type decided as (a) Generate:

**Tool**: `Agent`
**subagent_type**: `general-purpose` (context-reading + template-filling, not deep architectural reasoning)
**description**: `"Generate workspace-local implementer for {type} (reading {example_repo_name})"`
**prompt**:

```
MODE: generate workspace-local implementer agent

You are generating a NEW implementer-agent file for the {type} stack, specific to
the {workspace_name} workspace. A workspace repo using this stack exists at:

  {example_repo_path}

(Pick any repo of this type if multiple exist — their conventions should match.)

Read these files to understand the house style — treat them as authoritative:
1. {example_repo_path}/AGENTS.md (or legacy CLAUDE.md if that's all the repo has yet) —
   this is the PRIMARY source for ORIENT / IMPLEMENT / TEST guidance and anti-patterns.
   If it exists, derive the placeholders from it first; supplement with observations
   from the code only where it is silent. If neither exists, note this and rely solely
   on code observations (warn that quality may be lower; recommend the user run
   /context-refresh after hand-writing an AGENTS.md).
2. Files AGENTS.md points to (e.g., agent-context/*.md, docs/conventions.md, CONTRIBUTING.md)
3. Build config — pyproject.toml / Gemfile / Cargo.toml / go.mod / pom.xml / build.sbt
   / composer.json / package.json / etc. (whichever exists) — to confirm real build
   commands
4. 2-3 existing features end-to-end (controllers/handlers + services + tests) so you
   can name the actual testing framework, migration tool, ORM, DI pattern, routing
   pattern used here
5. {workspace_root}/{slug}/context/platform.md — workspace context (architecture,
   integration patterns)
6. {workspace_root}/{slug}/context/audit-findings.md (if it exists) — real bugs
   spotted during onboarding, filtered to this repo

IMPORTANT for non-code repos (role: other, role: contract, markdown-based plugins,
schema repos, Claude Code plugin repos): do NOT assume a buildable stack. There may
be no migrations, no ORM, no controllers. Adapt the guidance to what this repo
actually is — e.g., for a markdown plugin repo: orient = read AGENTS.md + skills/ +
eval/; implement = edit markdown + scripts; test = node eval/run.js. Never invent
a language or framework that isn't present.

Then read the template at:

  {plugin_dir}/templates/agents/generic-implementer.md.template

Fill every placeholder in the template:

- `{{WORKSPACE_SLUG}}` = {workspace_slug}
- `{{WORKSPACE_NAME}}` = {workspace_name}
- `{{STACK_KEY}}` = {type} (the config.repos[*].type value — becomes part of the
  agent filename)
- `{{STACK_NAME}}` = human-friendly name (e.g., "Ruby on Rails", "Phoenix/Elixir",
  "Laravel/PHP", "Go/Gin", "Claude Code Plugin", "JSON Schema repo") — pick based
  on what you saw in the repo
- `{{ORIENT_GUIDANCE}}` = a 3-5 bullet list describing what files the implementer
  should read to orient itself in this specific stack. If AGENTS.md exists, derive
  these from its ORIENT/context section. Reference REAL file paths observed in this
  repo — not generic placeholders.
- `{{IMPLEMENT_GUIDANCE}}` = numbered sub-steps describing the implementation order
  specific to this stack. Name REAL commands and file locations. If AGENTS.md has
  an implementation guide, adapt it. For non-buildable repos (plugin, schema),
  describe the edit-validate-test loop specific to this repo.
- `{{TEST_GUIDANCE}}` = the actual test framework + runner this repo uses. Name the
  real commands. For repos with no test runner, describe the manual validation steps
  (e.g., "run node eval/run.js and confirm exit 0").
- `{{KNOWN_ANTI_PATTERNS}}` = 4-8 bullets of real anti-patterns. Draw from:
  (a) anti-patterns listed in AGENTS.md or repo conventions docs (highest priority),
  (b) patterns you saw consistently in the code (implying the wrong way is an error),
  (c) audit-findings.md entries for this repo,
  (d) common stack-specific traps from training — only for stacks where you have high
  confidence. Each bullet MUST be concrete and actionable.
- `{{COMPLETION_CHECKS}}` = 2-4 additional "you are not done until" lines specific
  to this stack (e.g., for Rails: "- `bundle exec rubocop` passes  - Migration runs
  cleanly on a fresh DB"). These supplement the default completion checks in the
  template. For repos with no compile step, include the eval/lint check instead.

Return the COMPLETE filled agent file content — nothing else, no preamble, no
commentary. The orchestrator will write your output verbatim to
`{workspace_root}/{slug}/agents/{type}-implementer.md`.

Self-check before returning:
- Zero `{{` remaining anywhere in the file (grep your own output)
- The `name:` frontmatter value matches `{workspace_slug}-{type}-implementer` exactly
- Every file path referenced is a real path in {example_repo_path} (not a placeholder)
- Every command referenced is runnable (syntax verified from the build config you read)
- For a CLAUDE.md-based repo: ORIENT/IMPLEMENT/TEST/anti-patterns all trace back to
  what CLAUDE.md says, not to generic assumptions
```

**On agent return**:
1. Write the returned content to `{workspace_root}/{slug}/agents/{type}-implementer.md`
2. Verify zero `{{` remain: `grep -c '{{' {workspace_root}/{slug}/agents/{type}-implementer.md` must print `0`. If not, surface the offending lines and re-dispatch.
3. Publish to the harness user-level agents dir as `{workspace_slug}-{type}-implementer.md` — use `$AGENTS_DIR` from Step 3, or re-resolve it with `node {plugin_dir}/scripts/workspace-root.js --agents-dir` (`~/.claude/agents/` under Claude Code, `~/.cursor/agents/` under Cursor). Same conflict-check pattern as the workspace product-owner/assessor/troubleshooter publish in Step 3 above — if a file with that name already exists under a different `name:` frontmatter value, stop and ask the user before overwriting.
4. Log one line: `Generated workspace implementer: {workspace_slug}-{type}-implementer (for {repo_list})`.

**EC-4 — no CLAUDE.md warning**: if the example repo has no `CLAUDE.md`, include a warning in the log and in the Phase D summary:
```
Warning: {type} repo ({example_repo_name}) has no CLAUDE.md — generated agent quality
may be lower. Recommend running /context-refresh after hand-writing a CLAUDE.md for
that repo, then re-generating: /discover --resume --workspace={slug} (choose
"overwrite" at the idempotency gate).
```

**Idempotency**: if `{workspace_root}/{slug}/agents/{type}-implementer.md` already exists (re-run or hand-edited), show a diff after regeneration and ask the user to keep/overwrite/merge. Default to KEEP — a hand-edited agent is load-bearing and must not be silently clobbered.

**Parallel dispatch**: if 2+ types are being generated, dispatch all agents in ONE orchestrator message so they run concurrently. Apply the same transient-failure rules as Step 2.

---

#### FR-4: Optional paired reviewer

After ALL implementers have been generated (skip this offer in `--auto-agents` mode — reviewers require explicit opt-in via `--auto-reviewers`), offer to generate a paired workspace-local reviewer for each type that was just generated:

```
Paired reviewer offer — {N} implementer(s) just generated.

Generating a paired reviewer for each type lets /deliver's Phase 5.5 dispatch
a workspace-local reviewer instead of falling back to the generic one.

Generate paired reviewers?
  (a) Yes — generate for all types just generated
  (b) Select — I'll choose per type
  (c) No — skip reviewer generation
```

For choice (a): generate reviewers for every newly-generated implementer type.
For choice (b): present a per-type prompt and collect yes/no for each.
For choice (c): skip entirely.

For each type confirmed for reviewer generation:

**Tool**: `Agent`
**subagent_type**: `general-purpose`
**description**: `"Generate workspace-local reviewer for {type} (reading {example_repo_name})"`
**prompt**:

```
MODE: generate workspace-local reviewer agent

You are generating a NEW reviewer-agent file for the {type} stack, specific to the
{workspace_name} workspace. A workspace repo using this stack exists at:

  {example_repo_path}

Apply the same ORIENT step as for the implementer (read CLAUDE.md, files it points
to, build config, 2-3 existing features) to understand what "correct" looks like in
this repo.

Then read the template at:

  {plugin_dir}/templates/agents/generic-reviewer.md.template

Fill every placeholder in the template (same ORIENT_GUIDANCE, KNOWN_ANTI_PATTERNS,
COMPLETION_CHECKS logic as for the implementer; adapt for review context):

- `{{WORKSPACE_SLUG}}` = {workspace_slug}
- `{{WORKSPACE_NAME}}` = {workspace_name}
- `{{STACK_KEY}}` = {type}
- `{{STACK_NAME}}` = same human-friendly name as the paired implementer
- `{{ORIENT_GUIDANCE}}` = same orient steps as the implementer (reading the same
  real file paths); reviewer needs to understand the codebase to judge correctness
- `{{REVIEW_GUIDANCE}}` = numbered checklist of what to look for when reviewing
  a diff for this stack. Cover: (a) does every FR/EC have an enforcement point?
  (b) stack-specific correctness checks (e.g., for Rails: are strong params used?
  are all DB queries scoped? are specs in the right directory?); (c) test coverage
  adequacy; (d) house-style adherence as visible from CLAUDE.md conventions
- `{{KNOWN_ANTI_PATTERNS}}` = same as implementer — reviewers need to know what
  mistakes to flag
- `{{COMPLETION_CHECKS}}` = stack-specific "not done until" lines for a reviewer
  (e.g., "every finding has a file:line reference", "verdict is stated clearly")

Return the COMPLETE filled agent file content — nothing else, no preamble.
Self-check: zero `{{` remaining; `name:` matches `{workspace_slug}-{type}-reviewer`.
```

**On agent return**:
1. Write to `{workspace_root}/{slug}/agents/{type}-reviewer.md`
2. Verify zero `{{` remain.
3. Publish to `~/.claude/agents/{workspace_slug}-{type}-reviewer.md` (same conflict-check).
4. Log: `Generated workspace reviewer: {workspace_slug}-{type}-reviewer`.

---

**Update scratchpad**: add a `Per-workspace stack agents` row to `## Generation Status` listing each generated implementer and reviewer, each mapped type, and each hand-write / skip decision. Example:

```
| Per-workspace stack agents | COMPLETED | rails: generated implementer + reviewer; phoenix: mapped → pipecrew:nestjs-implementer; laravel: hand-write (noted in report); other-type: skipped |
```

Set Phase C status unchanged — this step is additive.

---

### Step 3.5: Offer to write `settings.local.json` files for approval-free operation (C1 / C2 / C3)

Approval prompts come from two distinct contexts, so this step offers **two** settings files (both user-scoped, git-ignored, written only with explicit consent):

- **Part A — workspace-dir settings** (for `/deliver` runs launched from the workspace dir): pre-allows the Edit / Write / Bash patterns the pipeline uses under `{workspace_root}/{slug}/**`.
- **Part B — repo-scoped settings** (for interactive sessions launched from a repo): grants `additionalDirectories` + a safe command allow-list at the repos' common parent, so cross-repo edits and routine safe commands stop prompting no matter which repo you launch from.

Offer both. Part A's file only loads when `claude` is launched from the workspace dir; most users launch from a repo, which is exactly what Part B covers — so Part B is usually the one that removes the day-to-day friction.

#### Part A — workspace-dir settings (for /deliver from the workspace dir)

The `/deliver` pipeline triggers many Edit / Write / Bash calls scoped to paths under `{workspace_root}/{slug}/**` and the repos in `config.repos`. Without pre-allow rules, every one prompts for approval, slowing the run and fragmenting flow.

Offer to write a `settings.local.json` under the workspace directory's `.claude/` folder that pre-allows the common patterns this pipeline uses. The file is user-scoped (not committed to any repo), so it's safe to write but ONLY with explicit user consent.

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

On `no`: skip. Note in the Phase D summary: "workspace-dir settings.local.json skipped per user choice. Approval prompts will continue during feature runs launched from the workspace dir."

#### Part B — repo-scoped settings (for interactive work in the repos)

When the user works **interactively** in a repo (editing, reviewing, committing, running tests — not a `/deliver` run), two things prompt repeatedly: (1) edits/commands in a *sibling* repo or worktree (outside the launch cwd's trusted root), and (2) routine safe commands (read-only git, `git add`/`commit`, build/test). The Part A file does not help here because it only loads from the workspace dir, and it grants no `additionalDirectories`.

`scripts/setup-workspace-permissions.js` closes this gap deterministically: it reads `config.repos`, computes the repos' common parent directory(ies), and writes/merges a `.claude/settings.local.json` there granting:
- `additionalDirectories` = every repo parent + the workspace dir (so editing any repo from inside another no longer prompts), and
- a **safe-only** allow-list (Edit/Write, read-only + local-only git, build/test/read commands). Outward-facing / destructive commands (`git push`, `reset --hard`, `clean`, `rm`, deploys, `docker push`) are deliberately omitted, so they keep prompting.

Because Claude Code walks up from the launch cwd to discover settings, a single file at the repos' shared parent loads for **every** repo and git worktree beneath it. The script MERGES (union, order-stable) and never clobbers a hand-curated file.

Prompt:
```
I can also reduce prompts for interactive work in your repos. I'll write/merge a
.claude/settings.local.json at your repos' common parent that:
  - trusts all workspace repos + the workspace dir (additionalDirectories), so
    cross-repo edits don't prompt
  - allows safe commands only (file edits, read-only & local git, build/test)
  - leaves push / reset --hard / rm / deploys prompting

Preview first? (yes / no / show-me-first)
```

On `show-me-first`: run the script in preview mode and show the output, then re-prompt `(yes / no)`:
```bash
node {plugin_dir}/scripts/setup-workspace-permissions.js --config={workspace_root}/{slug}/config.json --dry-run
```

On `yes`: run it for real:
```bash
node {plugin_dir}/scripts/setup-workspace-permissions.js --config={workspace_root}/{slug}/config.json
```
Then tell the user: "Restart `claude` (or run `/permissions`) in any repo to load the new rules. Edit the file(s) it reports to tighten or loosen the allow-list."

On `no`: skip. Note it in the Phase D summary.

**Update scratchpad**: add a `Settings files` row to `## Generation Status` capturing both parts — e.g. `Part A: WRITTEN / SKIPPED / EXISTED · Part B: WRITTEN(<file>) / SKIPPED`.

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
