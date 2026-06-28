# Incremental discovery (auto-detected re-run)

Shared rules for the case where `/discover` is run against a parent directory
that belongs to an **already-onboarded** workspace, and one or more repos have
been **added** since the last run. The goal: onboard only the new repos and
**merge** them into the existing `config.json` / `platform.md` / diagrams,
instead of re-profiling and rewriting everything.

This is distinct from `--resume` (which continues an *interrupted* run — a
`COMPLETED` workspace is never picked up by resume) and from `/context-refresh`
(which updates docs for repos already in the config, and never adds a repo).

The owning skill is `/discover`; the mode is decided in **Phase A Step 1.5** and
threaded through every later phase via the scratchpad.

---

## The two modes

| `discover_mode` | When | Working set |
|---|---|---|
| `full` | No existing `config.json` for this slug (first onboarding), OR the user chose "full" at the Step 1.5 gate, OR `--full` was passed | Every confirmed repo. Current/legacy behavior — phases run exactly as written, ignore this doc. |
| `incremental` | Existing `config.json` found AND ≥1 new repo on disk AND the user chose "incremental" (the default) | Only the **new** repos are profiled, documented, and architected; their results are **merged** into the existing workspace artifacts. |

Two repo sets are referenced throughout this doc and the phase files:

- **`new_repos`** — repos found on disk by the Phase A scan whose normalized
  absolute path is NOT a value of any `config.repos[*].path`. These are the only
  repos that get B2.0 profiling, B3 design-system discovery, and Phase C doc
  generation.
- **`all_repos`** — `config.repos` (existing) ∪ `new_repos`. This is the full
  picture used for cross-repo work that must consider both old and new repos
  (the `spec_copies` probe, platform.md topology, diagrams).

---

## Phase A — Step 1.5: detect + choose the mode

Run this immediately after Phase A Step 1 (the `.git` scan), before tech-stack
detection, so the rest of Phase A only does work for the relevant repos.

1. **Look for an existing config**: `{workspace_root}/{slug}/config.json`.
   - Not present → `discover_mode = full`. Skip the rest of Step 1.5; continue
     Phase A normally.
   - Present → load it and continue below.

   > Detection keys on the **slug** derived from the project name asked in
   > PRE-PHASE 0. To re-run incrementally against an existing workspace, give the
   > **same project name** as the original run so the same slug resolves. A
   > different name derives a different slug, finds no config, and onboards a
   > fresh workspace (full mode) — that's the safe failure, not a silent merge
   > into the wrong workspace.

2. **Diff the scan against the config** (compare normalized absolute paths):
   - `known` = scanned repos whose path IS in `config.repos[*].path`.
   - `new_repos` = scanned repos whose path is NOT in the config.
   - `missing` = `config.repos[*].path` with no matching repo on disk anymore.

3. **Decide / prompt**:
   - `--full` flag passed → `discover_mode = full` (re-onboard everything). Skip
     the prompt.
   - No `new_repos` and no `missing` → the workspace already covers every repo.
     Tell the user and offer Template C:
     ```
     Workspace '{slug}' already covers all {K} repos here. Nothing new to onboard.
     Refresh the existing docs instead with /context-refresh, or force a full
     re-discovery?
     (refresh-hint / full / abort)
     ```
     `refresh-hint` → print the `/context-refresh` command and exit. `full` →
     `discover_mode = full`. `abort` → stop.
   - ≥1 `new_repos` → present the auto-detect gate (canonical wording):
     ```
     Existing workspace '{slug}' found — {K} repo(s) already onboarded.
     Scan found {N} new repo(s) not in config.json:
       - {new repo paths}
     {if missing:} {M} repo(s) in config.json are no longer on disk:
       - {missing repo paths}   (left untouched; remove them manually or via a full re-discovery)

     How do you want to proceed?
       (incremental) onboard only the new repo(s); merge them into config.json,
                     platform.md, and the diagrams  [recommended]
       (full)        re-discover everything from scratch (re-profiles ALL repos,
                     rebuilds config.json + platform.md)
       (abort)       stop
     ```
     `incremental` (default) → `discover_mode = incremental`; the confirmed repo
     list for the rest of the run is **`new_repos` only**. `full` →
     `discover_mode = full`. `abort` → stop the run (`run_end status: "aborted"`).

4. **Record in the scratchpad** Run Info: `Discover mode: incremental|full`. In
   incremental mode also record the `new_repos` list and the existing config path
   under a `## Incremental` block so `--resume` can restore the working set:
   ```markdown
   ## Incremental (filled by Phase A Step 1.5)
   - **Mode**: incremental
   - **Existing config**: {workspace_root}/{slug}/config.json ({K} repos)
   - **New repos**: {list of new repo paths}
   - **Missing (reported, untouched)**: {list or "none"}
   ```

In `full` mode none of the sections below apply — run the phases as written.

---

## Per-phase deltas in `incremental` mode

Only the new repos flow through the pipeline; the merge points are explicit.

### Phase A (rest of it)
Run Steps 2–6 (tech-stack / role / spec / policy detection, existing-doc checks,
confirmation table) over **`new_repos` only**. The Step 6 table header notes the
mode and shows the new repos; print a one-line reminder of how many existing
repos are being kept as-is. Apply user corrections to the new repos exactly as in
full mode.

