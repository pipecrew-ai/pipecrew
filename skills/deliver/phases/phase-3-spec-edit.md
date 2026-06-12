### Phase 3: Contract + Spec Edit

Phase 3 has two sub-phases:

- **Phase 3a: Contract Edit** — dispatches the `schema-implementer` agent for every contract repo listed in the architect's `AFFECTED_CONTRACTS` section. Runs FIRST because service specs and service code may reference contract schemas (JSON Schema, Avro, Protobuf).
- **Phase 3b: API Spec Edit** — dispatches the `openapi-spec-editor` agent for every service listed in `AFFECTED_SERVICES` **with `spec_policy: api-first`**. Services with `spec_policy: code-first` or `no-api` are skipped — their contract lives in the architect's design or in contract repos, not in an OpenAPI file.

The user sees BOTH diff summaries at a single approval gate at the end of the phase.

Skip the whole phase if `--skip-spec-edit` was passed. Skip 3a if `AFFECTED_CONTRACTS` is `N/A` / empty. Skip 3b if no affected service has `spec_policy: api-first`.

**WORKTREE RULE (A1)**: contract and spec edits both land in per-repo worktrees — not on the main branch — unless `--no-worktrees` was passed. Phase 5 reuses these same worktrees, so edits and implementation stay on the same feature branch per repo.

---

#### Step 0: Extract the design inputs once

**Do NOT `Read outputs/phase-2-architecture.md`** — Phase 2 already split it into per-block side files at `outputs/blocks/`. Read only the blocks this phase needs:

```bash
# AFFECTED_SERVICES — the structured services index
cat {run_dir}/outputs/blocks/affected-services.json

# AFFECTED_CONTRACTS — always emitted (empty contracts[] iff none affected)
cat {run_dir}/outputs/blocks/affected-contracts.json

# CONTRACT_DESIGN — the body 3a passes to schema-implementer (only when contracts affected)
cat {run_dir}/outputs/blocks/contract-design.json 2>/dev/null

# API_DESIGN — the body 3b passes to openapi-spec-editor (only when api-first services affected)
cat {run_dir}/outputs/blocks/api-design.json
```

Each `cat` is one Bash call returning a small, deterministic JSON payload — orders of magnitude cheaper than reading the full markdown. The JSON shape is documented in `templates/blocks/block-schemas.md` and matches `templates/blocks/<slug>.example.json`.

For sub-agent prompts (Steps 2a / 2b below), pass the JSON content of `contract-design.json` / `api-design.json` directly into the `CONTRACT DESIGN:` / `API DESIGN:` slot of the dispatch prompt.

From `affected-services.json`, `services_to_edit = services.filter(s => s.spec_policy === "api-first")`. Services filtered out are flagged in the scratchpad: `"Phase 3b skipped {svc} — spec_policy is {policy}"`. The `spec_edit_order` array tells you which service spec to edit first when multiple `api-first` services are affected.

---

## Phase 3a: Contract Edit (schema-implementer)

Skip this sub-phase entirely if `affected-contracts.json` has `contracts.length === 0`. Log: `"Phase 3a skipped — no contract repos affected"`. If the file does NOT exist at all, treat that as a producer bug: the architect was supposed to emit the `AFFECTED_CONTRACTS` JSON block (even when empty), and `split-design.js` always materializes a present block. STOP and report `"AFFECTED_CONTRACTS missing — re-dispatch the architect"` rather than silently skipping (the previous fallback masked this bug for months).

Also enforce the breaking-changes gate at this point: if any `contracts[].files[].classification === "breaking"`, `breaking_changes_authorized` MUST be `true` AND the prose section under `CONTRACT_DESIGN` must contain a `### Breaking Change Authorization` sub-section. If either is missing, STOP and report the contract repo(s) and file(s) involved — the schema-implementer would refuse anyway, surface it here so the user can decide before any worktree is created.

#### Step 0a: Create worktrees for contract-owning repos

Unless `--no-worktrees` was passed:

1. Build the distinct list of contract repos from `affected-contracts.json`: iterate `contracts[].repo_key` and resolve each via `config.repos[repo_key].path`.
2. For each, create a worktree at a sibling path named `{repo-name}-{feature-slug}` on branch `feature/{feature-slug}`:
   ```bash
   cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} -b feature/{feature-slug}
   ```
   If a worktree already exists (resume case), leave it alone.
