## Phase B: Domain Questions + Architect-Led Discovery

Two parts: minimal human questions (B1), then automated code discovery (B2).

---

### B1: Domain Interrogation (3 questions — name was already captured in Pre-phase 0)

The project name was already collected in Pre-phase 0 (used to create the scratchpad dir). Do NOT re-ask it. Ask only the three remaining questions. The opener should echo the name back for confirmation so the user can catch a typo without another round-trip:

```
Domain details for {workspace.name}. Three quick questions:

1. **Domain in one sentence**: What does it do?
   (e.g., "Arabic-language book publishing and review platform")

2. **User roles**: Who uses it? List the roles.
   (e.g., Publisher, Manager, Reviewer, Admin)

3. **Languages + RTL**: Which UI languages, and is RTL needed?
   (e.g., "English + Arabic, yes RTL" or "English only, no RTL")
```

From these answers + Pre-phase 0 name, derive:
- `workspace.name` = name from Pre-phase 0
- `workspace.slug` = kebab-case of the name (lowercase, non-alphanum → `-`, truncate to 20 chars)
- `domain.name` = same as `workspace.name`
- `domain.domain_notes` = answer 1
- `domain.user_roles` = answer 2 (split by comma)
- `domain.i18n_languages` = answer 3 (parse language codes)
- `domain.rtl_support` = true if RTL mentioned in answer 3

**If the user corrects the name in their answer** (e.g., "Actually it's called X, not Y"), treat that as a name-change request: update the scratchpad, rename the workspace directory if the slug changes, and re-confirm before proceeding.

Do NOT ask about:
- Tech stack — already detected in Phase A
- Entities — architect discovers from code in B2
- API design — not the user's job
- Deployment — discovered from infra repo

**Update scratchpad**: write answers to `## Domain Answers` in `scratchpad.md`. Set Phase B1 status to COMPLETED. Set Current Phase to "B2. Architect Discovery".

---

### B2.0: Per-repo Discovery (parallel, Sonnet)

