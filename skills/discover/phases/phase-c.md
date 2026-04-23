## Phase C: Generation

Generate all workspace-layer files. This phase creates the config, CLAUDE.md files, domain agents, and optional agent-context docs.

---

### Transient failure handling (applies to every Agent dispatch in this phase)

Apply the shared retry rules at `{plugin_dir}/docs/transient-failures.md`. Every retry and deferred outcome is also recorded as `retry` / `agent_end` events in `checkpoints.jsonl` per `docs/observability.md`. In the scratchpad, annotate `## Phase Status` notes with any deferrals so `/discover --resume` can pick them up.

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

### Step 1: Generate workspace config

Build `{workspace_root}/{slug}/config.json` from the discovered repos + domain answers:

```js
{
  "workspace": {
    "name": "{from B1 answer 1}",
    "slug": "{derived slug}",
    "pipeline_dir": "{workspace_root}/{slug}/pipeline",
    "primary_language": "{from B1 answer 4}"
  },
  "repos": {
    // one entry per confirmed repo from Phase A
    "{repo-short-name}": {
      "path": "{absolute path}",
      "type": "{detected type}",
      "role": "{detected role}",
      "description": "{from CLAUDE.md or Phase A detection}",
      "spec_file": "{if api-service, the discovered spec path}",
      "spec_copies": { /* if frontend/mock, map service→relative-path */ }
    }
  },
  "services": {
    // one entry per api-service repo
    "{service-short-name}": {
      "repo": "{repo key}",
      "spec_file": "{relative spec path}",
      "description": "{from architect's service map}"
    }
  },
  "domain": {
    "name": "{from B1}",
    "primary_entities": [/* from architect's entity list */],
    "user_roles": [/* from B1 */],
    "auth_type": "{from architect's discovery}",
    "i18n_languages": [/* from B1 */],
    "rtl_support": /* from B1 */,
    "domain_notes": "{from B1}"
  }
}
```

#### Probing `spec_copies` for frontend and mock-server repos

Frontend and mock-server repos often carry their own copies of the backend OpenAPI specs (for type generation / mock responses). The path convention varies per project — do NOT guess. Probe by filename before recording in config:

For each api-service's `spec_file` (from Phase A), compute the basename and search each frontend + mock-server repo for it:

```bash
spec_basename=$(basename "{api-service.spec_file}")
find {frontend_or_mock_path} -type f -name "$spec_basename" \
  -not -path "*/node_modules/*" -not -path "*/dist/*" \
  -not -path "*/.git/*" | head -1
```

If a match is found, record the path (relative to the repo root) under `repos.{frontend_or_mock}.spec_copies.{service_name}`. If no match is found, **omit the entry** — do not fabricate a plausible path. The validator will emit a warning if any recorded path is wrong, so an empty map is strictly better than guessed paths.