### Phase B1 — domain questions
**Skip the 4 questions.** The domain doesn't change when repos are added. Load
`workspace` + `domain` from the existing `config.json` and use them verbatim.
Offer one lightweight confirmation (Template A-style):
```
Reusing this workspace's domain context:
  {domain.name} — {one-line domain_notes}
  roles: {user_roles} · languages: {i18n_languages} (RTL: {rtl_support})
(yes / edit)
```
`edit` lets the user amend the stored values (write them back into config on
Phase B2 merge); `yes` proceeds. Do not re-ask from scratch.

### Phase B2.0 — per-repo discovery
Dispatch `repo-discoverer` for **`new_repos` only**. Existing repos are NOT
re-profiled — their facts already live in `platform.md` and their own
`CLAUDE.md`. Write the new profiles to `{run_dir}/outputs/repo-profiles/` as
usual.

### Phase B2 — architect synthesis (incremental sub-mode)
Dispatch `solution-architect` with `MODE: discovery-incremental` (instead of
`MODE: discovery`). The prompt changes:
- **Inputs**: the existing `context/platform.md` (read it — it is the source of
  truth for the known repos), the existing `config.json`, and the NEW repos'
  profiles from B2.0. Do NOT read profiles for existing repos (there are none
  this run).
- **Output is a MERGE, not a rewrite.** Preserve all existing platform.md
  content. Insert the new repos into the catalog sections (Service Map + Service
  responsibilities, Entity ownership map, Integration topology, and — only if a
  new repo introduces a pattern shared with an existing repo — Established
  Patterns). Add any new cross-repo edges the new repos create (e.g. a new
  frontend that calls an existing service, or a new service an existing repo
  now talks to). Add a short dated `> Added in this run: {repo list}` note under
  the Service Map so the delta is visible. Don't restate or reshuffle existing
  rows.
- **Diagrams**: regenerate both `.mmd` files from `all_repos` (existing +
  new), applying the existing keep/merge/overwrite gate in the diagram step.
  The new nodes/edges must appear; existing layout choices in a hand-edited
  diagram are preserved per that gate's default-keep rule.

**Build workspace config — MERGE, never overwrite.** This is the critical
difference from full mode:
- Start from the existing `config.json` (deep copy). Preserve every existing
  `repos.*`, `services.*`, `domain.*`, and `workspace.*` entry and any
  hand-edits.
- Add one `repos.{name}` entry per new repo, and one `services.{name}` entry per
  new repo that is a service (api-service / worker), with `spec_policy` from
  Phase A Step 3.5.
- **Re-run the `spec_copies` probe across `all_repos`, both directions:**
  (a) for each NEW api-service's spec, probe every OTHER repo (old and new) for a
  copy; (b) for each EXISTING api-service's spec, probe each NEW repo (a new
  frontend / mock / IaC repo may consume an existing service's spec). Add only
  the entries found; never delete existing `spec_copies` entries.
- Write the merged file and run `node {plugin_dir}/scripts/validate-config.js`.
  On validation failure, fix and re-validate — do not leave a half-merged config.

The early "config already exists" warning (CRITICAL RULE 2) does NOT fire for the
file this run is merging into — that gate is about clobbering, and incremental
mode merges by design.

### Phase B2.6 — observability
Re-run the IaC extractor **only if** a new repo is `infrastructure` or otherwise
contains IaC/log-destination definitions. Otherwise keep the existing
`context/observability.json` untouched. If it does re-run, it reads the merged
config (so it sees the new repos) and merges new destinations into the sidecar
the same way the canonical step does.

### Phase B3 — design system
Run **only if** `new_repos` contains a frontend repo. If the workspace already
had a frontend (so `DESIGN_SYSTEM.md` exists) and the new frontend shares it,
apply the existing diff/keep gate. If there is no new frontend, skip B3 entirely.

### Phase C — generation
- `config.json` was merged in B2 — just re-validate (Step 1).
- Generate CLAUDE.md + agent-context for **`new_repos` only** (the per-repo gate
  and dispatch run exactly as in full mode, but the loop is over the new repos).
  Existing repos' docs are never touched.
- **Domain agents** (product-owner / assessor / troubleshooter) already exist —
  do NOT regenerate them. Leave the workspace `agents/` and the published
  `~/.claude/agents/{slug}-*` copies as-is. (Adding a repo doesn't change the
  domain agents; if a new repo introduces a stack whose implementer/reviewer
  agent is missing, that's a plugin-level agent, not a generated one — note it
  for the user, don't generate it.)
- **Audit findings**: append the new repos' findings to the existing
  `context/audit-findings.md` (new H2 section per new repo). Don't rewrite prior
  sections.

### Phase D — verification + memory
Verify the **new** repos' paths and CLAUDE.md presence; spot-check that the
merged `config.json` validates and that platform.md now references the new repos.
The Phase D summary states the mode and lists what was added
(`Incremental: +{N} repos onboarded, merged into config.json + platform.md`).
Memory sync (Step 8) runs as normal — it publishes the merged docs.

---

## Resume interaction

`/discover --resume` restores `discover_mode` and the `new_repos` working set
from the scratchpad's `## Incremental` block (alongside the usual Discovered
Repos table + Domain Answers). A resumed incremental run must NOT fall back to
full mode — re-read the block and continue with the same working set. If the
block is absent (older run), treat the run as `full` (safe default).

## What incremental mode deliberately does NOT do

- It does not remove `missing` repos from the config — it only reports them.
  Removal is a manual edit or a full re-discovery (so a temporarily-moved repo
  isn't silently dropped).
- It does not re-profile or re-document existing repos. If an existing repo
  *changed* (not just new repos added), that's `/context-refresh`'s job, not
  incremental discovery's.
- It does not regenerate domain agents or re-ask domain questions.
