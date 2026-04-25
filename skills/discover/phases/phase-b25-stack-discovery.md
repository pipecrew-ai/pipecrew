## Phase B2.5: Stack Discovery + Per-Service Divergence

**Skip if**: the config has no repos at all (shouldn't happen — Phase A would have halted).

**Goal of this phase**: a single per-stack code scan that produces TWO outputs:

1. **Engineering-conventions doc per distinct stack** at `{workspace_root}/{slug}/context/stacks/{type}.md` — populated from the PipeCrew template + a targeted scan of the workspace's repos of that type. The single source of truth for *how we write {stack} here*, read by implementer + reviewer agents at every `/deliver` dispatch.
2. **Per-service divergences subsection** appended to `{workspace_root}/{slug}/context/platform.md` under Tech Stack — names the per-repo deltas from the just-discovered baseline so downstream agents apply the right pattern for the right repo.

Both come from one analysis pass per stack; no duplicate code reading. Replaces the prior B2.5 (per-repo divergences) and B4 (per-stack standards) split.

**Scope boundary — critical**: this phase generates **engineering** conventions only (API clients, auth patterns, persistence, migrations, routing, state management, testing, config structure). It does **NOT** generate UX / component-tree patterns — those live in each frontend repo's `DESIGN_SYSTEM.md`, bootstrapped by Phase B3. The two documents are orthogonal and must remain so. For React repos, Phase B3 runs first (UX), this phase runs after (engineering). A single React repo ends up with both:
- `{repo}/agent-context/common/DESIGN_SYSTEM.md` — UX shapes (tab shell, row actions, modals)
- `{workspace_root}/{slug}/context/stacks/react.md` — engineering (API client, React Query, hooks)

**Output mode flags:**
- Default: produce both stacks docs + platform.md divergences.
- `--skip-divergences` (existing flag): produce stacks docs only; skip the platform.md divergences write. Useful for fast iteration or when you've hand-curated the divergence section already.

---

### Refresh mode (`--refresh-stacks`)

This phase is normally entered after Phase B3 in a fresh `/discover` run. It can also be entered standalone via `/discover --refresh-stacks --workspace=<slug>` to retrofit a workspace that was onboarded before this phase existed, or to refresh stale `stacks/{type}.md` docs and platform.md divergences after the workspace's code has evolved. The phase logic below is identical in either case — only the entry conditions differ.

**Refresh entry checklist** (only when `--refresh-stacks` is the entry point — otherwise skip and use the normal phase entry):

1. Resolve `{workspace_root}` via `node {plugin_dir}/scripts/workspace-root.js --get`. Halt if unset.
2. Resolve the workspace slug:
   - If `--workspace=<slug>` was passed, use it.
   - Otherwise scan `{workspace_root}/*/config.json` — if exactly one workspace exists, use it; if multiple, ask the user.
3. Validate `{workspace_root}/{slug}/config.json` with `node {plugin_dir}/scripts/validate-config.js {config-path}`. Halt on errors.
4. Confirm with the user before proceeding:
   ```
   Refresh stack standards + divergences for workspace "{slug}"?
   This will read your repos and produce / refresh:
     {workspace_root}/{slug}/context/stacks/{type}.md  (engineering conventions)
     {workspace_root}/{slug}/context/platform.md       (Per-Service Divergences subsection)
   {N} distinct stacks detected: {list}
   Continue? (yes / no / stacks-only)
   ```
   - `yes` → both outputs refreshed.
   - `stacks-only` → set `--skip-divergences`, produce only stacks docs (leave platform.md untouched). Useful when divergences in platform.md are hand-curated.
   - `no` → abort.
5. Create a refresh run dir: `{workspace_root}/{slug}/runs/discover/{run_id}/` with `run_id = {YYYY-MM-DD-HHMMSS}-refresh-{slug}`. Emit `run_start` to `checkpoints.jsonl` with `event_subtype: "refresh-stacks"` so reporter agents can distinguish refresh runs from full discoveries.
6. Skip Phase A/B1/B2/B3/C/D — proceed directly to Step 1 below.
7. After the divergence-aggregation step (or after stacks are written if `--skip-divergences`), emit `run_end` and skip Phase D's full verification (the workspace is already verified).

End-of-run summary line for backfill mode:
```
[backfill ✔] {N} stacks/{type}.md generated/refreshed at {workspace_root}/{slug}/context/stacks/ ({mm:ss}, {Xk} tokens)
```

---

### Step 1: Enumerate distinct stacks

From the workspace config, list the distinct values of `repos.*.type`. Each distinct value gets one standards doc.

```bash
# For illustration — actual implementation reads config.json
jq -r '.repos | to_entries | map(.value.type) | unique | .[]' \
  {workspace_root}/{slug}/config.json
```

Typical output for a polyglot workspace:
```
spring-boot
react
node-mock
cdk
```

A workspace with a single tech stack gets a single stack doc.

---

### Step 2: Per-stack probe — does the doc already exist?

For each distinct stack, check whether `{workspace_root}/{slug}/context/stacks/{type}.md` already exists.

**If it exists** — audit against the current template, do not overwrite. Dispatch an audit agent similar to Phase B3 Step 2:

**Tool**: `Agent`
**subagent_type**: `general-purpose`
**description**: `"Stack standards audit — {type}"`
**prompt**:

```
Read these two files:
1. {workspace_root}/{slug}/context/stacks/{type}.md
2. {plugin_dir}/templates/stacks/{type}.md.template

Compare the existing file's §-numbered sections against the template's REQUIRED
anchors. The template's stable numbering (§1, §2, …) is the contract the
PipeCrew agents cite.

Output:

## Audit: stacks/{type}.md

### Present sections
(match by heading text, not exact numbering)

### Missing sections
(required in template, absent in file)

### Stale content
(if a "Last Updated" date is > 90 days old, flag as stale)

### Recommendation
- UP_TO_DATE
- NEEDS_FILL  (additive — append missing sections)
- NEEDS_RENAME (section headings diverge; needs human review)

End with:
<!-- BEGIN AUDIT_SUMMARY -->
recommendation: {one of the three}
missing_sections: {comma-separated, or "none"}
stale: {yes/no}
<!-- END AUDIT_SUMMARY -->

Do NOT rewrite the file. Audit only.
```

Same UX as Phase B3: present audit summary to the user, offer (a) fill missing sections additively with TODO placeholders, (b) leave as-is, (c) regenerate (saves existing to `.backup.md`, then runs Step 3).

**If it does not exist** — proceed to Step 3 for this stack.

---

### Step 3: Fresh bootstrap — scan code + fill template

For stacks needing bootstrap, dispatch one scanning agent per stack. These can run in **parallel** (one orchestrator message, one Agent tool call per stack) — each scans a disjoint set of repos.

**Tool**: `Agent`
**subagent_type**: `general-purpose`
**description**: `"Stack standards bootstrap — {type}"`
**prompt**:

```
You are bootstrapping the {type} engineering-conventions document for the
{workspace.name} workspace. The plugin template is at:
  {plugin_dir}/templates/stacks/{type}.md.template

Scope: read the actual code in the workspace's repos of type `{type}`.
Repos to scan (from the workspace config):
{for each repo in config where repo.type == this.type:}
- {repo.name} at {repo.path}

For each §-numbered section in the template, detect the repo's established
pattern and fill the placeholders. Rules for filling:

1. **Observe, don't prescribe.** Every filled section must reflect what's
   ACTUALLY in the code — not what you think {type} "should" do. If the repo
   uses Flyway for migrations (not Liquibase), write Flyway. If the repo reads
   SecurityContextHolder manually (not @PreAuthorize), write that — even if
   it's a smell. The document captures reality; refactoring is a separate
   workflow.

2. **Divergence across repos.** If repos of the same stack disagree on a
   convention (e.g., two Spring Boot services where one uses @PreAuthorize
   and the other uses manual role checks), pick the dominant pattern, name it
   in the "Detected pattern" line, then add an inline divergence note:
     > Note: {repo-name} diverges — uses {other-pattern}. See platform.md
     > § Per-Service Divergences.
   This way the standards doc has one canonical answer, and the divergence
   is visible. ALSO emit each divergence as a structured bullet in the
   DIVERGENCES output block (see Output section below) so the orchestrator
   can fold it into platform.md without re-reading code.

3. **No established pattern.** If a concern genuinely has no established
   pattern (e.g., the workspace has no paginated endpoints yet, no security
   tests, no file uploads), write:
     "No established pattern yet — the first feature to add one will
     establish the convention and document it back here via
     /context-refresh."
   Do NOT leave {{PLACEHOLDERS}} in the output.

4. **Reference files are real paths.** For every detected pattern, cite
   2–3 real files in the scanned repos that exemplify the pattern. If you
   can only find one, cite one and note "only one example present — pattern
   is still forming".

5. **DON'T blocks only when drift is observed.** If you find a file that
   violates the dominant pattern, include a DON'T block showing the
   anti-pattern with a line reference. If the codebase is clean and
   consistent, omit the DON'T block entirely — don't manufacture
   anti-patterns.

6. **Do NOT invent section numbers.** Use the template's §1–§{N} exactly.

Output: emit TWO blocks separated by clear markers. The orchestrator parses
them separately — STACKS_MD goes to the stacks file, DIVERGENCES gets folded
into platform.md.

<!-- BEGIN STACKS_MD -->
{COMPLETE populated stacks/{type}.md content — follow the template structure
exactly, all §-anchors filled, no {{PLACEHOLDERS}} remaining}
<!-- END STACKS_MD -->

<!-- BEGIN DIVERGENCES -->
{One bullet per per-repo divergence from the dominant pattern. Format:
- {repo-name}: {dimension} — repo uses X (baseline says Y; evidence: file:line)

If repos of this stack agree on every dimension, output exactly:
None.}
<!-- END DIVERGENCES -->

Do not add framing text before, after, or between the blocks. The orchestrator
parses by marker.
```

**Parse + Write per agent return:**

1. Extract content between `<!-- BEGIN STACKS_MD -->` and `<!-- END STACKS_MD -->` → write to `{workspace_root}/{slug}/context/stacks/{type}.md`. Create the `stacks/` directory if it doesn't exist.
2. Extract content between `<!-- BEGIN DIVERGENCES -->` and `<!-- END DIVERGENCES -->` → buffer in memory keyed by `type`. The orchestrator aggregates across stacks in Step 4.

If a marker is missing in the agent's response, treat the response as malformed: re-dispatch once with a fix-up prompt clarifying the format. If the second response also lacks markers, mark this stack as `apply-failed` in the scratchpad and continue with other stacks.

---

### Step 4: Aggregate divergences into platform.md

**Skip this step if `--skip-divergences` was passed** (or `--refresh-stacks` was answered with `stacks-only`). Stacks docs are written; platform.md is left untouched. Note in scratchpad: `divergences: skipped (--skip-divergences)`.

Otherwise, fold the buffered DIVERGENCES bullets from all per-stack agents into platform.md.

**Locate insertion point**: in `{workspace_root}/{slug}/context/platform.md`, find the `## Tech Stack` section. Insert AFTER the existing Tech Stack paragraphs and BEFORE the next top-level `##` heading.

**If a `### Per-Service Divergences` subsection already exists** (re-runs of this phase, or `--refresh-stacks`):
- Replace the entire subsection content with the freshly aggregated bullets. The header timestamp updates to today.
- Preserve any user-added notes or annotations only if they live OUTSIDE the auto-managed bullets — bullets themselves are regenerated each run.

**If no subsection exists**, append:

```markdown
### Per-Service Divergences

Discovered in Phase B2.5 on {date}. The general Tech Stack block above
describes the workspace baseline; these per-repo overrides apply where
a specific repo diverges. Use these when briefing implementers for that
specific repo — do not apply the baseline blindly.

#### {repo-name-1}
- {dimension}: repo uses X (baseline says Y; evidence: {file:line})
- ...

#### {repo-name-2}
- ...
```

Rules for the merge:
- Group bullets by `{repo-name}` from the per-stack agents' DIVERGENCES blocks.
- Order repos within the subsection: by `repo.role` (api-service first, then frontend, then infrastructure, then mock-server), then alphabetical.
- Repos with no divergences (any stack agent returned `None.` for them) are omitted from this subsection — no empty H4 blocks.
- Copy bullets verbatim from the agent response; do not re-word.
- If a divergence contradicts something elsewhere in platform.md (e.g., the Integration Patterns section assumed OpenFeign everywhere), append a note at the end of the relevant original paragraph: `> Note: see ## Per-Service Divergences — {repo} uses RestTemplate, not Feign.`

**Validate** the platform.md file parses as well-formed markdown after the edit (basic check: no broken code fences, all H3/H4 headers properly closed by next sibling or parent). On any structural issue, revert and mark scratchpad `divergences: apply-failed` for the user to inspect.

---

### Step 5: User review (batched)

After all per-stack bootstraps complete, present a combined summary:

```
## Stack standards bootstrapped

{N} stacks detected and populated at {workspace_root}/{slug}/context/stacks/:

  - spring-boot.md    ({K} services scanned, {M} sections populated)
  - react.md          ({K} repo scanned, {M} sections populated)
  - node-mock.md      ...
  - cdk.md            ...

Review before continuing? (yes / continue)
```

If the user says "yes", show them in turn. These are first drafts — the user should sanity-check, fix any mis-detected conventions, and add workspace-specific details that a code scan can't infer. The docs are committed to the workspace at generation time; subsequent `/context-refresh` runs will keep them current.

---

### Step 6: Update audit-findings doc

If any bootstrap agent surfaced audit findings (see the "Audit Findings contract" in Phase C — same rules apply here), collate them under the existing workspace audit-findings doc at `{workspace_root}/{slug}/context/audit-findings.md`, keyed by stack.

---

**Update scratchpad**: set Phase B2.5 status to COMPLETED with a per-stack note. In the `## Phase Status` notes column: `{type}: bootstrapped | audited-up-to-date | audited-filled | audited-left-as-is | apply-failed`. Add a `divergences:` row noting how many per-repo divergence bullets landed in platform.md (or `skipped` if `--skip-divergences`). Set Current Phase to "C. Generation" (or skip to `run_end` if entered via `--refresh-stacks`).

**One-line chat status** (per the orchestrator rule):
```
[phase B2.5 ✔] 4 stacks discovered, {M} divergences folded into platform.md (N:NN, Xk tokens)
```

If `--skip-divergences`:
```
[phase B2.5 ✔] 4 stacks discovered, divergences skipped (N:NN, Xk tokens)
```
