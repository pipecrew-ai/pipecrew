## Phase B2.6: Observability Extraction

Populate the `## Observability` section of `platform.md` with the OBSERVABILITY block. The block is the routing table the future `{slug}-troubleshooter` agent reads to know which log destination to query for a given `(service, env)` pair, plus operator dashboards and runbook pointers. Schema lives at [`templates/blocks/block-schemas.md#observability`](../../../templates/blocks/block-schemas.md) and the canonical example at [`templates/blocks/observability.example.json`](../../../templates/blocks/observability.example.json).

**Skip if**: the workspace has no repo with `role: "infrastructure"` AND no `mock-server` repo with a `docker-compose.yml`. In that case write an empty block (`{"log_destinations": [], "trace": {}, "dashboards": [], "runbooks": {}}`) and proceed to B3 — the troubleshooter still works (it'll ask the user to paste logs) but its routing table is empty.

---

### Refresh mode (`--refresh-observability`)

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