3. Record worktree paths in the scratchpad's Architecture Flags section as `contract_worktrees: {repo → worktree_path}` so Phase 5 can reuse them if a later step generates code from these schemas.

If `--no-worktrees` was passed, skip this step; file paths below use the repo root.

#### Step 1a: Build the schema-implementer input list

Iterate `affected-contracts.json` in the order given by `edit_order` (NOT `contracts[]` array order — `edit_order` is the dispatch sequence). For each `repo_key`:

- Find the matching `contracts[]` entry by `repo_key`.
- Resolve its path (worktree path if Step 0a ran, else repo root).
- Use `contracts[].files[]` directly — each `{ path, change_kind, classification, summary }` becomes one `file_target`, with the relative `path` translated to an absolute path against the resolved repo path.

Build an ordered list of `(repo_key, absolute_repo_path, [file_targets])` tuples following `edit_order` literally.

#### Step 2a: Dispatch schema-implementer

**Tool**: `Agent`
**subagent_type**: `schema-implementer`
**description**: `"Apply contract changes — {feature-slug}"`
**prompt template**:

```
You are applying contract (schema) changes for feature "{feature_summary}".

AFFECTED CONTRACTS (in edit order — contracts that are referenced by other contracts come first):

1. {repo_key_1} at {absolute_repo_path_1}
   Files to edit:
   - {relative_path_1a} — {one-line change from the architect}
   - {relative_path_1b} — {one-line change}
2. {repo_key_2} at {absolute_repo_path_2}
   Files to edit:
   - {relative_path_2a} — {one-line change}
...

CONTRACT DESIGN (source of truth — apply faithfully, do not invent or improve):

{the full text of the <!-- BEGIN CONTRACT_DESIGN --> ... <!-- END CONTRACT_DESIGN --> section from outputs/phase-2-architecture.md}

Follow your system prompt's process: detect each file's format, classify each change as additive or breaking, refuse breaking changes unless the design contains the authorization sentence, validate per-format syntax, run compat tests if the repo has them, and return the structured diff summary with one section per repo.

The files are in feature worktrees (branch `feature/{feature-slug}`) — edit them in place at the paths given above. Do NOT create new worktrees yourself.
```

#### Step 3a: Track the 3a dispatch

Per critical rule #13: parse `duration_ms` and `total_tokens` from the agent's `<usage>` block, append a row to the `## Agent Dispatch Log` in the scratchpad with phase `3a`, agent `schema-implementer`, task ID `—`, and the reported outcome. Capture the diff summary in a scratch variable `contract_diff_summary` for Step 4.

---

## Phase 3b: API Spec Edit (openapi-spec-editor)

Skip this sub-phase entirely if `services_to_edit` from Step 0 is empty. Log: `"Phase 3b skipped — no api-first services affected"`.

#### Step 0b: Create worktrees for spec-owning repos

Unless `--no-worktrees` was passed:

1. Build the distinct repos that own specs to be edited: for each service in `services_to_edit`, resolve `config.services[svc].repo` → `config.repos[repo].path`. Deduplicate so each repo is created once even if it hosts multiple specs.
2. For each distinct repo that is not already covered by a contract worktree from Step 0a, create a worktree at a sibling path named `{repo-name}-{feature-slug}` on branch `feature/{feature-slug}`:
   ```bash
   cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} -b feature/{feature-slug}
   ```
3. Verify each worktree exists before dispatch.

Record worktree paths in the scratchpad's Architecture Flags section as `spec_worktrees: {repo → worktree_path}` so Phase 5 reuses them.

If `--no-worktrees` was passed, skip; spec paths below use the repo root.

#### Step 1b: Extract inputs for openapi-spec-editor

