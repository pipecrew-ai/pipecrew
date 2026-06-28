## Phase B2.6: Observability Extraction

Populate the workspace's observability **routing table** — the standalone sidecar `{workspace_root}/{slug}/context/observability.json` — and point `platform.md § Observability` at it (the JSON no longer lives inline in platform.md; this mirrors how the architecture diagrams are split out). The routing table is what the future `{slug}-troubleshooter` agent reads to know which log destination to query for a given `(service, env)` pair, plus operator dashboards and runbook pointers. Schema lives at [`templates/blocks/block-schemas.md#observability`](../../../templates/blocks/block-schemas.md) and the canonical example at [`templates/blocks/observability.example.json`](../../../templates/blocks/observability.example.json).

**Incremental mode** (`discover_mode == incremental`): re-run this phase **only if** a `new_repo` is `role: "infrastructure"` or otherwise carries IaC / log-destination definitions. Otherwise keep the existing `context/observability.json` untouched and proceed to B3. When it does re-run, it reads the merged config (so it sees the new repos) and merges new destinations into the existing sidecar rather than rewriting it. See `{plugin_dir}/rules/incremental-discovery.md` § "Phase B2.6".

**Skip if**: the workspace has no repo with `role: "infrastructure"` AND no `mock-server` repo with a `docker-compose.yml`. In that case write an empty sidecar `{workspace_root}/{slug}/context/observability.json` (`{"log_destinations": [], "trace": {}, "dashboards": [], "runbooks": {}}`), substitute the `{{OBSERVABILITY_PROSE}}` placeholder in platform.md with a one-line "no infra repo — routing table empty" note, and proceed to B3 — the troubleshooter still works (it'll ask the user to paste logs) but its routing table is empty.

---

### Refresh mode (`--refresh-observability`)

This phase is normally entered after B2 in a fresh `/discover` run. It can also be entered standalone via `/discover --refresh-observability --workspace=<slug>` to:

- **First-time backfill** — create `context/observability.json` for a workspace that was discovered before this routing table existed (no sidecar and no inline block).
- **Drift refresh** — re-extract from current IaC and reconcile against the existing `observability.json` (or a legacy inline block, which is migrated to the sidecar): additions / removals / renames after IaC has evolved.

The phase logic below (Steps 1–5) is identical in either entry path — only the entry conditions and Step 4's write strategy differ.

**Refresh entry checklist** (only when `--refresh-observability` is the entry point — otherwise skip and use the normal phase entry from B2):

1. Resolve `{workspace_root}` via `node {plugin_dir}/scripts/workspace-root.js --get`. Halt if unset.
2. Resolve the workspace slug:
   - If `--workspace=<slug>` was passed, use it.
   - Otherwise scan `{workspace_root}/*/config.json` — if exactly one workspace exists, use it; if multiple, ask the user.
3. Validate `{workspace_root}/{slug}/config.json` with `node {plugin_dir}/scripts/validate-config.js {config-path}`. Halt on errors.
4. Detect current state of the observability routing table:
   - If `{workspace_root}/{slug}/context/observability.json` exists → **Mode: drift refresh.** Parse it (if it's malformed JSON, surface the error and halt — the user should hand-fix or `rm` it). Save the parsed JSON for diffing in Step 4.
   - Else if a legacy inline block exists in `platform.md` (`node {plugin_dir}/scripts/extract-block.js {workspace_root}/{slug}/context/platform.md OBSERVABILITY` exits 0) → **Mode: drift refresh + migrate.** Parse the extracted block for diffing; Step 4 will write the new sidecar and replace the inline block in platform.md with a pointer. (extract-block exit 3/4 = malformed inline block → surface and halt.)
   - Else → **Mode: first-time backfill.**
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
   Workspace "{slug}" was discovered before the observability routing table existed.
   This will run the IaC extractor and write context/observability.json (and
   point platform.md at it), then prompt you for the operational fields the
   extractor can't infer (trace correlation header, dashboards, runbooks).

   Continue? (yes / no)
   ```

6. Create a refresh run dir: `{workspace_root}/{slug}/runs/discover/{run_id}/` with `run_id = {YYYY-MM-DD-HHMMSS}-refresh-obs-{slug}`. Emit `run_start` to `checkpoints.jsonl` with `event_subtype: "refresh-observability"` so reporter agents can distinguish refresh runs from full discoveries. Skip the rest of Phase A/B1/B2/B3/C/D.
7. Proceed to Step 1 below.
8. After Step 4 (sidecar written and validated), emit `run_end` to `checkpoints.jsonl` and skip Phase D's full verification (the workspace is already verified).

**End-of-run summary line:**

For first-time backfill:
```
[backfill obs ✔] observability.json written to {workspace_root}/{slug}/context/observability.json ({N} destinations, {mm:ss}, {Xk} tokens)
```

For drift refresh:
```
[refresh obs ✔] observability.json updated in {workspace_root}/{slug}/context/observability.json (+{A} -{R} ~{M} rows, {mm:ss}, {Xk} tokens)
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

Write the curated draft to the sidecar (Step 4 below), then validate the sidecar file **directly** (the validator parses `.json` straight; no extract-block step):

```bash
node {plugin_dir}/scripts/validate-observability.js {workspace_root}/{slug}/context/observability.json
```

If the validator exits non-zero, the error list will name `log_destinations[N]: missing X`. Fix and re-validate. Do NOT proceed to B3 until the validator returns 0.

**Step 4: Write the sidecar + the platform.md pointer**

The routing table is its **own file** — `{workspace_root}/{slug}/context/observability.json` — and `platform.md § Observability` only *points* at it (same pattern the architecture diagrams use). This keeps the troubleshooter's routing-table read cheap and makes validation a direct file parse.

**4a — Write the sidecar.** On a **first-time backfill** or a fresh run, write the curated JSON (pretty-printed, 2-space indent) straight to `{workspace_root}/{slug}/context/observability.json` (overwrite).

On a **drift refresh** (the sidecar — or a legacy inline block — already had content), compute the diff between the existing parsed JSON and the curated draft first:

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

On `yes` (or after `review-each` resolves): write the merged result to `observability.json`. Keep `user-supplied` rows from the existing file intact (do not let the extractor remove them). Keep the existing `trace`, `dashboards`, and `runbooks` sections UNLESS the user updated them in Step 2 — those are LLM-curated, not extractor-derived, and should not be wiped on a refresh.

**4b — Ensure `platform.md § Observability` is a pointer (not an inline block).** Detect the section's state and normalize it to the pointer form:

- **Placeholder present** (fresh `/discover` from the current template — `grep -n '{{OBSERVABILITY_PROSE}}' platform.md` matches): substitute `{{OBSERVABILITY_PROSE}}` (use `Edit`, `replace_all: true`) with a 1–2 sentence human note describing anything the table can't say (e.g., "All services log to CloudWatch under `/aws/ecs/{service}-{env}`. No request-ID correlation header — correlate by timestamp."). The template already renders the pointer to `observability.json`; there is **no** `{{OBSERVABILITY_BLOCK}}` to fill any more.
- **Legacy inline block present** (`<!-- BEGIN OBSERVABILITY --> … <!-- END OBSERVABILITY -->`, from a workspace discovered before the split): replace the entire block region — and the old "JSON block below is the source of truth" callout — with the pointer form below.
- **No section at all** (older backfill): insert the pointer section just before `## Established Patterns (all agents must know these)`.

Pointer form (used for the legacy-replace and no-section cases):

```markdown
## Observability

> The machine-readable routing table — log destinations, trace propagation, dashboards, and runbook pointers — lives in [`observability.json`](./observability.json) (source of truth, consumed by the `{slug}-troubleshooter`). The prose below is human commentary. Producer: `scripts/extract-observability.js` during `/discover` Phase B, curated with the user.

The routing table is in [`observability.json`](./observability.json) alongside this file. Read it directly when you only need log destinations / trace propagation; you do not need to load this whole file for that.

{1-2 sentence prose note}
```

**4c — Validate + clean up the draft:**

```bash
node {plugin_dir}/scripts/validate-observability.js {workspace_root}/{slug}/context/observability.json
rm {workspace_root}/{slug}/.observability-draft.json
```

**Step 5: Verify the sidecar + pointer**

```bash
test -s {workspace_root}/{slug}/context/observability.json && echo "sidecar OK"
grep -c 'observability.json' {workspace_root}/{slug}/context/platform.md          # pointer present? (≥1)
grep -cE '<!-- (BEGIN|END) OBSERVABILITY -->' {workspace_root}/{slug}/context/platform.md   # must be 0 — no inline block left
grep -n '{{OBSERVABILITY' {workspace_root}/{slug}/context/platform.md             # must be empty — no unsubstituted placeholders
```

`observability.json` must be non-empty and valid; `platform.md` must contain the `observability.json` pointer, **zero** `<!-- BEGIN/END OBSERVABILITY -->` markers (the inline block is gone or was never there), and no unsubstituted `{{OBSERVABILITY...}}` placeholders. If any check fails, fix before continuing.

**Update scratchpad**: write a `## Observability Extraction` summary to `scratchpad.md` listing the count of rows extracted automatically vs. user-supplied (or for refresh runs: `+A -R ~M` row counts). Set Phase B2.6 status to COMPLETED. Set Current Phase to "B3. Design System Discovery" — UNLESS this was a `--refresh-observability` standalone run, in which case proceed directly to `run_end` per the refresh-mode checklist above.