Also probe with any alternate filenames (e.g., a typo'd spec — ABVI has `user-managment-api-specs.yaml` with a missing `e`). Match by basename as declared in the api-service, not by a cleaned-up name.

Write the file. Run the validator:

```bash
node {plugin_dir}/scripts/validate-config.js {workspace_root}/{slug}/config.json
```

Expect **0 warnings** after the probing step. If validation emits path-not-found warnings for `spec_copies`, the probe missed something — do not ignore; re-run the probe with a wider search (e.g., increase maxdepth, include additional exclude-dir patterns) and fix the paths in config before continuing.

If validation fails with errors, fix and retry. Common errors: repo path typo, missing `type` or `role`.

**Update scratchpad**: set `Workspace config` to COMPLETED in `## Generation Status`.

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

Read {repo_path}/CLAUDE.md if it exists, and any existing agent-context/ directory (non-empty → use refresh semantics for that directory; do not destroy-and-rewrite). Then follow the `full` mode instructions in your system prompt to produce:
1. agent-context/ first (AGENT_INDEX.md + architecture.md + conventions.md + api-conventions.md if api-service, plus common/ topic files as complexity warrants)
2. CLAUDE.md second, using the template at {plugin_dir}/templates/repo-CLAUDE.md.template, referencing agent-context

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
- `{plugin_dir}/templates/agents/ux-consultant.md.template`

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
- `{workspace_root}/{slug}/agents/ux-consultant.md`

#### Publish to user-level agents directory (B1)

The workspace-local agent files above are the canonical copies — they're version-controlled alongside workspace config and can be hand-edited. But Claude Code's `Agent` tool only resolves `subagent_type` against `~/.claude/agents/` (user-level) and `.claude/agents/` (project-level). So `dal-assessor` (referenced by `phase-6.md`) will not resolve unless we also publish a copy there.

After writing the three workspace-local files, also publish them to `~/.claude/agents/` with the slug-prefixed names that downstream phase files already use:

```bash
mkdir -p ~/.claude/agents
```

For each of (`product-owner`, `assessor`, `ux-consultant`):

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
ls ~/.claude/agents/{slug}-{product-owner,assessor,ux-consultant}.md
```

Print a one-liner to the user: `Workspace agents published: {slug}-product-owner, {slug}-assessor, {slug}-ux-consultant — downstream pipeline phases will dispatch them by name.`

#### Placeholder substitution discipline

Placeholders may appear more than once in a template (e.g., a shared slug referenced in frontmatter and body). Every substitution MUST be global:

- When using `Edit`, pass `replace_all: true` for every placeholder replacement.
- When using `sed`, use the `g` flag (`s|{{PLACEHOLDER}}|value|g`).

After writing each agent file, verify zero placeholders remain:

```bash
grep -c '{{' {workspace_root}/{slug}/agents/{product-owner,assessor,ux-consultant}.md
```

Every file must report `0`. If any file reports ≥1, halt, run `grep -n '{{' <file>` to list remaining placeholders by line, and fix before continuing. Do **not** ship an agent file with an unfilled placeholder — it will produce confusing behavior at runtime when the agent reads its own system prompt.

**Update scratchpad**: set `Domain agents` to COMPLETED in `## Generation Status`.

---

### Step 3.5: Offer to write a `settings.local.json` for approval-free operation (C1 / C2 / C3)

The `/deliver` pipeline triggers many Edit / Write / Bash calls scoped to paths under `{workspace_root}/{slug}/**` and the repos in `config.repos`. Without pre-allow rules, every one prompts for approval, slowing the run and fragmenting flow.

Offer to write a `settings.local.json` in the workspace directory (not in the repos — that scope is each team's decision) that pre-allows the common patterns this pipeline uses. The file is user-scoped (not committed to any repo), so it's safe to write but ONLY with explicit user consent.

Prompt:
```
I can write {workspace_root}/{slug}/settings.local.json that pre-allows:
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
4. Write to `{workspace_root}/{slug}/settings.local.json`.
5. Suggest to the user:
   > "To make these allow rules active in this session, run `/permissions` and reload the settings, or run `/update-config reload-permissions`. New sessions pick them up automatically if this workspace directory is on the Claude Code settings search path."

On `no`: skip. Note in the Phase D summary: "settings.local.json skipped per user choice. Approval prompts will continue during feature runs."

**Update scratchpad**: add a `Settings file` row to `## Generation Status` — `WRITTEN`, `SKIPPED`, or `EXISTED` (if a file was already present and we chose not to overwrite without extra consent).

---

### Step 4: Collate audit findings

Assemble `{workspace_root}/{slug}/context/audit-findings.md` from the per-agent `## Audit Findings` sections captured during Step 2 (merged CLAUDE.md + agent-context generation). Skip this step entirely if no agent reported any finding.

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
*Source: {agent-type} during Phase C Step 2 (merged docs generation)*

- [severity] file:line — description (evidence: ...)
- ...

## {repo-name-2}
...
```

**Rules:**
- One H2 section per source repo (deduplicate findings by `file:line + description`).
- Sort findings within each section by severity descending (critical first).
- Do NOT editorialize or summarize findings — copy verbatim from the agent response. The agents already committed to the format.
- If any finding has severity `critical`, the final Phase D summary MUST surface it prominently (see phase-d.md Step 6).

**Cross-reference from platform.md:** append the following paragraph to the **Known Constraints** section of `{workspace_root}/{slug}/context/platform.md` (or create the section if missing):

> **Onboarding audit findings** (N critical / N high / N medium / N low): see `{workspace_root}/{slug}/context/audit-findings.md` for the full list with file:line references. Review before touching the affected code paths.

If zero findings were reported across the whole phase, write no file and add no cross-reference — silence is a valid signal too.

**Update scratchpad**: add an `Audit findings` row to `## Generation Status`:
- `{N} findings across {M} repos` if any, path to the file
- `none reported` if the phase surfaced no issues
- Set Phase C status to COMPLETED. Set Current Phase to "D. Verification".

---