For each service in `services_to_edit` (in the architect's declared order):

- Resolve `config.services[svc].repo` → repo path (worktree path if Step 0b ran, else repo root).
- Combine with `config.services[svc].spec_file` to get the absolute spec path.

Build the ordered `(service_name, absolute_spec_file_path)` pairs.

#### Step 2b: Dispatch openapi-spec-editor

**Tool**: `Agent`
**subagent_type**: `openapi-spec-editor`
**description**: `"Apply spec changes — {feature-slug}"`
**prompt template**:

```
You are applying the API contract changes for feature "{feature_summary}".

AFFECTED SERVICES (in edit order — services whose schemas are referenced by other services come first):

1. {service1_name} → {absolute_spec_file_path_1_in_worktree}
2. {service2_name} → {absolute_spec_file_path_2_in_worktree}
...

API DESIGN (source of truth — apply these changes faithfully, do not invent or improve):

{the full text of the <!-- BEGIN API_DESIGN --> ... <!-- END API_DESIGN --> section from outputs/phase-2-architecture.md}

If API_DESIGN references contract schemas that were edited in Phase 3a (look for "see CONTRACT_DESIGN" cross-links), match your $ref targets to those schema shapes. The contract edits have already landed on the same branch.

Follow your system prompt's process: Read each spec, apply additions / modifications / removals from the API_DESIGN, verify YAML well-formedness, capture a diff summary. Return the structured Output Format with one section per service.

The spec files are in feature worktrees (branch `feature/{feature-slug}`) — edit them in place at the paths given above. Do NOT create new worktrees yourself. If any service's spec fails YAML validation after your edits, STOP and report — do not proceed to later services.
```

#### Step 3b: Track the 3b dispatch

Same as Step 3a: append a Dispatch Log row with phase `3b`, agent `openapi-spec-editor`. Capture the diff summary in `spec_diff_summary` for Step 4.

---

#### Step 4: Present to user and handle the approval gate

Render a combined view that shows the user both artifacts:

```markdown
# Phase 3 diffs — feature "{feature_summary}"

## Contract changes (Phase 3a)
{contract_diff_summary, or "N/A — no contract repos affected"}

## API spec changes (Phase 3b)
{spec_diff_summary, or "N/A — no api-first services affected"}

## Services skipped for Phase 3b (not api-first)
- {svc_key}: spec_policy is {policy}, handled by {code-first: "architect's inline endpoint contract in API_DESIGN" | no-api: "event schema in Phase 3a contract repo"}
```

Ask the primary approval question:

> "Approve these contract + spec changes? (yes / no — no will revert)"

**If approved AND at least one repo has `spec_copies` entries referencing any affected service** (i.e., there are sync targets), ask the follow-up:

> "Sync the edited spec(s) to consuming repos that hold copies (frontend / mock / etc.)? **Default is no** — answer 'yes' to run Phase 4. (yes / no)"

If no repo has `spec_copies` for the affected services, skip the follow-up entirely and record `Phase 4: SKIPPED — no sync targets`.

Persist the answer to the scratchpad's Architecture Flags section as `spec_sync_opt_in: yes | no` (treat unset as `no`). Phase 4 reads this flag to decide whether to run.

**On approval**: proceed to Phase 4 (which itself reads `spec_sync_opt_in` and skips when `no`).

**On rejection**: revert BOTH sub-phases.

With worktrees (default):
- For each contract worktree, revert the edited files:
  ```bash
  cd {contract_worktree_path} && git checkout {file_target_1} {file_target_2} ...
  ```
- For each spec worktree, revert the edited spec:
  ```bash
  cd {spec_worktree_path} && git checkout {spec_file}
  ```

Worktrees stay — Phase 5 would recreate them if the pipeline continues, and they may still be needed for a re-dispatch. If the user wants to drop a worktree entirely (abandoning the feature):
```bash
cd {repo_path} && git worktree remove ../{repo-name}-{feature-slug} && git branch -D feature/{feature-slug}
```

Without worktrees (`--no-worktrees`):
```bash
cd {repo_path} && git checkout {file_path}
```

Run the reverts in parallel (one Bash call per file). After reverting, ask the user whether to:
- **Stop** the pipeline entirely
- **Re-dispatch 3a** with revised CONTRACT_DESIGN
- **Re-dispatch 3b** with revised API_DESIGN
- **Re-enter Phase 2** to adjust the architecture first

Neither agent knows about rollback — all git operations are the orchestrator's responsibility.

#### Step 5: Persist the outcome

**Update scratchpad**: Set Phase 3a Status and Phase 3b Status per what ran (COMPLETED / SKIPPED with reason). Write the combined diff view to `outputs/phase-3-diffs.md`. Set Current Phase to "Phase 4: Spec Sync".

---
