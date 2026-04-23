### Phase 3: Spec Edit (openapi-spec-editor agent)

Skip if `--skip-spec-edit` or the architect found no spec changes needed.

Phase 3 dispatches the `openapi-spec-editor` agent to apply the approved technical design's `API_DESIGN` section to every affected spec file. The orchestrator does NOT read or edit spec files directly — it passes the agent the file paths and the design, and receives a structured diff summary back. This keeps the spec bodies (~5–10K tokens each) out of the orchestrator's live context.

**WORKTREE RULE (A1)**: spec edits land in per-repo worktrees — not on the main branch — unless `--no-worktrees` was passed. Phase 5 reuses these same worktrees, so spec edits and implementation stay on the same feature branch per repo.

#### Step 0: Create worktrees for spec-owning repos

Unless `--no-worktrees` was passed, before the spec editor is dispatched:

1. Build the list of distinct repos that own specs to be edited: for each service in `AFFECTED_SERVICES`, resolve `config.services[service].repo` → `config.repos[repo].path`. Deduplicate so each repo is created once even if it hosts multiple specs.
2. For each distinct repo, create the worktree at a sibling path named `{repo-name}-{feature-slug}` on branch `feature/{feature-slug}`:
   ```bash
   cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} -b feature/{feature-slug}
   ```
   If a worktree already exists (resume case), leave it alone — `git worktree list` will show it.
3. Verify each worktree exists before dispatch.

Record worktree paths in the scratchpad's Architecture Flags section as `spec_worktrees: {repo → worktree_path}` so Phase 5 reuses them.

**If `--no-worktrees` was passed**: log "Phase 3 spec edits on current branch ({branch}) — no worktrees per flag" and skip Step 0 entirely. Spec paths in Step 1 use the repo root instead of the worktree.

#### Step 1: Extract inputs

1. Read `outputs/phase-2-architecture.md` and extract the `<!-- BEGIN API_DESIGN -->` section and the `<!-- BEGIN AFFECTED_SERVICES -->` section. The architect's `AFFECTED_SERVICES` section specifies the Spec Edit Order.
2. Build the ordered list of `(service_name, absolute_spec_file_path)` pairs:
   - For each service in the architect's `AFFECTED_SERVICES` list: resolve `config.services[service].repo` → `config.repos[repo].path` → combine with `service.spec_file`.
   - If worktrees exist (Step 0 ran), the path is `{spec_worktree_path}/{spec_file}` — NOT the main repo path.
   - If `--no-worktrees` was passed, the path is `{repo.path}/{spec_file}`.

#### Step 2: Dispatch the agent

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

Follow your system prompt's process: Read each spec, apply additions / modifications / removals from the API_DESIGN, verify YAML well-formedness, capture a diff summary. Return the structured Output Format with one section per service.

The spec files are in feature worktrees (branch `feature/{feature-slug}`) — edit them in place at the paths given above. Do NOT create new worktrees yourself. If any service's spec fails YAML validation after your edits, STOP and report — do not proceed to later services.
```

The agent returns a structured diff summary per service. The orchestrator receives only this summary — the full spec contents never enter its context.

#### Step 3: Track the dispatch

Per critical rule #13: parse `duration_ms` and `total_tokens` from the agent's `<usage>` block, append a row to the `## Agent Dispatch Log` in the scratchpad with phase `3`, agent `openapi-spec-editor`, task ID `—` (no task — this dispatch is at a phase where Phase 4.5 task persistence hasn't happened yet), and the reported outcome.

#### Step 4: Present to user and handle the approval gate

Show the agent's diff summary to the user. Ask:

> "Approve these spec changes to continue to Phase 4 (spec sync), or reject and revert?"

**On approval**: proceed to Phase 4.

**On rejection with worktrees**: the worktrees contain only the spec edits on branch `feature/{feature-slug}`. For each spec-owning worktree, revert via:

```bash
cd {spec_worktree_path} && git checkout {spec_file}
```

(The worktree stays — Phase 5 would recreate it anyway if the pipeline continues. The edits are reverted; the branch remains.)

If the user also wants to drop the worktree entirely (e.g., they're abandoning the feature):
```bash
cd {repo_path} && git worktree remove ../{repo-name}-{feature-slug} && git branch -D feature/{feature-slug}
```

**On rejection without worktrees (`--no-worktrees`)**: revert each modified spec via `git checkout` on the main branch:
```bash
cd {repo_path} && git checkout {spec_file}
```

Run these in parallel (one Bash call per service). After reverting, ask the user whether to:
- **Stop** the pipeline entirely (the feature is not ready for spec-level work)
- **Re-dispatch** `openapi-spec-editor` with revised instructions (user provides the adjustment they want; orchestrator rewrites the prompt to incorporate the feedback and dispatches again)
- **Re-enter Phase 2** to adjust the architecture first (uncommon; user wants a design change)

The `openapi-spec-editor` agent does not know about rollback — all git operations are the orchestrator's responsibility.

#### Step 5: Persist the outcome

**Update scratchpad**: Set Phase 3 Status to COMPLETED. Write the agent's diff summary to `outputs/phase-3-diffs.md` — this is what the summary becomes. Set Current Phase to "Phase 4: Spec Sync".

---