Phase B2.0 runs BEFORE B2's architect dispatch. It walks each repo in parallel via the `repo-discoverer` agent (Sonnet) and emits a structured `REPO_PROFILE` JSON per repo. The architect (Opus) then consumes the JSON profiles in B2 to synthesize platform.md — drastically cutting the architect's token load (each profile is ~3 KB; the architect reads ~30 KB total instead of all repos' source code).

**Pre-step — create the output directory:**

```bash
mkdir -p {workspace_root}/{slug}/runs/discover/{run_id}/outputs/repo-profiles/
```

**Cache plan — decide reuse vs rescan per repo (Win #6, head_sha-keyed):**

Before dispatching any `repo-discoverer`, ask the cache which repos still match their last-scanned `HEAD` SHA + branch + REPO_PROFILE `schema_version`. Reused profiles are copied from the prior run's outputs into this run's outputs/repo-profiles/ — no Sonnet dispatch, no token spend.

```bash
node {plugin_dir}/scripts/discover-cache.js plan \
  {workspace_root}/{slug}/runs/discover/state.json \
  {plugin_dir}/templates/blocks/repo-profile.example.json \
  '[{"repo_key":"<key>","repo_path":"<abs path>"}, ...]'
```

The script outputs JSON like:

```json
{
  "schema_version_expected": 1,
  "decisions": [
    {"repo_key": "publisher-service", "action": "reuse", "profile_path": "/abs/.../prev-run/outputs/repo-profiles/publisher-service.json", "current_head": "7066b30", "current_branch": "main", "reason": "HEAD 7066b30 unchanged since 2026-05-30T..."},
    {"repo_key": "search-svc",       "action": "rescan", "current_head": "a1b2c3d", "current_branch": "main", "cached_head": "f4e5d6c", "reason": "HEAD moved (f4e5d6c → a1b2c3d)"},
    {"repo_key": "admin-portal",     "action": "rescan", "current_head": "abc1234", "current_branch": "main", "reason": "no cache entry"}
  ],
  "stats": {"reused": 1, "rescanned": 2}
}
```

For each `action: "reuse"` decision: copy the file into this run's outputs directory and emit a one-line log so the user sees what was skipped:

```bash
cp {decision.profile_path} {run_dir}/outputs/repo-profiles/{decision.repo_key}.json
```
```
↻ Reused cached profile for {repo_key} ({reason})
```

For each `action: "rescan"` decision: dispatch `repo-discoverer` as usual (the dispatch shape below). Skip the dispatch entirely for reused repos.

**Bypass options:**
- `--refresh-cache` flag was passed to `/discover` → treat every decision as `rescan` (use the script's output but ignore the `reuse` actions). The cache is still written afterwards as usual, so the next run benefits from the fresh profiles.
- The state file is missing or corrupt → the script returns every decision as `rescan` defensively (no error, no crash).
- A reused profile's file goes missing or fails JSON parse → the script detects it and returns `rescan` for that repo.

If `stats.reused === decisions.length` (the rare case of every repo being stable), skip the entire dispatch step and proceed straight to validate. The cache is now load-bearing for `/discover --resume` on unchanged workspaces — that path should be nearly free.

**Dispatch — one `Agent` tool call per repo (only for repos with `action: "rescan"`), all in a single orchestrator message** so they run concurrently. The dispatch shape per repo:

**Tool**: `Agent`
**subagent_type**: `repo-discoverer`
**description**: `"Profile — {repo.name} ({repo.type})"`
**prompt** (substitute per repo):

```
You are profiling ONE repo for the {workspace.name} workspace. Phase B2.0 of /discover.

INPUTS:
- repo_key:         {repo.name}
- repo_path:        {repo.path}
- repo_type:        {repo.type}
- repo_role:        {repo.role}
- spec_file:        {repo.spec_file or "(none)"}
- run_dir:          {run_dir}
- workspace_slug:   {slug}

Read your system prompt's process. Walk the repo, populate the REPO_PROFILE JSON
shape (see {plugin_dir}/templates/blocks/repo-profile.example.json), and write it to:

  {run_dir}/outputs/repo-profiles/{repo.name}.json

Schema reference: {plugin_dir}/templates/blocks/block-schemas.md § REPO_PROFILE.

Keep the file under ~3 KB. Sample representative endpoints/entities — don't enumerate exhaustively. Trust your role-specific guidance in the system prompt about which fields apply (frontend_signals for frontend repos, infra_signals for cdk/terraform repos, entities + endpoints for api-services + workers).
```

Per critical rule #13: parse each agent's `<usage>` block, append a Dispatch Log row with phase `B2.0`, agent `repo-discoverer`, tokens + duration. Capture each agent's status line for the phase-done emit.

**Wait for ALL profiles to land** before advancing to B2. If any agent fails:
- Apply the standard transient-failure retry policy (`rules/transient-failures.md`).
- If a repo's profile is still missing after retry, emit a `⚠ Deferred` line and proceed to B2 with the available profiles. The architect will note the missing profile and recommend `/discover --resume` to re-attempt.

**Validate the profiles (deterministic gate — runs BEFORE the B2 architect dispatch):**

```bash
node {plugin_dir}/scripts/validate-repo-profile.js {run_dir}/outputs/repo-profiles/
```

This is the cheap catch for a Sonnet writer that truncated its JSON, wrapped it in a markdown fence, or omitted a contract key (`integrations` sub-arrays, `specs`, role-non-applicable fields that must be `null`/`[]`). Exit 0 → every profile is well-formed; proceed to B2. Exit 1 → the validator names each bad file and the specific errors:

- Re-dispatch `repo-discoverer` for ONLY the failed repo(s) as a fix round, passing the validator's error list verbatim in the prompt so the agent knows exactly what to correct. Re-validate.
- If a profile still fails after one fix round, treat it like an unrecoverable miss: emit a `⚠ Deferred` line for that repo and proceed to B2 with the valid profiles (the architect notes the gap and recommends `/discover --resume`). Do NOT feed a malformed profile into the Opus synthesis pass — a broken `integrations` block silently corrupts the topology diagrams.

Do NOT advance to B2 until the validator returns 0 for every profile that did land.

**Cache commit — record this run's profiles for the next `/discover` to reuse:**

```bash
node {plugin_dir}/scripts/discover-cache.js commit \
  {workspace_root}/{slug}/runs/discover/state.json \
  {plugin_dir}/templates/blocks/repo-profile.example.json \
  '[{"repo_key":"<key>","repo_path":"<abs path>","profile_path":"<abs path to this run's profile>"}, ...]'
```

Pass ONE record per repo whose profile landed valid (both the freshly-scanned ones AND the reused-from-cache ones — recording the reused ones updates their `scanned_at` to today, and a reused profile may still be a fresh `profile_path` if you copied it into this run's outputs). Skip repos with a `⚠ Deferred` line. The script overwrites prior entries by `repo_key` and preserves entries for repos NOT in the records list (e.g., a repo that was removed from `config.repos` this run will still have its stale cache entry — harmless).

**Phase-done emit**:

```
[phase B2.0 ✔] {N} repo profiles ready ({R} reused from cache, {S} freshly scanned), {M} audit findings collected ({duration}, {Xk} tokens — Sonnet, parallel)
```

**Update scratchpad**: Set Phase B2.0 status to COMPLETED. Set Current Phase to "B2. Architect Synthesis". Include the cache stats (`reused / rescanned`) in the phase status row so resumed runs show their cache hit rate at a glance.

---

### B2: Architect-led synthesis (Opus)

Launch the `solution-architect` agent in discovery mode. It reads the per-repo profiles produced in B2.0 (NOT raw repo code) and synthesizes the platform context — entity map, integration topology, established patterns, audit findings aggregated, the two architecture diagrams.

**Tool**: `Agent`
**subagent_type**: `solution-architect`
**description**: `"Onboard — architect synthesis for {workspace.name}"`
**prompt**:

```
MODE: discovery

You are onboarding to a new project: {workspace.name}.
{domain.domain_notes}

This invocation is DISCOVERY MODE — your output is descriptive (what exists in
this system), not prescriptive (what to build). Design-mode invocations happen
later from the /deliver pipeline and read the file you produce here. Do not
propose new architecture, refactors, or technical solutions in this mode.

**Your input is the per-repo profiles from Phase B2.0**, NOT raw repo code.
Phase B2.0 just dispatched a `repo-discoverer` agent per repo (Sonnet, parallel)
and each emitted a structured JSON profile. Your job in B2 is cross-repo
synthesis, not first-time discovery.

PROFILES TO READ (one per repo):
{for each repo in the confirmed list:}
- {repo.name}: {run_dir}/outputs/repo-profiles/{repo.name}.json

Schema for each: {plugin_dir}/templates/blocks/repo-profile.example.json
Field reference: {plugin_dir}/templates/blocks/block-schemas.md § REPO_PROFILE.

Optionally cross-check each profile against `{repo.path}/CLAUDE.md` (when it
exists). Read raw source code ONLY in these explicitly authorized cases:
  (a) a profile's `notes_for_architect` or `constraints_observed` flagged an
      ambiguity you need to resolve;
  (b) a profile flagged an entity with a non-trivial lifecycle (4+ states or
      transition-shaped method hints in `notes_for_architect`) AND your
      `## Status Lifecycles` output for that entity would otherwise be just a
      bare state list. In that case do ONE targeted read on the named service
      file to extract transitions. Do not generalize this — read only the
      flagged file, only for the flagged entity.
Don't re-walk repos the discoverer already enumerated — the profiles are
deliberately structured so you don't have to.

DOMAIN CONTEXT FROM USER:
- Name: {domain.name}
- Description: {domain.domain_notes}
- User roles: {domain.user_roles}
- Languages: {domain.i18n_languages}, RTL: {domain.rtl_support}

CROSS-REPO SYNTHESIS TASKS:
1. **Entity ownership map.** Aggregate `entities[]` from every profile. Cross-reference with `integrations.outbound_*` to identify which service OWNS each entity vs which CONSUMES it. Use the entity-level `purpose` field for the "Description" column when one is present.
2. **Integration topology.** Build the cross-repo graph from each profile's `integrations.{outbound,inbound}_*` fields. The architecture diagrams render this graph.
3. **Service Map descriptions.** The profile's top-level `description` field is a short paragraph (2–4 sentences). For the `## Service Map` table's "Description" column, use the **first sentence** of `description` verbatim — that's the one-liner the discoverer wrote so it stands alone. Then, immediately below the Service Map table, add a `### Service responsibilities` sub-section that renders the **full paragraph** for each service (Service Name as a sub-heading, full description as the body). If a profile's `description` is empty, infer one short sentence from `framework.name` + dominant entity names for the table cell, write a 1-line note for the responsibilities sub-section, and add the entity to `## Open Questions`. Don't fall back to generic stack labels.
4. **Status Lifecycles.** For each entity whose profile lists `key_states`: write the state list. If the profile flagged a non-trivial lifecycle (per the targeted-read rule above) and you spent a targeted read, render the transitions you extracted. Otherwise list states only and add a one-line note ("Transitions not captured at discovery — see {service-file}"). Do not invent transitions you didn't read.
5. **Established patterns.** Cross-tabulate `key_conventions[]` across profiles of the same stack. Patterns observed in ≥2 repos go to `## Established Patterns`. Idiosyncratic single-repo patterns stay in their repo's CLAUDE.md (which Phase C generates separately, not you).
6. **Known constraints.** Aggregate divergences (different auth styles in two services of the same stack), incomplete coverage gaps, workspace-wide inconsistencies. Each profile's `constraints_observed[]` feeds this.
7. **Audit findings consolidation.** Aggregate `audit_findings[]` from every profile into a single audit-findings.md, severity-grouped (CRITICAL / HIGH / MEDIUM / LOW), then by repo within each severity.
8. **Architecture diagrams** (two files — see diagram rules below).

OUTPUT FORMAT:
Produce the platform context document using the section structure from the template below. Fill in every section with what you discovered — leave none blank. If a section has no data (e.g., no infra repo exists), write "Not applicable — no infrastructure repo in the workspace."

The `## Architect Guidance` section is a STUB — leave it with the exact placeholder content specified below. It is meant for the user (or future onboarding passes) to fill in with workspace-specific design heuristics that future design-mode invocations should apply. Do not populate it from your own discovery; it's a human-edited slot.

TEMPLATE SECTIONS:
## Domain
## Architecture Diagram
## Entities & Ownership (table: Entity | Owning Service | Key States)
## User Roles & Permissions (table: Role | Description | Key Permissions)
## Status Lifecycles
## Service Map (table: Service | Repo | Type | Spec | Description)
## Tech Stack
## Integration Patterns
## Infrastructure Topology
## Established Patterns (all agents must know these)
## Known Constraints
## Open Questions / Evolving Decisions
## Architect Guidance

For the `## Architecture Diagram` section in platform.md, write EXACTLY this pointer content:

    The architecture is captured as two complementary diagrams under the `diagrams/` subdirectory:

    - [`diagrams/architecture-overview.mmd`](./diagrams/architecture-overview.mmd) — **high-level** C4-style
      block diagram for a new team member. ~10 nodes grouped into 4 categories
      (Frontends / Backend services / Queues / Data sources). Read this first.
    - [`diagrams/architecture.mmd`](./diagrams/architecture.mmd) — **detailed** topology with every
      service, DB, queue, Lambda, and specific edge labels. Read this when you
      need to know which endpoint / Feign client / bucket is involved.

    Both are rendered live in the site-view "Project" drawer. Edit the `.mmd`
    files directly to update; re-running `/discover` will prompt before
    overwriting a hand-edited file.

You produce **two diagrams** in this phase, with DIFFERENT rules per diagram.

**Read the full rules file FIRST**, before producing either diagram:

```
{plugin_dir}/rules/discovery-diagrams.md
```

This file contains: the 4-block taxonomy for the overview, the node shape conventions per category, the classDef palette with exact hex codes, the init directive, the 12-item self-check checklist, the lexical-safety rules, and the detailed-diagram conventions. It is the single source of truth for diagramming. Do not rely on memory or reconstruct from examples — read the file at the start of this phase.

### Diagram 1: `architecture-overview.mmd` (high-level, new-joiner friendly)

Apply the "Mermaid conventions for `architecture-overview.mmd` (high-level)" section of the rules file. Key specifics for this workspace:

- The 4 subgraphs (Frontends / Backend services / Queues / Data sources) — no others.
- Short logical labels (`auth_db` not the full `abvi_auth_db`; `books S3` not the full bucket name).
- Cylinder `[(...)]` for ALL data sources including S3, even if the label is long.
- `-->` sync with one-word label, `-.->` async with one-word label. Every edge labeled.
- Target ~10 nodes, 12-15 edges.
- Start with the init directive line from the rules file.
- **Before returning this file, walk the 12-item Self-check at the end of the rules file.** Every item must pass.

### Diagram 2: `architecture.mmd` (detailed topology)

Apply the "Mermaid conventions for `architecture.mmd` (detailed)" section of the rules file. Specifics:

- **Every service** from the Service Map as a node, grouped in `subgraph` blocks by role (Frontends, Services, Workers, Databases, Infrastructure, External).
- **External actors** (user roles, third-party services) as nodes outside the service subgraphs, drawn at the top.
- **Every edge** comes from the Integration Patterns you captured — label each edge with the endpoint prefix, queue/topic name, or resource name so a reader can audit it against the code.
- Choose `graph LR` by default; switch to `graph TB` only if the topology is clearly top-down.

### Output shape expected from you

Produce BOTH diagrams in your reply, clearly labeled, in this order:

```
<!-- BEGIN architecture-overview.mmd -->
```mermaid
%%{init: ...}%%
graph LR
  ... high-level diagram per overview rules ...
```
<!-- END architecture-overview.mmd -->

<!-- BEGIN architecture.mmd -->
```mermaid
graph LR
  ... detailed diagram per detailed rules ...
```
<!-- END architecture.mmd -->
```

Example skeleton for the **detailed** diagram (illustrates the conventions — do NOT copy literally; produce the real topology from the workspace):

```mermaid
graph LR
    User((End User))
    Admin((Admin))

    subgraph Frontends
        pub_fe[publisher-frontend<br/>react]:::frontend
        admin_fe[admin-portal<br/>nextjs]:::frontend
    end

    subgraph Services
        pub[publisher-service<br/>spring-boot]
        user_mgmt[user-management<br/>spring-boot]
        backoffice[backoffice-service<br/>spring-boot]
    end

    subgraph Workers
        event_worker[order-event-worker<br/>python-worker]:::worker
    end

    subgraph Infrastructure
        s3[(S3: book-content)]:::infra
        sqs[/SQS: order-events/]:::infra
        db[(Postgres)]:::infra
    end

    User --> pub_fe
    Admin --> admin_fe
    pub_fe -->|REST /v1/books/*| pub
    admin_fe -->|REST /v1/backoffice/*| backoffice
    pub -->|JWT validate| user_mgmt
    pub ==>|uploads| s3
    s3 -.->|ObjectCreated event| sqs
    sqs -.->|poll| event_worker
    event_worker ==>|write history| db

    classDef infra fill:#2a3a50,stroke:#5577aa,color:#ccddff;
    classDef worker fill:#3a2a50,stroke:#8855aa,color:#eeccff;
    classDef frontend fill:#2a5030,stroke:#55aa66,color:#ccffdd;
```

For the `## Architect Guidance` section, write EXACTLY this stub content (replace {workspace.name} with the actual name):

    Workspace-specific heuristics for the architect to apply in DESIGN mode
    (during /deliver pipeline invocations). Leave this stub in place if
    empty — the file still loads cleanly.

    Examples of the kind of guidance that belongs here (do NOT write these
    unless they're real for {workspace.name} — this is a template):

    - For any status-transition work, prefer extending the existing workflow
      orchestrator over adding a new service-layer state machine.
    - Cross-service writes go through the established async pattern; never
      introduce new synchronous cross-service DB writes.
    - Never propose RDS schema changes without calling out the migration
      tool (Liquibase / Flyway / Alembic) changeset explicitly.

    (Empty by default. Fill in during or after onboarding.)
```

**After the architect returns**:
1. Save the platform.md output (everything except the two mermaid blocks) to `{workspace_root}/{slug}/context/platform.md`.
2. Extract the block delimited by `<!-- BEGIN architecture-overview.mmd -->` / `<!-- END architecture-overview.mmd -->`. Strip the inner ```` ```mermaid ... ``` ```` fence and save the Mermaid source to `{workspace_root}/{slug}/context/diagrams/architecture-overview.mmd` (create `diagrams/` if it doesn't exist).
3. Extract the block delimited by `<!-- BEGIN architecture.mmd -->` / `<!-- END architecture.mmd -->`. Strip the inner ```` ```mermaid ... ``` ```` fence and save to `{workspace_root}/{slug}/context/diagrams/architecture.mmd`.
4. Verify the `## Architecture Diagram` section in platform.md contains the pointer stub pointing to BOTH files, not the full mermaid source for either.

**If either `.mmd` file already exists** (re-run or hand-edited): show a diff for that specific file and ask the user whether to overwrite, merge, or keep. Default is **keep** for each — a hand-edited diagram is load-bearing and must not be silently clobbered. The two files are treated independently: the user may choose to regenerate the overview but keep the detailed, or vice versa.

**Render check**: before marking Phase B2 complete, validate both Mermaid files parse cleanly. Run a lightweight syntax check (or defer to the site-view render error) and surface any lexical errors to the user — most common cause is a period inside a dotted-edge label (`-.LABEL.->`) which the parser swallows.

Present a summary to the user:

```
## Platform Context Generated

The architect analyzed {N} repos and discovered:
- {N} entities across {N} services
- {N} integration patterns (sync/async)
- Tech stack: {summary}
- {N} established patterns identified

Full context saved to: {workspace_root}/{slug}/context/platform.md

Review it? (yes / continue)
```

If the user says "yes", show the platform.md content.

**Update scratchpad**: Set Phase B2 status to COMPLETED. Set Current Phase to "B2.6. Observability Extraction".

---

### B2.6: Observability Extraction

Populate the `## Observability` section of `platform.md` with the OBSERVABILITY block. The block is the routing table the future `{slug}-troubleshooter` agent reads to know which log destination to query for a given `(service, env)` pair, plus operator dashboards and runbook pointers. Schema lives at [`templates/blocks/block-schemas.md#observability`](../../../templates/blocks/block-schemas.md) and the canonical example at [`templates/blocks/observability.example.json`](../../../templates/blocks/observability.example.json).

**Skip if**: the workspace has no repo with `role: "infrastructure"` AND no `mock-server` repo with a `docker-compose.yml`. In that case write an empty block (`{"log_destinations": [], "trace": {}, "dashboards": [], "runbooks": {}}`) and proceed to B3 — the troubleshooter still works (it'll ask the user to paste logs) but its routing table is empty.

---

#### Refresh mode (`--refresh-observability`)

This phase is normally entered after B2 in a fresh `/discover` run. It can also be entered standalone via `/discover --refresh-observability --workspace=<slug>` to:

- **First-time backfill** — populate the OBSERVABILITY block for a workspace that was discovered before this phase existed (the block is missing from `platform.md`).
- **Drift refresh** — re-extract from current IaC and reconcile against the existing OBSERVABILITY block (additions / removals / renames after IaC has evolved).

The phase logic below (Steps 1–5) is identical in either entry path — only the entry conditions and Step 4's write strategy differ.

**Refresh entry checklist** (only when `--refresh-observability` is the entry point — otherwise skip and use the normal phase entry from B2):

1. Resolve `{workspace_root}` via `node {plugin_dir}/scripts/workspace-root.js --get`. Halt if unset.
2. Resolve the workspace slug:
   - If `--workspace=<slug>` was passed, use it.
   - Otherwise scan `{workspace_root}/*/config.json` — if exactly one workspace exists, use it; if multiple, ask the user.
3. Validate `{workspace_root}/{slug}/config.json` with `node {plugin_dir}/scripts/validate-config.js {config-path}`. Halt on errors.
4. Detect current state of the OBSERVABILITY block in `platform.md`:
   ```bash
   node {plugin_dir}/scripts/extract-block.js {workspace_root}/{slug}/context/platform.md OBSERVABILITY
   ```
   - Exit code 0 → block exists. **Mode: drift refresh.** Save the parsed JSON for diffing in Step 4.
   - Exit code 2 (block markers absent) → block missing. **Mode: first-time backfill.**
   - Exit code 3/4 → malformed block. Surface the parse error to the user and halt — they should hand-fix or `rm` the block before re-running.
5. Confirm with the user before proceeding.

   **Drift refresh confirmation:**
   ```
   Refresh OBSERVABILITY block for workspace "{slug}"?
   Current block has {N} log destinations. The IaC extractor will re-scan
   your CDK / Terraform / k8s / docker-compose / Ansible files; you'll see
   the diff (additions / removals / renames) and approve before any write.

   Continue? (yes / no)
   ```

   **First-time backfill confirmation:**
   ```
   Workspace "{slug}" was discovered before the OBSERVABILITY block existed.
   This will run the IaC extractor and add the block to platform.md, then
   prompt you for the operational fields the extractor can't infer
   (trace correlation header, dashboards, runbooks).

   Continue? (yes / no)
   ```

6. Create a refresh run dir: `{workspace_root}/{slug}/runs/discover/{run_id}/` with `run_id = {YYYY-MM-DD-HHMMSS}-refresh-obs-{slug}`. Emit `run_start` to `checkpoints.jsonl` with `event_subtype: "refresh-observability"` so reporter agents can distinguish refresh runs from full discoveries. Skip the rest of Phase A/B1/B2/B3/C/D.
7. Proceed to Step 1 below.
8. After Step 4 (block written and validated), emit `run_end` to `checkpoints.jsonl` and skip Phase D's full verification (the workspace is already verified).

**End-of-run summary line:**

For first-time backfill:
```
[backfill obs ✔] OBSERVABILITY block written to {workspace_root}/{slug}/context/platform.md ({N} destinations, {mm:ss}, {Xk} tokens)
```

For drift refresh:
```
[refresh obs ✔] OBSERVABILITY block updated in {workspace_root}/{slug}/context/platform.md (+{A} -{R} ~{M} rows, {mm:ss}, {Xk} tokens)
```

---

**Step 1: Run the extractor (deterministic IaC parse)**

```bash
node {plugin_dir}/scripts/extract-observability.js {workspace_root}/{slug}/config.json > {workspace_root}/{slug}/.observability-draft.json
```

Recognized IaC shapes: AWS CDK TypeScript (`new logs.LogGroup`, `new lambda.Function`, `new ecs.FargateService` with `serviceName`), Terraform (`aws_cloudwatch_log_group`, `aws_lambda_function`), Kubernetes manifests (Deployment / StatefulSet / Job / CronJob / DaemonSet), `docker-compose.yml` top-level services, Ansible `ansible.builtin.systemd` units. The script emits a JSON draft matching the OBSERVABILITY block contract. The `trace`, `dashboards`, and `runbooks` sections come back empty — they need LLM curation in Step 2.

**Step 2: Curate with the user**

Present the extractor's draft to the user one section at a time. The script will not have filled the operational-knowledge fields, so prompt for each:

```
Extracted {N} log destinations from your IaC. Here they are:

{render log_destinations[] as a table: service | env | type | destination}

Three follow-ups so the troubleshooter has the full picture:

1. **Trace correlation header** — which header propagates a request ID across
   services? (e.g., `X-Request-Id`, `traceparent`, or `none — we don't propagate`)

2. **Operator dashboards** — list any dashboards the on-call would open first.
   Format: `name | url | scope (service or 'platform')`. Or `none`.

3. **Runbooks** — is there a runbook directory or index file? (e.g.,
   `docs/runbooks/README.md`). Or `none`.

Anything wrong in the extracted log_destinations table I should fix or remove?
```

Apply the user's answers to the draft JSON. The user may also flag missing rows ("we have a Kafka consumer in `infra/kafka/` you didn't pick up") — add those manually, marking `source: "user-supplied"` for the `source` field so a future `/discover --refresh` doesn't try to drift-check them.

**Step 3: Validate**

```bash
# Render the draft into platform.md first (Step 4), then validate the rendered file
node {plugin_dir}/scripts/validate-observability.js {workspace_root}/{slug}/context/platform.md
```

If the validator exits non-zero, the error list will name `log_destinations[N]: missing X`. Fix and re-validate. Do NOT proceed to B3 until the validator returns 0.

**Step 4: Write the block into platform.md**

`platform.md` can be in one of three states. Detect which, then apply the matching write strategy:

**State (a) — placeholder present** (fresh `/discover` run; the architect generated `platform.md` from the current template). Detect with:

```bash
grep -n '{{OBSERVABILITY_BLOCK}}' {workspace_root}/{slug}/context/platform.md
```

If a match is found, substitute placeholders globally (use `Edit` with `replace_all: true`):

- `{{OBSERVABILITY_BLOCK}}` → the curated JSON, pretty-printed (2-space indent)
- `{{OBSERVABILITY_PROSE}}` → a 1–2 sentence human note describing anything the table can't say (e.g., "All services log to CloudWatch under `/aws/ecs/{service}-{env}`. Trace IDs propagate via `X-Request-Id`. The Datadog dashboards above are the on-call entry points.")

**State (b) — block already exists** (drift refresh path; OBSERVABILITY block was extractable in the refresh entry checklist). The block is bracketed by `<!-- BEGIN OBSERVABILITY --> ... <!-- END OBSERVABILITY -->`. Compute the diff between the existing parsed JSON and the curated draft:

- `+ added` rows (in draft, not in existing)
- `- removed` rows (in existing, not in draft, and `source` did NOT start with `user-supplied`)
- `~ renamed/changed` rows (same `service`+`env` key, different `log_group` / `selector` / `container` / `unit` / `query`)

Present the diff to the user:
```
Observability drift detected:

  + payments-api / staging / cloudwatch /aws/ecs/payments-staging
      from infra/cdk/lib/payments-stack.ts:198
  - edge-gateway / prod / journalctl edge-gateway.service
      was at infra/ansible/roles/edge-gateway/tasks/main.yml:22 (file no longer exists)
  ~ bulk-uploader / prod / kubectl
      selector changed: app=bulk → app=bulk-uploader
      from infra/k8s/bulk-uploader/deployment.yaml:8

Apply all? (yes / review-each / no)
```

On `yes` (or after `review-each` resolves): replace the block contents between the BEGIN/END markers with the curated draft. Keep `user-supplied` rows from the existing block intact (do not let the extractor remove them). Keep the `trace`, `dashboards`, and `runbooks` sections from the existing block UNLESS the user updated them in Step 2 — those are LLM-curated, not extractor-derived, and should not be wiped on a refresh just because the extractor doesn't fill them.

**State (c) — no placeholder, no block** (first-time backfill path; workspace was discovered before B2.6 existed). Insert the entire `## Observability` section just before `## Established Patterns (all agents must know these)`:

```markdown
## Observability

> Log destinations, trace propagation, dashboards, and runbook pointers. The JSON block below is the source of truth (machine-readable); the prose under it is human commentary. Producer: `scripts/extract-observability.js` during `/discover` Phase B, curated with the user. Consumer: `{slug}-troubleshooter` agent. Schema: see [`templates/blocks/block-schemas.md`](.../templates/blocks/block-schemas.md#observability) and [`templates/blocks/observability.example.json`](.../templates/blocks/observability.example.json).

<!-- BEGIN OBSERVABILITY -->
```json
{curated draft, pretty-printed}
```
{1-2 sentence prose note}
<!-- END OBSERVABILITY -->

```

After the write (any state), run the validator (Step 3) and clean up the draft:

```bash
node {plugin_dir}/scripts/validate-observability.js {workspace_root}/{slug}/context/platform.md
rm {workspace_root}/{slug}/.observability-draft.json
```

**Step 5: Cleanup placeholders + verify markers**

```bash
grep -n '{{OBSERVABILITY' {workspace_root}/{slug}/context/platform.md
grep -cE '<!-- (BEGIN|END) OBSERVABILITY -->' {workspace_root}/{slug}/context/platform.md
```

The first command must report no matches (no unsubstituted placeholders). The second must report exactly `2` (one BEGIN, one END). If either fails, fix before continuing.

**Update scratchpad**: write a `## Observability Extraction` summary to `scratchpad.md` listing the count of rows extracted automatically vs. user-supplied (or for refresh runs: `+A -R ~M` row counts). Set Phase B2.6 status to COMPLETED. Set Current Phase to "B3. Design System Discovery" — UNLESS this was a `--refresh-observability` standalone run, in which case proceed directly to `run_end` per the refresh-mode checklist above.

---

### B3: Design System Discovery (only if frontend repo exists)

**Skip if**: no repo in the config has `role: "frontend"`. Proceed directly to Phase C.

**Design-system output location — per-repo, not workspace-wide.** Each frontend repo gets its own `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` because different frontend repos often use different component libraries (e.g., publisher-frontend on MUI, admin-portal on Ant Design). Storing at the workspace level would overwrite when the second frontend is processed. If a repo already has `agent-context/common/DESIGN_SYSTEM.md` (hand-written by the team), the discovery agent uses refresh semantics — read + merge, never destroy-and-rewrite.

**Step 1: Detect design system presence**

Run the following for each frontend repo (all signals at once per repo):

```bash
cd {frontend.path} && (
  grep -q "storybook\|@storybook" package.json 2>/dev/null && echo "HAS_STORYBOOK" || echo "NO_STORYBOOK"
  test -d .storybook && echo "HAS_STORYBOOK_DIR" || true
  grep -q "\"@mui\|\"antd\|\"@radix\|\"@chakra\|\"@mantine" package.json 2>/dev/null && echo "HAS_COMPONENT_LIB" || echo "NO_COMPONENT_LIB"
  find src -maxdepth 3 -name "tokens.*" -o -name "theme.*" -o -name "design-tokens.*" 2>/dev/null | head -3
)
```

**Step 2: If design system signals found** → dispatch a discovery agent:

**Tool**: `Agent`
**description**: `"Design system discovery — {frontend-repo-name}"`
**prompt**:

```
Read the frontend repository at {frontend.path}. Start with CLAUDE.md if it exists.

Discover the design system and answer these questions with specific file paths and component names:

1. COMPONENT LIBRARY: which one? (MUI, Ant Design, Radix, Chakra, Mantine, custom, none)
   - Version? (e.g., MUI v5 vs v6 matters for API)
   - Import pattern? (e.g., `import { Button } from '@mui/material'`)

2. STORYBOOK: does it exist?
   - Path to stories directory
   - How many components have stories?
   - Run `ls {storybook_dir}` to list available stories

3. DESIGN TOKENS: where are colors, spacing, typography defined?
   - File path (e.g., `src/theme/tokens.ts`, `tailwind.config.js`)
   - Token format (CSS vars, JS object, Tailwind classes)

4. ESTABLISHED UI PATTERNS: read 3-4 existing feature pages and identify:
   - How tables are built (which component, pagination pattern)
   - How modals/dialogs are built (which component, open/close pattern)
   - How forms are built (controlled vs uncontrolled, validation library)
   - How navigation/routing works

5. COMPONENTS TO AVOID: search for comments like "deprecated", "do not use",
   "broken", "TODO: replace". Also check if any imported components have known
   RTL issues (common: Drawer, Tooltip positioning, icon direction).

6. CUSTOMIZATION LEVEL: does the team use library components as-is, or wrap
   them in custom abstractions? (check for a `components/ui/` or `components/common/` 
   directory with thin wrappers)

Output format — structured, not narrative:

## Design System Report: {repo-name}

### Component Library
- Name: {name} v{version}
- Import pattern: `{example}`

### Storybook
- Available: yes/no
- Path: {path}
- Component count: {N}

### Design Tokens
- Location: {file path}
- Format: {CSS vars / JS object / Tailwind}
- Key tokens: {list 5-6 most-used: primary color, spacing unit, font family}

### Established Patterns
| Pattern | Component used | Example file |
|---------|---------------|-------------|
| Data tables | {component} | {path} |
| Modals/dialogs | {component} | {path} |
| Forms | {approach} | {path} |
| Navigation | {pattern} | {path} |

### Components to Avoid
| Component | Reason | Alternative |
|-----------|--------|------------|
| {name} | {why} | {use instead} |

### Customization Level
- {as-is / thin wrappers / heavy customization}
- Wrapper directory: {path or "none"}
```

**After the agent returns**: save the report to `{repo_path}/agent-context/common/DESIGN_SYSTEM.md`.

**Write semantics:**
- If `{repo_path}/agent-context/common/` does not exist yet, create it first (`mkdir -p`).
- If `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` does not exist, write the agent's output verbatim.
- If the file already exists (hand-curated by the team), show a diff and ask:
  ```
  {repo-name}/agent-context/common/DESIGN_SYSTEM.md already exists.
  (o) Overwrite — replace with what B3 discovered
  (m) Merge — dispatch a refresh pass that merges new findings into the existing file
  (s) Skip — keep the existing file untouched
  ```
  Default is **(s) Skip** if the user doesn't answer — hand-curated content is load-bearing, never silently clobber it.

**Why repo level**: each frontend uses its own component library / tokens. The UX consultant agent called during `/deliver` Phase 5b receives `repo_path: {frontend.path}` and reads the design system from that repo, so the file must live with the repo it describes.

**Step 3: If NO design system signals found** → ask the user:

```
Frontend repo "{repo-name}" has no detected design system
(no Storybook, no component library, no design tokens).

Options:
  (a) Continue without — UX consultant will recommend components
      based on what already exists in the codebase
  (b) Note as a gap — add "no established design system" to
      platform.md Known Constraints so agents are aware

Choose (a) or (b):
```

- **(a)**: write a minimal `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` stating: "No design system detected. Recommend components based on what exists in the codebase. Do not assume any component library is available — check before recommending." This ensures the UX consultant always has a file to read at `{repo_path}/agent-context/common/DESIGN_SYSTEM.md`.
- **(b)**: same as (a), plus append to `{workspace_root}/{slug}/context/platform.md` under `## Known Constraints`: "No established design system in {repo-name}. Components are ad-hoc. Consider establishing a component library + Storybook before scaling the frontend."

**Update scratchpad**: Set Phase B3 status to COMPLETED. Set Current Phase to "C. Generation".

---
