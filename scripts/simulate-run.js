#!/usr/bin/env node
/**
 * simulate-run.js — generate the demo workspace at
 *   {workspace_root}/simulate-run-demo/
 * with full /discover + /deliver + /learn artifacts following the latest
 * plugin schema (Phase 8 PR publish, pr_urls.json, learn runs,
 * architecture diagrams, design-system pointers).
 *
 * Each invocation WIPES and recreates the demo workspace. Run IDs are fixed
 * so a re-run overwrites the prior demo files in place — no timestamped
 * directories accumulate. This keeps the demo workspace stable across
 * re-runs and exercises every section of the site-view project drawer.
 *
 * Data sourcing:
 *   - Default: every artifact is synthesized from inline templates.
 *   - If a real workspace exists under {workspace_root}/* (other than
 *     simulate-run-demo) and contains a recent /deliver run, that run's
 *     scratchpad.md and report.md are copied (with run_id renamed) into
 *     the demo as a "realistic" /deliver run alongside the synthesized one.
 *
 * Usage:
 *   node simulate-run.js                          generate demo workspace AND spawn site-view (default)
 *   node simulate-run.js --no-ui                  generate-only; skip site-view spawn
 *   node simulate-run.js --launch-ui              explicit (default — no-op, kept for clarity)
 *   node simulate-run.js --port=5180              site-view start port
 *   node simulate-run.js --keep                   skip the wipe (incremental dev)
 *   node simulate-run.js --step-ms=0              static mode (UI mounts on COMPLETED run)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { resolveRoot: resolveWorkspaceRoot } = require('./workspace-root');

// ─── CLI args ─────────────────────────────────────────────────
// UI launch is now the default — spawning the site-view IS the point of the
// simulator most of the time. Pass --no-ui for headless generation.
let launchUi = true;
let port = 5173;
let keep = false;
let stepMsArg = null; // null = use default; numeric = override
for (const arg of process.argv.slice(2)) {
  if (arg === '--launch-ui') launchUi = true;       // explicit (default behaviour, no-op)
  else if (arg === '--no-ui') launchUi = false;     // opt-out — generate-only
  else if (arg.startsWith('--port=')) port = parseInt(arg.slice(7), 10);
  else if (arg === '--keep') keep = true;
  else if (arg.startsWith('--step-ms=')) stepMsArg = parseInt(arg.slice(10), 10);
}
// Default: when launching UI, step through the live timeline at 1500ms/step
// so the user can see characters move queued → working → done. Without UI,
// no stepping (the historical/synthesized runs are the artifact).
// Override either way with --step-ms=<n>; --step-ms=0 forces static mode.
const STEP_MS = stepMsArg !== null ? stepMsArg : (launchUi ? 1500 : 0);
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ─── Constants ────────────────────────────────────────────────
const WORKSPACE_NAME = 'Demo Workspace';
const WORKSPACE_SLUG = 'simulate-run-demo';
const WORKSPACE_ROOT = resolveWorkspaceRoot();
const WS_DIR = path.join(WORKSPACE_ROOT, WORKSPACE_SLUG);

// Fixed run IDs — re-runs overwrite these in place.
const RUN_IDS = {
  discover: '2026-04-25-100000-simulate-run-demo',
  deliver_a: '2026-04-25-110000-bulk-upload',
  deliver_b: '2026-04-25-120000-contract-modals',
  learn_a:   '2026-04-25-130000-pr-142',
  learn_b:   '2026-04-25-140000-run-bulk-upload',
};

// ─── Filesystem helpers ───────────────────────────────────────
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function write(p, body) { fs.writeFileSync(p, body); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function appendJsonl(p, ev) { fs.appendFileSync(p, JSON.stringify(ev) + '\n'); }

// ─── Sample Phase 1 / Phase 2 doc generators ──────────────────
// These produce realistic-shape content for the demo workspace's two
// /deliver runs (Bulk Upload + Contract Modals) so the site-view's
// drawer + downstream tooling can render the full schema. The shape
// matches what the real product-owner / solution-architect produce in
// /deliver Phase 1 / Phase 2 — including the BEGIN/END section markers
// and the REQUIREMENTS_INDEX / TASK_SKELETON / AFFECTED_SERVICES JSON
// blocks consumers extract via scripts/extract-block.js.

const PHASE1_SAMPLES = {
  'bulk-upload': `# Feature: Bulk Upload

<!-- BEGIN OVERVIEW -->
## Overview
- **User Story**: As a Publisher, I want to upload up to 50 PDF book files in one batch so I can submit my catalog without one-at-a-time uploads.
- **Business Value**: Cuts publisher onboarding time from ~8 hours (one-at-a-time) to ~10 minutes for a typical 50-book catalog.
- **Affected Roles**: Publisher (primary), ALC Manager (secondary — sees the new books in review queue).
<!-- END OVERVIEW -->

<!-- BEGIN FUNCTIONAL_REQUIREMENTS -->
## Functional Requirements
- FR-1: Publisher can upload up to 50 PDF files in a single bulk request, max 100MB per file.
- FR-2: Each file is associated with a Book entity created in DRAFT state.
- FR-3: Upload validates file format (PDF only) and size limit before persistence.
- FR-4: Successful upload returns a per-file response with the new Book id and S3 location.
- FR-5: Failed files in the batch don't block successful files — partial-success returns per-file status.
- FR-6: Search-svc indexes each new Book within 30s of upload via the \`book.uploaded\` event.
- FR-7: Frontend shows per-file upload progress and per-file success/failure on completion.
- FR-8: Only the publisher who initiated the batch can see its files (ownership enforcement).
<!-- END FUNCTIONAL_REQUIREMENTS -->

<!-- BEGIN EDGE_CASES -->
## Edge Cases & Error Handling
- EC-1: Reject files larger than 100MB with HTTP 413 Payload Too Large per file.
- EC-2: Reject non-PDF files with HTTP 400 — error message names the offending filename.
- EC-3: Batches over 50 files are rejected with HTTP 400 before any persistence.
- EC-4: Partial S3 upload failure (network drop mid-batch) — retry that file once, mark failed if retry also fails.
- EC-5: Publisher session expires mid-upload — return HTTP 401, frontend prompts re-login and offers to resume the batch.
<!-- END EDGE_CASES -->

<!-- BEGIN OUT_OF_SCOPE -->
## Out of Scope
- Bulk delete or bulk status change. Single-book operations remain the path for non-create cases.
- Background scheduling — uploads are synchronous-respond, not deferred to a queue.
- Auto-retry of failed files. The user re-attempts via UI.
<!-- END OUT_OF_SCOPE -->

<!-- BEGIN REQUIREMENTS_INDEX -->
\`\`\`json
{
  "requirements": [
    { "id": "FR-1", "summary": "Publisher uploads up to 50 PDFs in one batch, max 100MB per file" },
    { "id": "FR-2", "summary": "Each file becomes a Book in DRAFT state" },
    { "id": "FR-3", "summary": "Upload validates format + size before persistence" },
    { "id": "FR-4", "summary": "Per-file response includes new Book id + S3 location" },
    { "id": "FR-5", "summary": "Per-file partial-success — failures don't block successes" },
    { "id": "FR-6", "summary": "Search-svc indexes each new Book within 30s via book.uploaded SQS event" },
    { "id": "FR-7", "summary": "Frontend shows per-file progress + per-file success/failure" },
    { "id": "FR-8", "summary": "Only initiating publisher can see batch files" }
  ],
  "edge_cases": [
    { "id": "EC-1", "summary": "Reject files >100MB with HTTP 413", "applies_to": ["FR-1", "FR-3"] },
    { "id": "EC-2", "summary": "Reject non-PDF files with HTTP 400", "applies_to": ["FR-3"] },
    { "id": "EC-3", "summary": "Reject batches >50 files with HTTP 400 before persistence", "applies_to": ["FR-1"] },
    { "id": "EC-4", "summary": "Retry single S3 upload failure once, mark failed if retry fails", "applies_to": ["FR-5"] },
    { "id": "EC-5", "summary": "Session expiry mid-upload returns 401; frontend prompts re-login", "applies_to": ["FR-7"] }
  ]
}
\`\`\`
<!-- END REQUIREMENTS_INDEX -->
`,

  'contract-modals': `# Feature: Contract Modals

<!-- BEGIN OVERVIEW -->
## Overview
- **User Story**: As an ALC Manager, I want to view contract details inline in a modal so I don't lose the list context when reviewing one contract.
- **Business Value**: Replaces three nav-out routes with inline modals — cuts contract-review clicks per session by ~40% and keeps the table state intact.
- **Affected Roles**: ALC Manager (primary), Publisher (sees a read-only modal).
<!-- END OVERVIEW -->

<!-- BEGIN FUNCTIONAL_REQUIREMENTS -->
## Functional Requirements
- FR-1: ALC Manager can open a contract detail modal from the contract list row without leaving the list page.
- FR-2: Modal shows contract type, status, parties, dates, and the linked book's title.
- FR-3: Modal supports closing via Escape key, clicking outside, or the close button.
- FR-4: Publisher sees a read-only version of the same modal; no edit affordances render.
- FR-5: Backend exposes \`GET /api/v1/contracts/{id}/detail\` returning the full record needed by the modal.
<!-- END FUNCTIONAL_REQUIREMENTS -->

<!-- BEGIN EDGE_CASES -->
## Edge Cases & Error Handling
- EC-1: Contract not found (404) — modal shows "This contract no longer exists" and a Close button.
- EC-2: User loses permission mid-session — modal closes and the list re-fetches.
- EC-3: Rapid open/close interactions — debounce so we don't fire 5 detail fetches.
<!-- END EDGE_CASES -->

<!-- BEGIN OUT_OF_SCOPE -->
## Out of Scope
- Edit-in-modal. The Edit action navigates to the existing edit page (existing behavior preserved).
- Contract creation flow. This feature is read-only display.
<!-- END OUT_OF_SCOPE -->

<!-- BEGIN REQUIREMENTS_INDEX -->
\`\`\`json
{
  "requirements": [
    { "id": "FR-1", "summary": "ALC Manager opens contract detail modal from list row without leaving the page" },
    { "id": "FR-2", "summary": "Modal shows type, status, parties, dates, linked book title" },
    { "id": "FR-3", "summary": "Modal closes via Escape, outside click, or close button" },
    { "id": "FR-4", "summary": "Publisher sees read-only modal — no edit affordances" },
    { "id": "FR-5", "summary": "Backend exposes GET /api/v1/contracts/{id}/detail with joined data" }
  ],
  "edge_cases": [
    { "id": "EC-1", "summary": "Not found (404) — modal shows graceful empty state", "applies_to": ["FR-1", "FR-5"] },
    { "id": "EC-2", "summary": "Permission lost mid-session — modal closes, list re-fetches", "applies_to": ["FR-4"] },
    { "id": "EC-3", "summary": "Debounce rapid open/close to avoid duplicate fetches", "applies_to": ["FR-1"] }
  ]
}
\`\`\`
<!-- END REQUIREMENTS_INDEX -->
`,
};

const PHASE2_SAMPLES = {
  'bulk-upload': `# Technical Design — Bulk Upload

<!-- BEGIN AFFECTED_CONTRACTS -->
\`\`\`json
{
  "contracts": [
    {
      "repo_key": "book-events",
      "format": "avro",
      "rationale": "Bulk endpoint emits a new batch-uploaded event for downstream indexing",
      "files": [
        {
          "path": "schemas/book.batch.uploaded.avsc",
          "change_kind": "added",
          "classification": "additive",
          "summary": "New event type — no existing consumers"
        }
      ]
    }
  ],
  "edit_order": ["book-events"],
  "breaking_changes_authorized": false
}
\`\`\`

## Notes
- **book-events**: introduces \`book.batch.uploaded\` so search-svc and any future batch-aware consumer can subscribe.
<!-- END AFFECTED_CONTRACTS -->

<!-- BEGIN AFFECTED_SERVICES -->
\`\`\`json
{
  "services": [
    {
      "name": "publisher-service",
      "spec_policy": "api-first",
      "endpoints_added": [
        { "method": "POST", "path": "/api/v1/books/bulk" }
      ],
      "endpoints_modified": [],
      "handlers_added": [],
      "fr_ids": ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-8"],
      "ec_ids": ["EC-1", "EC-2", "EC-3", "EC-4"]
    },
    {
      "name": "search-service",
      "spec_policy": "no-api",
      "endpoints_added": [],
      "endpoints_modified": [],
      "handlers_added": ["handle_book_uploaded"],
      "fr_ids": ["FR-6"],
      "ec_ids": []
    }
  ],
  "spec_edit_order": ["publisher-service"],
  "frontend_required": true,
  "mock_required": true
}
\`\`\`

## Notes
- **publisher-service**: owns the new bulk endpoint + per-file persistence + S3 upload orchestration.
- **search-service**: already consumes \`book.uploaded\` per-record events; no change needed for the indexing path.

## Spec Edit Order — rationale
Single api-first service; trivial.

## Frontend / Mock notes
Frontend integrates the new endpoint via an \`useBulkUpload()\` hook. Mock mirrors the per-file response shape including the partial-success case.
<!-- END AFFECTED_SERVICES -->

<!-- BEGIN ARCHITECTURE_DECISION -->
## Architecture Decision
The bulk endpoint orchestrates per-file persistence in a synchronous request — files are validated, persisted to RDS + S3, and emit the \`book.uploaded\` event individually as each succeeds. Per-file partial-success is captured in the response array. **Runner-up considered**: deferring uploads to an SQS queue with a polling-status endpoint. Rejected because publishers expect a synchronous per-file outcome, and the latency tail (50 × 100MB ≈ 30s end-to-end at typical S3 throughput) is acceptable.
<!-- END ARCHITECTURE_DECISION -->

<!-- BEGIN DATA_MODEL -->
## Data Model
- **Book** (existing): no schema change. New rows persist with status DRAFT.
- **BulkUploadRequest** (NEW): tracks the batch envelope.
  - id (UUID, PK)
  - publisher_id (FK)
  - file_count, success_count, failure_count
  - submitted_at (timestamp)
- **Migrations**: one Liquibase changeset adds \`bulk_upload_request\` table with FK index on publisher_id.
<!-- END DATA_MODEL -->

<!-- BEGIN API_DESIGN -->
## API Design

### POST /api/v1/books/bulk
- **Auth**: Publisher
- **Request**: multipart/form-data, field name \`files\` (1–50 entries), each ≤ 100MB
- **Response 200**: \`BulkUploadResponse { batch_id, results: BulkUploadResult[] }\`
- **BulkUploadResult**: \`{ filename, status: "success" | "failed", book_id?, s3_url?, error? }\`
- **Errors**: 400 (>50 files, non-PDF, oversized — at the batch level), 401 (session expiry), 413 (per-file size — surfaced inline in the result array)
<!-- END API_DESIGN -->

<!-- BEGIN FRONTEND_ARCHITECTURE -->
\`\`\`json
{
  "components": [
    { "name": "BulkUploadPage", "path": "src/features/bulk-upload/pages/BulkUploadPage.tsx", "kind": "page", "change_kind": "added", "purpose": "Page shell + role guard for the bulk upload flow", "children": ["BulkUploadDropzone", "BulkUploadProgressList"] },
    { "name": "BulkUploadDropzone", "path": "src/features/bulk-upload/components/BulkUploadDropzone.tsx", "kind": "component", "change_kind": "added", "purpose": "Drag-and-drop + multi-file picker", "children": [] },
    { "name": "BulkUploadProgressList", "path": "src/features/bulk-upload/components/BulkUploadProgressList.tsx", "kind": "component", "change_kind": "added", "purpose": "Per-file progress and final success/failure status", "children": [] },
    { "name": "useBulkUpload", "path": "src/features/bulk-upload/hooks/useBulkUpload.ts", "kind": "hook", "change_kind": "added", "purpose": "React Query mutation streaming per-file progress via XHR upload events", "children": [] }
  ],
  "routes": [
    { "path": "/publisher/books/bulk-upload", "change_kind": "added", "page_component": "BulkUploadPage", "guard": "publisher" }
  ],
  "api_integration": [
    { "service_function": "uploadBulk", "file": "src/features/bulk-upload/api/services.ts", "endpoint": "POST /api/v1/books/bulk", "request_type": "BulkUploadRequest", "response_type": "BulkUploadResponse" }
  ]
}
\`\`\`

## Frontend Architecture — detail (prose)

### State Management
React Query mutation \`uploadBulk\` with per-file optimistic updates. No global context — per-page \`useBulkUpload\` hook owns the queue state. Form-state via plain React state (file list is the form).

### i18n key additions
- \`bulk_upload.title\`
- \`bulk_upload.dropzone_help\`
- \`bulk_upload.queue.row.progress\`
- \`bulk_upload.errors.file_too_large\`
- \`bulk_upload.errors.invalid_type\`
- \`bulk_upload.errors.batch_too_large\`

### Styling notes
Reuse the existing design-system primitives. RTL: progress bars fill right-to-left in Arabic; close icons mirror.
<!-- END FRONTEND_ARCHITECTURE -->

<!-- BEGIN INFRASTRUCTURE_IMPACT -->
## Infrastructure Impact
- **publisher-service ECS task**: bump request body size limit at the load-balancer to 5 GB (50 × 100MB).
- **books-bucket-{stage} S3**: no change — multipart upload with existing IAM role.
- **No new queues**: existing \`book-events\` queue is reused.
- **CloudWatch**: add a metric filter for "bulk_upload_partial_failure" log line for ops visibility.
<!-- END INFRASTRUCTURE_IMPACT -->

<!-- BEGIN IMPLEMENTATION_ORDER -->
## Implementation Order
1. Phase 3a: contract addition (\`book.batch.uploaded.avsc\`).
2. Phase 3b: spec edit (publisher-service \`POST /books/bulk\`).
3. Phase 5a: backend (publisher-service migration + endpoint).
4. Phase 5b: frontend (in parallel with 5a).
5. Phase 5c: mock.
6. Phase 5d: infra (ALB body size bump + CloudWatch filter).
<!-- END IMPLEMENTATION_ORDER -->

<!-- BEGIN RISKS -->
\`\`\`json
{
  "risks": [
    { "id": "R-1", "summary": "Latency tail for max-size batches around 30 seconds", "severity": "medium", "mitigation": "Per-file streaming progress in the response so the UI stays informative" },
    { "id": "R-2", "summary": "Memory pressure on the ECS task during 50-file in-flight uploads", "severity": "medium", "mitigation": "Stream files directly to S3 without buffering in the service; alert on container memory >80%" }
  ],
  "deferred_items": [
    { "id": "DEF-1", "tag": "follow-up", "summary": "Auto-stream directly to S3 without intermediate buffering", "rationale": "Land if post-launch memory metrics show pressure; current allocation is sized for the projected load", "owning_repo": "publisher-service" },
    { "id": "DEF-2", "tag": "v2", "summary": "Re-upload only the failed files from a batch", "rationale": "v1 ships per-file failure surface; the re-upload UX needs its own design pass", "owning_repo": "publisher-frontend" }
  ]
}
\`\`\`

## Risks & Trade-offs — detail (prose)
Alternative considered: chunked-upload protocol (tus.io) for resumability. Rejected for v1 because the 100 MB per-file cap keeps each upload under typical session lifetime; reconsider if files grow.
<!-- END RISKS -->

<!-- BEGIN TASK_SKELETON -->
\`\`\`json
{
  "feature_summary": "publishers upload up to 50 PDFs in one batch with per-file partial-success",
  "tasks": [
    {
      "repo_key": "publisher-service",
      "repo_role": "api-service",
      "spec_policy": "api-first",
      "sub_tasks": [
        { "id_hint": "be-migration", "title": "Liquibase changeset for bulk_upload_request", "tier": "M", "fr_refs": ["FR-2"], "summary": "new table + FK index" },
        { "id_hint": "be-dtos", "title": "DTOs / Models", "tier": "M", "fr_refs": ["FR-1", "FR-4", "FR-5"], "summary": "BulkUploadRequest entity + BulkUploadResult DTO + response wrapper" },
        { "id_hint": "be-service", "title": "Service layer", "tier": "M", "fr_refs": ["FR-2", "FR-3", "FR-4", "FR-5", "FR-8"], "summary": "validate + persist per-file + emit per-file events + ownership check" },
        { "id_hint": "be-controller", "title": "Controller endpoint", "tier": "M", "fr_refs": ["FR-1"], "summary": "POST /books/bulk with multipart parsing" },
        { "id_hint": "be-tests", "title": "Tests", "tier": "M", "fr_refs": ["FR-1", "FR-3", "FR-5"], "summary": "unit (validator) + integration (50 valid + 5 invalid)" },
        { "id_hint": "be-stream", "title": "Stream files to S3 without buffering", "tier": "D", "fr_refs": ["FR-1"], "summary": "memory optimization", "deferral_reason": "RISKS §1 — only if memory metrics show pressure post-launch" }
      ]
    },
    {
      "repo_key": "frontend",
      "repo_role": "frontend",
      "spec_policy": "n/a",
      "sub_tasks": [
        { "id_hint": "fe-api", "title": "API layer (types + service)", "tier": "M", "fr_refs": ["FR-1", "FR-4"], "summary": "BulkUploadRequest / Response types + uploadBulk()" },
        { "id_hint": "fe-hook", "title": "useBulkUpload hook", "tier": "M", "fr_refs": ["FR-7"], "summary": "React Query mutation with per-file XHR progress" },
        { "id_hint": "fe-dropzone", "title": "BulkUploadDropzone component", "tier": "M", "fr_refs": ["UX-1"], "summary": "drag-and-drop + multi-file picker" },
        { "id_hint": "fe-progress", "title": "BulkUploadProgressList component", "tier": "M", "fr_refs": ["UX-2", "UX-3", "FR-7"], "summary": "per-file progress bars + final status icons" },
        { "id_hint": "fe-page", "title": "Page + routing", "tier": "M", "fr_refs": ["FR-1"], "summary": "BulkUploadPage + role guard" },
        { "id_hint": "fe-i18n", "title": "i18n keys", "tier": "M", "fr_refs": ["UX-4"], "summary": "en + ar" },
        { "id_hint": "fe-tests", "title": "Tests", "tier": "M", "fr_refs": ["FR-7"], "summary": "hook + component tests with msw" },
        { "id_hint": "fe-retry", "title": "Re-upload-failed-only affordance", "tier": "D", "fr_refs": ["FR-5"], "summary": "v2 UX — selective retry button", "deferral_reason": "RISKS §2 — out of scope for this slice" }
      ]
    },
    {
      "repo_key": "mock-server",
      "repo_role": "mock-server",
      "spec_policy": "n/a",
      "sub_tasks": [
        { "id_hint": "mock-data", "title": "Mock data + scenarios", "tier": "M", "fr_refs": ["FR-1", "FR-5"], "summary": "happy path + 5-failure scenario" },
        { "id_hint": "mock-handler", "title": "Endpoint handler", "tier": "M", "fr_refs": ["FR-1"], "summary": "POST /books/bulk with per-file response shape" }
      ]
    },
    {
      "repo_key": "infra",
      "repo_role": "infrastructure",
      "spec_policy": "n/a",
      "sub_tasks": [
        { "id_hint": "infra-alb", "title": "ALB body size bump", "tier": "M", "fr_refs": ["FR-1"], "summary": "5 GB max-body on the publisher-service listener" },
        { "id_hint": "infra-metric", "title": "CloudWatch metric filter", "tier": "M", "fr_refs": ["FR-5"], "summary": "filter on bulk_upload_partial_failure log line" }
      ]
    }
  ]
}
\`\`\`
<!-- END TASK_SKELETON -->
`,

  'contract-modals': `# Technical Design — Contract Modals

<!-- BEGIN AFFECTED_CONTRACTS -->
\`\`\`json
{
  "contracts": [],
  "edit_order": [],
  "breaking_changes_authorized": false
}
\`\`\`

## Notes
No contract repos affected — this feature is read-only display backed by existing schemas.
<!-- END AFFECTED_CONTRACTS -->

<!-- BEGIN AFFECTED_SERVICES -->
\`\`\`json
{
  "services": [
    {
      "name": "demo-backend",
      "spec_policy": "api-first",
      "endpoints_added": [
        { "method": "GET", "path": "/api/v1/contracts/{id}/detail" }
      ],
      "endpoints_modified": [],
      "handlers_added": [],
      "fr_ids": ["FR-5"],
      "ec_ids": ["EC-1"]
    }
  ],
  "spec_edit_order": ["demo-backend"],
  "frontend_required": true,
  "mock_required": true
}
\`\`\`

## Notes
Single backend change — a join endpoint that returns the contract record plus the linked Book title and party display names so the modal needs one fetch instead of three.

## Frontend / Mock notes
Frontend builds a generic Modal primitive and a ContractDetailModal that consumes the new endpoint.
<!-- END AFFECTED_SERVICES -->

<!-- BEGIN ARCHITECTURE_DECISION -->
## Architecture Decision
Server-side join in the new \`/detail\` endpoint instead of three client-side fetches. Cuts modal-open latency by ~600ms and avoids an N+1 across the contract list. **Runner-up**: GraphQL-style field selection. Rejected — workspace doesn't have a GraphQL infrastructure and the cost of introducing one for a single endpoint is unjustified.
<!-- END ARCHITECTURE_DECISION -->

<!-- BEGIN DATA_MODEL -->
## Data Model
No schema change. The \`/detail\` endpoint joins existing tables (Contract, Book, Party) read-only.
<!-- END DATA_MODEL -->

<!-- BEGIN API_DESIGN -->
## API Design

### GET /api/v1/contracts/{id}/detail
- **Auth**: ALC Manager (full read) or Publisher (own contracts only — same scoping as the list endpoint)
- **Response 200**: \`ContractDetail { id, type, status, parties: PartyDisplay[], dates, book: { id, title } }\`
- **Errors**: 404 if the contract isn't visible to the caller, 401 on auth failure
<!-- END API_DESIGN -->

<!-- BEGIN FRONTEND_ARCHITECTURE -->
\`\`\`json
{
  "components": [
    { "name": "Modal", "path": "src/components/ui/Modal.tsx", "kind": "component", "change_kind": "added", "purpose": "Reusable modal primitive with focus-trap and Escape-to-close", "children": [] },
    { "name": "ContractDetailModal", "path": "src/features/contracts/ContractDetailModal.tsx", "kind": "component", "change_kind": "added", "purpose": "Renders contract detail inside the Modal primitive; role-aware action footer", "children": ["Modal"] },
    { "name": "useContractDetail", "path": "src/features/contracts/useContractDetail.ts", "kind": "hook", "change_kind": "added", "purpose": "React Query hook fetching one contract's detail by id", "children": [] }
  ],
  "routes": [],
  "api_integration": [
    { "service_function": "getContractDetail", "file": "src/api/contracts.ts", "endpoint": "GET /api/v1/contracts/{id}/detail", "request_type": "GetContractDetailParams", "response_type": "ContractDetail" }
  ]
}
\`\`\`

## Frontend Architecture — detail (prose)

### State Management
React Query \`useContractDetail(id)\` with id-keyed cache. The list-row click handler swaps the existing \`navigate('/contracts/{id}')\` call for opening the modal with the row's id.

### i18n key additions
- \`contracts.modal.title\`
- \`contracts.modal.close\`
- \`contracts.modal.errors.not_found\`

### Styling notes
Modal primitive sets the workspace a11y baseline (focus trap, Escape, aria-modal). RTL: close button flips to the right.
<!-- END FRONTEND_ARCHITECTURE -->

<!-- BEGIN INFRASTRUCTURE_IMPACT -->
## Infrastructure Impact
None — pure code change.
<!-- END INFRASTRUCTURE_IMPACT -->

<!-- BEGIN IMPLEMENTATION_ORDER -->
## Implementation Order
1. Phase 3b: spec edit (demo-backend new endpoint).
2. Phase 5a: backend (read-only join service + controller).
3. Phase 5b: frontend Modal primitive + ContractDetailModal.
4. Phase 5c: mock.
<!-- END IMPLEMENTATION_ORDER -->

<!-- BEGIN RISKS -->
\`\`\`json
{
  "risks": [
    { "id": "R-1", "summary": "Join endpoint must enforce the same caller-can-see-this-contract rule the list endpoint uses", "severity": "high", "mitigation": "Reuse the existing ownership filter in the service layer; reviewer's Pattern Adherence pass catches misuse" },
    { "id": "R-2", "summary": "Modal accessibility is load-bearing for the workspace's a11y baseline", "severity": "medium", "mitigation": "Focus trap + Escape are non-negotiable; UX consultant must verify against the design-system contract" }
  ],
  "deferred_items": [
    { "id": "DEF-1", "tag": "out-of-scope", "summary": "Edit-in-modal — modal stays read-only", "rationale": "Clicking Edit navigates to the existing edit page; in-modal editing is a separate UX project", "owning_repo": "demo-frontend" }
  ]
}
\`\`\`

## Risks & Trade-offs — detail (prose)
Alternative considered: render the same modal in a side drawer instead. Rejected because the design system's modal primitive is already standardized and lower-friction to adopt.
<!-- END RISKS -->

<!-- BEGIN TASK_SKELETON -->
\`\`\`json
{
  "feature_summary": "ALC managers and publishers view contract detail in an inline modal",
  "tasks": [
    {
      "repo_key": "demo-backend",
      "repo_role": "api-service",
      "spec_policy": "api-first",
      "sub_tasks": [
        { "id_hint": "be-dto", "title": "DTO", "tier": "M", "fr_refs": ["FR-5"], "summary": "ContractDetail response DTO with joined fields" },
        { "id_hint": "be-service", "title": "Service layer (read-only join)", "tier": "M", "fr_refs": ["FR-5"], "summary": "fetch contract + book + parties; enforce ownership" },
        { "id_hint": "be-controller", "title": "Controller endpoint", "tier": "M", "fr_refs": ["FR-5"], "summary": "GET /contracts/{id}/detail" },
        { "id_hint": "be-tests", "title": "Tests", "tier": "M", "fr_refs": ["FR-5"], "summary": "happy path + 404 for non-visible contract" }
      ]
    },
    {
      "repo_key": "demo-frontend",
      "repo_role": "frontend",
      "spec_policy": "n/a",
      "sub_tasks": [
        { "id_hint": "fe-modal-primitive", "title": "Modal primitive", "tier": "M", "fr_refs": ["FR-3", "UX-1"], "summary": "focus-trap + Escape handler + backdrop" },
        { "id_hint": "fe-hook", "title": "useContractDetail hook", "tier": "M", "fr_refs": ["FR-2"], "summary": "React Query fetcher" },
        { "id_hint": "fe-modal", "title": "ContractDetailModal component", "tier": "M", "fr_refs": ["FR-1", "FR-2", "FR-4", "UX-2"], "summary": "role-aware action footer" },
        { "id_hint": "fe-wireup", "title": "Wire row click → modal open", "tier": "M", "fr_refs": ["FR-1"], "summary": "replace navigate call in list" },
        { "id_hint": "fe-i18n", "title": "i18n keys", "tier": "M", "fr_refs": ["UX-4"], "summary": "en + ar" },
        { "id_hint": "fe-tests", "title": "Tests", "tier": "M", "fr_refs": ["FR-1", "FR-3", "FR-4"], "summary": "open + close + role-based footer" }
      ]
    },
    {
      "repo_key": "demo-mock",
      "repo_role": "mock-server",
      "spec_policy": "n/a",
      "sub_tasks": [
        { "id_hint": "mock-data", "title": "Mock data", "tier": "M", "fr_refs": ["FR-2"], "summary": "ContractDetail fixture with joined book + parties" },
        { "id_hint": "mock-handler", "title": "Endpoint handler", "tier": "M", "fr_refs": ["FR-5"], "summary": "GET /contracts/{id}/detail" }
      ]
    }
  ]
}
\`\`\`
<!-- END TASK_SKELETON -->
`,
};

function generatePhase1Doc(featureName, featureSlug) {
  return PHASE1_SAMPLES[featureSlug]
    || `# Feature: ${featureName}\n\nFR-1 through FR-12 + EC-1 through EC-8 (synthesized — sample stub for an unrecognized feature slug).\n`;
}

function generatePhase2Doc(featureName, featureSlug) {
  return PHASE2_SAMPLES[featureSlug]
    || `# Technical Design — ${featureName}\n\nSynthesized stub for an unrecognized feature slug. Real /deliver Phase 2 emits AFFECTED_SERVICES, ARCHITECTURE_DECISION, DATA_MODEL, API_DESIGN, FRONTEND_ARCHITECTURE, INFRASTRUCTURE_IMPACT, IMPLEMENTATION_ORDER, RISKS, and TASK_SKELETON sections.\n`;
}

// ─── Wipe (unless --keep) ─────────────────────────────────────
if (!keep && fs.existsSync(WS_DIR)) {
  console.log(`[sim] wiping ${WS_DIR}`);
  fs.rmSync(WS_DIR, { recursive: true, force: true });
}
mkdirp(WS_DIR);

// ─── Time helpers ─────────────────────────────────────────────
function isoOf(daysAgo, hourOffset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(10 + hourOffset, 0, 0, 0);
  return d.toISOString();
}

// ─── Top-level workspace files ───────────────────────────────
function writeConfig() {
  const tmp = (name) => path.join(os.tmpdir(), 'demo-repos', name);
  const cfg = {
    workspace: { name: WORKSPACE_NAME, slug: WORKSPACE_SLUG },
    domain: 'Demo platform exercising every section of the PipeCrew site-view drawer with a diverse multi-stack workspace (Java + TypeScript + Python backends, React frontend, Node mock, CDK + Terraform infra). Repos here are fake — paths point under /tmp/demo-repos/* and don\'t need to exist for the visualizer to work.',
    repos: {
      // ─── Backends — three services, three stacks ───
      'publisher-svc': {
        path: tmp('demo-publisher-svc'),
        type: 'spring-boot',
        role: 'api-service',
        spec_file: 'src/main/resources/openapi/api.yaml',
        description: 'Demo Spring Boot API — publishers, books, catalog (Java 21 + JPA + Liquibase).',
      },
      'search-svc': {
        path: tmp('demo-search-svc'),
        type: 'nestjs',
        role: 'api-service',
        spec_file: 'openapi.yaml',
        description: 'Demo NestJS API — search index over publisher data (TypeScript + TypeORM + ElasticSearch).',
      },
      'billing-svc': {
        path: tmp('demo-billing-svc'),
        type: 'fastapi',
        role: 'api-service',
        spec_file: 'app/openapi.yaml',
        description: 'Demo FastAPI — invoicing, payments, subscriptions (Python 3.12 + SQLAlchemy + Alembic).',
      },
      // ─── Worker — event-driven, no API ───
      'notifications-worker': {
        path: tmp('demo-notifications-worker'),
        type: 'python-worker',
        role: 'worker',
        description: 'Demo SQS consumer — sends emails / push notifications (Python + boto3, no HTTP).',
      },
      // ─── Frontend ───
      frontend: {
        path: tmp('demo-frontend'),
        type: 'react',
        role: 'frontend',
        design_system_path: 'agent-context/common/DESIGN_SYSTEM.md',
        description: 'Demo React frontend (Vite + React Query + i18n + RTL Arabic support).',
      },
      // ─── Mock ───
      mock: {
        path: tmp('demo-mock'),
        type: 'node-mock',
        role: 'mock-server',
        description: 'Demo Express mock server mirroring all three backend services.',
      },
      // ─── Infra — CDK for app resources, Terraform for shared platform ───
      'infra-cdk': {
        path: tmp('demo-infra-cdk'),
        type: 'cdk',
        role: 'infrastructure',
        description: 'Demo AWS CDK stacks — per-service S3 / SQS / Lambda / CloudFront.',
      },
      'infra-terraform': {
        path: tmp('demo-infra-terraform'),
        type: 'terraform',
        role: 'infrastructure',
        description: 'Demo Terraform — shared VPC, IAM, RDS, KMS, OpenSearch domain.',
      },
    },
    services: {
      'publisher-svc':   { repo: 'publisher-svc',         spec_policy: 'api-first', spec_file: 'src/main/resources/openapi/api.yaml', description: 'Publisher / book catalog API.' },
      'search-svc':      { repo: 'search-svc',            spec_policy: 'api-first', spec_file: 'openapi.yaml',                        description: 'Search API over publisher data.' },
      'billing-svc':     { repo: 'billing-svc',           spec_policy: 'api-first', spec_file: 'app/openapi.yaml',                    description: 'Invoicing / payments / subscriptions.' },
      'notifications':   { repo: 'notifications-worker',  spec_policy: 'no-api',                                                       description: 'SQS-driven notification dispatcher.' },
    },
  };
  writeJson(path.join(WS_DIR, 'config.json'), cfg);
}

function writePlatformMd() {
  const body = `# Platform — ${WORKSPACE_NAME}

> Demo platform doc generated by \`/simulate-run\`. Synthetic content meant for
> exercising the site-view drawer — does not describe real software.

## Architecture

A multi-stack, spec-first platform built around three backend services (one per
language stack), one event-driven worker, a React frontend, a Node mock server
for local development, and two infra repos that split AWS resources between
shared platform (Terraform) and per-service application stacks (CDK).

\`\`\`
                    ┌───────────────────┐
                    │   React frontend  │
                    └─────────┬─────────┘
                              │ REST + JWT
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ publisher-svc│  │  search-svc  │  │  billing-svc │
    │  Spring Boot │  │   NestJS     │  │   FastAPI    │
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                 │                 │
           ▼                 ▼                 ▼
       Postgres         OpenSearch          Postgres
           │                                   │
           └──────────► S3 + SQS ◄─────────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ notifications-     │
                    │ worker (Python)    │
                    └────────────────────┘

      (frontend ──> mock-server, local dev only)
\`\`\`

## Services

| Service                | Repo                  | Stack          | Spec policy | Owns                                    |
|------------------------|-----------------------|----------------|-------------|-----------------------------------------|
| Publisher              | publisher-svc         | Spring Boot    | api-first   | Publishers, books, catalog              |
| Search                 | search-svc            | NestJS         | api-first   | Search index over publisher data        |
| Billing                | billing-svc           | FastAPI        | api-first   | Invoices, payments, subscriptions       |
| Notifications worker   | notifications-worker  | Python (SQS)   | no-api      | Email + push dispatch                   |
| Frontend               | frontend              | React (Vite)   | —           | Customer + back-office UI               |
| Mock server            | mock                  | Express        | —           | Local-dev mirror of all three backends  |
| Infra (per-service)    | infra-cdk             | AWS CDK        | —           | S3 / SQS / Lambda / CloudFront per svc  |
| Infra (shared)         | infra-terraform       | Terraform      | —           | VPC, IAM, RDS, KMS, OpenSearch domain   |

## Entities & Ownership

| Entity        | Owner         | Notes |
|---------------|---------------|-------|
| Publisher     | publisher-svc | id, name, contract_type |
| Book          | publisher-svc | uploaded to S3, indexed by search-svc |
| SearchIndex   | search-svc    | OpenSearch index, refreshed via SQS events from publisher-svc |
| Invoice       | billing-svc   | per-publisher monthly billing |
| Subscription  | billing-svc   | active subscription state machine |
| Notification  | notifications-worker | queued in SQS, fanned out to email/push |
| User          | publisher-svc | shared identity, JWT issued here |

## Tech Stack

- **publisher-svc**: Spring Boot 3.5, Java 21, JPA/Hibernate, Liquibase migrations, JWT via Nimbus JOSE.
- **search-svc**: NestJS 10, TypeScript, TypeORM + ElasticSearch client, JWT via Passport.
- **billing-svc**: FastAPI 0.110, Python 3.12, SQLAlchemy 2.x + Alembic, JWT via python-jose.
- **notifications-worker**: Python 3.12, boto3, structlog, DynamoDB-backed idempotency.
- **frontend**: React 18, Vite, TanStack Query, i18next (EN + AR with RTL).
- **mock**: Node 20 + Express, json-server-style routes mirroring all three backend specs.
- **infra-cdk**: AWS CDK 2.x (TypeScript), three stages: dev / staging / prod. Owns per-service S3, SQS, Lambda, CloudFront.
- **infra-terraform**: Terraform 1.7, S3+DynamoDB state backend. Owns shared VPC, IAM, RDS instances, KMS keys, OpenSearch domain.

### Per-Service Divergences

Discovered in Phase B2.5 on ${isoOf(7).slice(0, 10)}. The general Tech Stack
block above describes the workspace baseline; these per-repo overrides apply
where a specific repo diverges.

#### publisher-svc
- Migration tool: Liquibase (baseline says Flyway in some templates) — evidence: \`db/changelog/db.changelog-master.yaml\`.

#### search-svc
- ORM: TypeORM with explicit migrations (no auto-sync, even in dev) — evidence: \`src/db/migrations/\`.

#### billing-svc
- DB sessions: synchronous SQLAlchemy engine, no asyncpg (avoids context-mismatch bugs in financial code) — evidence: \`app/db/engine.py:14\`.

## Integration Patterns

- Frontend → backends: TanStack Query, stale-while-revalidate cache, JWT issued by publisher-svc.
- publisher-svc → S3: presigned URLs for book content (no streamed bodies).
- publisher-svc → SQS: lifecycle events (\`book.published\`, \`book.archived\`).
- search-svc consumes \`book.*\` events to refresh its OpenSearch index.
- notifications-worker consumes \`*.notify\` events from any service.
- billing-svc emits \`invoice.created\` to SQS; notifications-worker fans out emails.
- Frontend → mock: only in local dev (NEXT_PUBLIC_API_URL=http://localhost:4010).

## Known Constraints

- Demo workspace only — none of these repos exist on disk.
- Search index is eventually consistent (~5s lag) by design.
- billing-svc holds money — every state-changing endpoint goes through an idempotency key check.
`;
  write(path.join(WS_DIR, 'context', 'platform.md'), body);
}

function writeAuditFindings() {
  const body = `# Audit findings — ${WORKSPACE_NAME}

> Synthesized by \`/simulate-run\`. Drives the audit pill counts in the project drawer.

## Summary

| Severity | Count |
|----------|-------|
| critical | 1 |
| high     | 3 |
| medium   | 8 |
| low      | 14 |

## Findings

### CRITICAL

- **CR-001** \`backend\`: \`SecurityConfig.java:42\` — wildcard CORS \`*\` allowed in production profile. Restrict to known origins before next release.

### HIGH

- **HI-001** \`frontend\`: missing CSP header — \`vite.config.ts\` does not set Content-Security-Policy.
- **HI-002** \`backend\`: log statement at \`DocumentService.java:88\` includes raw user-supplied filename without sanitization.
- **HI-003** \`infra\`: S3 bucket \`demo-documents-dev\` has \`enforceSSL: false\`.

### MEDIUM
- 8 entries elided for brevity in this demo.

### LOW
- 14 entries elided for brevity in this demo.
`;
  write(path.join(WS_DIR, 'context', 'audit-findings.md'), body);
}

// NOTE: per-stack convention docs (`stacks/{type}.md`) are no longer produced
// by /discover. Workspace-wide patterns live in platform.md § Established
// Patterns; per-repo patterns live in each repo's CLAUDE.md; generic stack
// anti-patterns live in the plugin at anti-patterns/{type}.md and are injected
// into per-task files by the task-planner. The simulator therefore no
// longer fabricates these docs.
function writeStacks() {
  // intentionally empty — kept as a no-op so removing the call site is a
  // separate concern from the function definition. Safe to delete entirely
  // once nothing references writeStacks.
}

function writeArchitectureDiagrams() {
  // Overview — follows rules/discovery-diagrams.md exactly:
  // 4 mandatory subgraphs (Frontends, Backend services, Queues / Topics, Data sources),
  // init directive on line 1, exact classDef palette, subroutine shape for queues.
  const overview = `%%{init: {"flowchart": {"nodeSpacing": 55, "rankSpacing": 70, "curve": "basis", "padding": 15, "htmlLabels": true}}}%%
flowchart LR
  subgraph Frontends
    fe[Frontend]
  end

  subgraph "Backend services"
    pub[publisher-svc]
    search[search-svc]
    billing[billing-svc]
    worker[notifications-worker]
  end

  subgraph "Queues / Topics"
    bookq[[book-events]]
    invq[[invoice-events]]
    notifq[[notification-queue]]
  end

  subgraph "Data sources"
    pubdb[(publisher_db)]
    billdb[(billing_db)]
    os[(search index)]
    idem[(idempotency)]
    s3[(books S3)]
  end

  fe -->|REST| pub
  fe -->|REST| search
  fe -->|REST| billing
  pub -->|access| pubdb
  pub -->|access| s3
  billing -->|access| billdb
  search -->|access| os
  worker -->|access| idem
  pub -.->|publish| bookq
  billing -.->|publish| invq
  bookq -.->|consume| search
  bookq -.->|consume| notifq
  invq -.->|consume| worker
  notifq -.->|consume| worker

  classDef frontend fill:#E6F4EA,stroke:#1E8E3E,stroke-width:1.5px,color:#0D5223,font-size:14px
  classDef service  fill:#FFF4E5,stroke:#E67C00,stroke-width:2px,color:#5A3A00,font-size:17px,font-weight:600
  classDef queue    fill:#FDECEA,stroke:#C5221F,stroke-width:1.5px,color:#7A0D0D,font-size:13px
  classDef data     fill:#E8F0FE,stroke:#1A73E8,stroke-width:1.5px,color:#0B3D91,font-size:14px

  class fe frontend
  class pub,search,billing,worker service
  class bookq,invq,notifq queue
  class pubdb,billdb,os,idem,s3 data
`;
  // Detailed topology — every real resource, full labels (endpoint paths, Feign client names,
  // queue ARNs), ==> for shared writes, edge infra + secrets + monitoring + an orphan resource.
  // This is the "implementer's map" — it must be obviously richer than the overview.
  const detailed = `flowchart LR
  subgraph client[Client tier]
    fe[Frontend - React + TanStack Query<br/>web.demo.example.com]
    mock[Mock Server - Express<br/>localhost:4010]
  end

  subgraph edge[Edge infra]
    cf[CloudFront<br/>d1234.cloudfront.net]
    alb[ALB<br/>api.demo.example.com]
    cog[Cognito<br/>JWT issuer]
  end

  subgraph services[Service tier]
    pub[publisher-svc<br/>Spring Boot 3 / Java 21<br/>API: /v1/publishers/**]
    search[search-svc<br/>NestJS 10 / Node 20<br/>API: /v1/search/**]
    billing[billing-svc<br/>FastAPI / Py 3.12<br/>API: /v1/invoices/**]
    workersvc[notifications-worker<br/>Python 3.12 Lambda<br/>handler: notify.lambda_handler]
    legacy[legacy-billing-cron<br/>Python 2.7 Lambda<br/>last deploy 2024-08-12]
  end

  subgraph data[Data — Terraform-owned]
    pubdb[(RDS Postgres 15<br/>publisher_db<br/>db.r6g.large)]
    billdb[(RDS Postgres 15<br/>billing_db<br/>db.r6g.large)]
    os[(OpenSearch 2.11<br/>search-index<br/>3× r6g.large.search)]
    idem[(DynamoDB<br/>notification_idem<br/>TTL 7d)]
    s3[(S3<br/>demo-books-dev<br/>versioned + KMS)]
    s3legacy[(S3<br/>demo-billing-archive<br/>no owner)]
  end

  subgraph queues[Queues — CDK-owned]
    sqs[[SQS<br/>book-events.fifo<br/>visibility 60s, DLQ 5×]]
    invq[[SQS<br/>invoice-events<br/>visibility 30s, DLQ 3×]]
    notifq[[SQS<br/>notification-queue<br/>batch 10, DLQ 5×]]
    sns[[SNS<br/>book-fanout-topic]]
  end

  subgraph ops[Ops + Secrets]
    sm[Secrets Manager<br/>db creds + Stripe key]
    cw[CloudWatch + X-Ray<br/>traceparent header]
  end

  subgraph external[External providers]
    sg[SendGrid<br/>v3 transactional]
    fcm[Firebase Cloud Messaging<br/>HTTP v1]
    stripe[Stripe<br/>v2024-04-10]
  end

  fe -->|"GET /v1/publishers/{id}"| alb
  fe -->|"GET /v1/search?q="| alb
  fe -->|"POST /v1/invoices"| alb
  fe -.->|"contract dev only"| mock
  cf -.->|"static assets"| fe
  alb -->|"Authorization: Bearer ..."| cog
  alb -->|"/v1/publishers/**"| pub
  alb -->|"/v1/search/**"| search
  alb -->|"/v1/invoices/**"| billing

  pub ==>|"JDBC HikariCP pool=20"| pubdb
  pub ==>|"PutObject server-side encryption"| s3
  pub -.->|"BookPublishedEvent v2 (FIFO group=publisherId)"| sqs
  pub -->|"PublisherClient.getProfile (Feign)"| billing
  pub -->|"GetSecretValue: rds/publisher"| sm

  search ==>|"_bulk index, 500 docs / batch"| os
  sqs -.->|"consume → reindex (10 msgs / poll)"| search
  search -->|"GetSecretValue: opensearch/master"| sm

  billing ==>|"asyncpg pool=10"| billdb
  billing -.->|"InvoiceCreatedEvent (standard)"| invq
  billing -->|"POST charges (idempotency-key)"| stripe
  invq -.->|"consume (visibility 30s)"| workersvc

  sqs -.->|"FilterPolicy: type=*.notify"| sns
  sns -.->|"fanout"| notifq
  notifq -.->|"consume (batch=10, partial-batch-fail)"| workersvc
  workersvc ==>|"PutItem ConditionExpression: NotExists"| idem
  workersvc -->|"POST /v3/mail/send"| sg
  workersvc -->|"POST /v1/projects/.../messages:send"| fcm

  pub -.->|"trace export"| cw
  search -.->|"trace export"| cw
  billing -.->|"trace export"| cw
  workersvc -.->|"trace export"| cw

  classDef frontend fill:#E6F4EA,stroke:#1E8E3E,stroke-width:1.5px,color:#0D5223
  classDef service  fill:#FFF4E5,stroke:#E67C00,stroke-width:2px,color:#5A3A00,font-weight:600
  classDef worker   fill:#F3E8FD,stroke:#7E22CE,stroke-width:1.5px,color:#3B0764
  classDef queue    fill:#FDECEA,stroke:#C5221F,stroke-width:1.5px,color:#7A0D0D
  classDef data     fill:#E8F0FE,stroke:#1A73E8,stroke-width:1.5px,color:#0B3D91
  classDef infra    fill:#DDE7F5,stroke:#1A73E8,stroke-width:1.5px,color:#0B3D91
  classDef external fill:#FFE7C7,stroke:#E67C00,stroke-width:1.5px,color:#5A3A00
  classDef orphan   fill:#FFE0E0,stroke:#C5221F,stroke-width:1.5px,color:#7A0D0D,stroke-dasharray:5 3

  class fe,mock frontend
  class pub,search,billing service
  class workersvc worker
  class legacy,s3legacy orphan
  class sqs,invq,notifq,sns queue
  class pubdb,billdb,os,idem,s3 data
  class cf,alb,cog,sm,cw infra
  class sg,fcm,stripe external
`;
  write(path.join(WS_DIR, 'context', 'diagrams', 'architecture-overview.mmd'), overview);
  write(path.join(WS_DIR, 'context', 'diagrams', 'architecture.mmd'), detailed);
}

function writeLearnLog() {
  const body = `# Learn log — ${WORKSPACE_NAME}

> Append-only record of \`/learn\` invocations and their outcomes.

## ${isoOf(2)} — pr https://github.com/demo-org/demo-backend/pull/142

**Source**: pr (PR #142, demo-backend)
**Signal strength**: strong
**Workspace at time of feedback**: simulate-run-demo

### Findings applied
| # | Tier | Target | Summary |
|---|---|---|---|
| 1 | workspace-durable | platform.md § Established Patterns | Auth pattern documented as SecurityConfig + @PreAuthorize (matches what shipped in PR #142) |
| 2 | workspace-durable | platform.md § Established Patterns | Query pattern documented as Specification<>; reviewer correction post-merge |

### Findings flagged (plugin-level)
| # | Summary |
|---|---|
| 3 | Plugin-level: spring-boot implementer should default to declarative @PreAuthorize on greenfield code |

### Notes
- Invocation args: \`--pr=https://github.com/demo-org/demo-backend/pull/142 --note="reviewer pushed back on manual SecurityContextHolder reads"\`
- Duration: 2:15
- Learner tokens: ~18k
`;
  write(path.join(WS_DIR, 'history', 'learn-log.md'), body);
}

// ─── /discover run ───────────────────────────────────────────
function writeDiscoverRun() {
  const runDir = path.join(WS_DIR, 'runs', 'discover', RUN_IDS.discover);
  mkdirp(path.join(runDir, 'outputs'));

  const cp = path.join(runDir, 'checkpoints.jsonl');
  // Schema-conformant /discover events: Title Case stages, args as string,
  // agent_end events carry `description` (required by validate-checkpoints).
  appendJsonl(cp, { ts: isoOf(7),    event: 'run_start', skill: 'discover', run_id: RUN_IDS.discover, workspace_slug: WORKSPACE_SLUG, args: '--simulated' });
  appendJsonl(cp, { ts: isoOf(7, 1), event: 'phase_end', skill: 'discover', run_id: RUN_IDS.discover, phase: 'A',    stage: 'Repo discovery',    duration_ms: 42000 });
  appendJsonl(cp, { ts: isoOf(7, 2), event: 'agent_end', skill: 'discover', run_id: RUN_IDS.discover, phase: 'B2',   stage: 'Architect discovery', agent_type: 'solution-architect', description: `Architect discovery for ${WORKSPACE_NAME}`, status: 'ok', total_tokens: 77922,  duration_ms: 240000 });
  appendJsonl(cp, { ts: isoOf(7, 4), event: 'agent_end', skill: 'discover', run_id: RUN_IDS.discover, phase: 'B3',   stage: 'Design system',     agent_type: 'general-purpose',    description: 'Design system discovery (frontend repos)', status: 'ok', total_tokens: 46687,  duration_ms: 136000 });
  appendJsonl(cp, { ts: isoOf(7, 5), event: 'agent_end', skill: 'discover', run_id: RUN_IDS.discover, phase: 'C',    stage: 'Generation',        agent_type: 'context-manager',    description: 'Generate config + agents + agent-context', status: 'ok', total_tokens: 186350, duration_ms: 252000 });
  appendJsonl(cp, { ts: isoOf(7, 6), event: 'run_end',   skill: 'discover', run_id: RUN_IDS.discover, status: 'completed', duration_ms: 870000 });

  write(path.join(runDir, 'scratchpad.md'), `# Onboarding Scratchpad

## Run Info
- **Skill**: discover
- **Run ID**: ${RUN_IDS.discover}
- **Workspace**: ${WORKSPACE_NAME} (${WORKSPACE_SLUG})
- **Started**: ${isoOf(7)}
- **Status**: COMPLETED

## Phase Status
| Phase | Status | Notes |
|-------|--------|-------|
| A. Repo Discovery       | COMPLETED | 4 repos detected |
| B1. Domain Questions    | COMPLETED | 4 answers captured |
| B2. Architect Discovery | COMPLETED | platform.md generated |
| B2.5. Stack Discovery   | COMPLETED | 4 stacks bootstrapped: spring-boot, react, node-mock, cdk |
| B3. Design System       | COMPLETED | 1 frontend repo scanned |
| C. Generation           | COMPLETED | config + agents + agent-context |
| D. Verification         | COMPLETED | all paths verified |
`);

  write(path.join(runDir, 'report.md'), `# Discover report — ${WORKSPACE_NAME}

| Phase | Stage                | Duration | Agents | Tokens  |
|-------|----------------------|----------|--------|---------|
| A     | Repo Discovery       | 0:42     | 0      | —       |
| B2    | Architect Discovery  | 4:00     | 1      | 77,922  |
| B2.5  | Stack Discovery      | 0:58     | 3      | 41,205  |
| B3    | Design System        | 2:16     | 1      | 46,687  |
| C     | Generation           | 4:12     | 4      | 186,350 |
| D     | Verification         | 0:12     | 0      | —       |
|       | **Total**            | **14:30**| **9**  | **352,164** |
`);
}

// ─── /deliver run helpers ───────────────────────────────────
function writeDeliverRun({ runId, featureName, featureSlug, withPr, daysAgo, pickedUpRealRun }) {
  const runDir = path.join(WS_DIR, 'runs', 'deliver', runId);
  mkdirp(path.join(runDir, 'outputs'));
  mkdirp(path.join(runDir, 'tasks'));

  // checkpoints.jsonl with realistic phase events
  const cp = path.join(runDir, 'checkpoints.jsonl');
  const cpEvents = [
    { event: 'run_start', skill: 'deliver', run_id: runId, workspace_slug: WORKSPACE_SLUG, args: `"${featureName}"` },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '1',   stage: 'Requirements',           agent_type: 'product-owner',                description: `Requirements for ${featureName}`,                       status: 'ok', total_tokens: 41200,  duration_ms: 145000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '2',   stage: 'Architecture',           agent_type: 'solution-architect',           description: `Technical design for ${featureName}`,                   status: 'ok', total_tokens: 86000,  duration_ms: 240000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '3',   stage: 'Spec edit',              agent_type: 'openapi-spec-editor',          description: 'OpenAPI spec edits',                                    status: 'ok', total_tokens: 52000,  duration_ms: 510000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '4.5', stage: 'Implementation plan',    agent_type: 'task-planner',                 description: `Hydrate task skeleton for ${featureName}`,              status: 'ok', total_tokens: 12000,  duration_ms: 25000  },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Backend implementation', agent_type: 'spring-boot-api-implementer',  description: 'Backend service',                                       status: 'ok', total_tokens: 135000, duration_ms: 375000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Frontend implementation',agent_type: 'react-feature-implementer',    description: 'Frontend',                                              status: 'ok', total_tokens: 159000, duration_ms: 422000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Mock implementation',    agent_type: 'mock-endpoint-implementer',    description: 'Mock server',                                           status: 'ok', total_tokens: 91000,  duration_ms: 192000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5.5', stage: 'Code review',            agent_type: 'spring-boot-code-reviewer',    description: 'Backend code review',                                   status: 'ok', total_tokens: 82000,  duration_ms: 465000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5.5', stage: 'Code review',            agent_type: 'react-code-reviewer',          description: 'Frontend code review',                                  status: 'ok', total_tokens: 119000, duration_ms: 360000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '6',   stage: 'Cross-repo assessment',  agent_type: `${WORKSPACE_SLUG}-assessor`,   description: 'Cross-repo wire-shape + requirement coverage',          status: 'ok', total_tokens: 174000, duration_ms: 460000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '7',   stage: 'Report',                 agent_type: 'reporter',                     description: 'Execution report writer',                               status: 'ok', total_tokens: 38000,  duration_ms: 140000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '7',   stage: 'Context refresh',        agent_type: 'context-manager',              description: 'agent-context refresh',                                 status: 'ok', total_tokens: 21000,  duration_ms: 65000  },
    { event: 'run_end', skill: 'deliver', run_id: runId, status: 'completed', duration_ms: 1200000 },
  ];
  for (let i = 0; i < cpEvents.length; i++) {
    appendJsonl(cp, { ts: isoOf(daysAgo, i / 4), ...cpEvents[i] });
  }

  // scratchpad.md
  const phasesCompleted = withPr ? 8 : 7;
  write(path.join(runDir, 'scratchpad.md'), `# Run Scratchpad${pickedUpRealRun ? ' (templated from real run)' : ' (synthesized)'}

## Run Info
- **Skill**: deliver
- **Run ID**: ${runId}
- **Feature**: ${featureName}
- **Workspace**: ${WORKSPACE_SLUG}
- **Started**: ${isoOf(daysAgo)}
- **Status**: COMPLETED

## Phase Status
| Phase | Status | Duration | Tokens |
|-------|--------|----------|--------|
| 1. Requirements      | COMPLETED | 2m 25s | 41K  |
| 2. Architecture      | COMPLETED | 4m 00s | 86K  |
| 3. Spec Edit         | COMPLETED | 8m 30s | 52K  |
| 4. Spec Sync         | COMPLETED | 0m 12s | —    |
| 4.5. Implementation Plan | COMPLETED | 0m 25s | 12K  |
| 5. Implementation    | COMPLETED | 7m 02s | 385K |
| 5.5. Code Review     | COMPLETED | 7m 45s | 201K |
| 5.75. Security Review| SKIPPED   | —      | —    |
| 6. Assessment        | COMPLETED | 7m 40s | 174K |
| 7. Report            | COMPLETED | 3m 25s | 59K  |
${withPr ? '| 8. Publish + Wrap-up | COMPLETED | 1m 50s | —    |' : '| 8. Publish + Wrap-up | COMPLETED | 0m 30s | —    | (publish skipped, feedback declined)'}

## Architecture Flags
- **Affected Services**: backend, frontend, mock
- **Frontend Required**: Yes
- **Mock Required**: Yes
- **Infra Required**: No

## Implementation Tasks
| # | Task ID | Repo | Agent | Status | Files Changed |
|---|---------|------|-------|--------|---------------|
| 1 | ${featureSlug}-a1 | demo-backend  | spring-boot-api-implementer | COMPLETED | 8 |
| 2 | ${featureSlug}-a2 | demo-frontend | react-feature-implementer   | COMPLETED | 12 |
| 3 | ${featureSlug}-a3 | demo-mock     | mock-endpoint-implementer   | COMPLETED | 2 |
`);

  // Phase outputs — Phase 1 + Phase 2 use realistic sample shapes
  // (matches what the workspace product-owner / solution-architect produce
  // in real /deliver runs, including the BEGIN/END section markers and
  // the REQUIREMENTS_INDEX / TASK_SKELETON / AFFECTED_SERVICES JSON blocks).
  // Other phase outputs stay as short stubs since they're not the focus
  // of demo workspace consumers.
  write(path.join(runDir, 'outputs', 'phase-1-requirements.md'), generatePhase1Doc(featureName, featureSlug));
  write(path.join(runDir, 'outputs', 'phase-2-architecture.md'), generatePhase2Doc(featureName, featureSlug));
  write(path.join(runDir, 'outputs', 'phase-3-diffs.md'), `# Phase 3 — Spec diffs\n\n+ POST /api/v1/${featureSlug}\n+ GET /api/v1/${featureSlug}/{id}\n`);
  write(path.join(runDir, 'outputs', 'phase-5-5-code-review.md'), `# Phase 5.5 — Review findings\n\n3 critical, 7 non-critical, 11 suggestions across 3 repos. All critical resolved in fix round.\n`);
  write(path.join(runDir, 'outputs', 'phase-6-assess.md'), `# Phase 6 — Cross-repo assessment\n\nVerdict: PASS. Wire shapes match across backend ↔ frontend ↔ mock. No gating asymmetry detected.\n`);

  // report.md (Phase 7) + Phase 8 PR table appended if --with-pr
  let report = `# Execution Report

## Feature: ${featureName}
## Run ID: ${runId}
## Date: ${isoOf(daysAgo).slice(0, 10)}

## Phase Execution Report

| Phase | Status | Duration | Tokens | Notes |
|-------|--------|----------|--------|-------|
| 1. Requirements         | Done    | 2m 25s | 41K  | 12 FR / 8 EC |
| 2. Architecture         | Done    | 4m 00s | 86K  | 1 revision  |
| 3. Spec Edit            | Done    | 8m 30s | 52K  | 2 endpoints added |
| 4. Spec Sync            | Done    | 0m 12s | —    | mock + frontend updated |
| 4.5. Implementation Plan| Done    | 0m 25s | 12K  | task-planner — 3 task files written |
| 5. Implementation       | Done    | 7m 02s | 385K | 3 tasks parallel |
| 5.5. Code Review        | Done    | 7m 45s | 201K | 3 critical → fixed |
| 6. Assessment           | Done    | 7m 40s | 174K | PASS |
| 7. Summary              | Done    | 3m 25s | 59K  | reporter + context-manager |
| **Total**               | —       | **41m 44s** | **1010K** | — |

## Repos Modified

### demo-backend
- 8 files changed; new \`${featureSlug}\` controller + service + 4 tests.

### demo-frontend
- 12 files changed; new \`${featureSlug}\` page + hook + i18n keys + 3 tests.

### demo-mock
- 2 files changed; mock handler + fixture for \`${featureSlug}\`.

## Cross-repo Assessment

PASS — wire shapes match.

## Next Steps
- [ ] Run integration tests
- [ ] Open PRs for review
`;
  if (withPr) {
    report += `\n---\n\n## Pull Requests\n\n| Repo          | PR              | Branch                       | Status |\n|---------------|-----------------|------------------------------|--------|\n| demo-backend  | [#142](https://github.com/demo-org/demo-backend/pull/142) | \`feature/${featureSlug}\` | DRAFT |\n| demo-frontend | [#89](https://github.com/demo-org/demo-frontend/pull/89)  | \`feature/${featureSlug}\` | DRAFT |\n| demo-mock     | [#31](https://github.com/demo-org/demo-mock/pull/31)      | \`feature/${featureSlug}\` | DRAFT |\n\nCreated via \`/deliver --with-pr\` on ${isoOf(daysAgo)}. Cross-repo linking applied.\n`;

    // pr_urls.json — Phase 8 Step 8.5b artifact
    writeJson(path.join(runDir, 'pr_urls.json'), {
      created_at: isoOf(daysAgo),
      run_id: runId,
      feature_slug: featureSlug,
      publish_command: '/deliver --with-pr',
      prs: [
        { repo: 'demo-backend',  branch: `feature/${featureSlug}`, pr_number: 142, url: 'https://github.com/demo-org/demo-backend/pull/142',  status: 'draft', target_branch: 'dev' },
        { repo: 'demo-frontend', branch: `feature/${featureSlug}`, pr_number:  89, url: 'https://github.com/demo-org/demo-frontend/pull/89',  status: 'draft', target_branch: 'dev' },
        { repo: 'demo-mock',     branch: `feature/${featureSlug}`, pr_number:  31, url: 'https://github.com/demo-org/demo-mock/pull/31',      status: 'draft', target_branch: 'dev' },
      ],
      failed: [],
    });
  }
  write(path.join(runDir, 'report.md'), report);
}

// ─── /deliver run — LIVE timeline mode ──────────────────────
// Drives a feature run forward in real time so the site-view animates
// characters through queued → working → done. Mutates scratchpad.md and
// appends checkpoints.jsonl on each step (the server's fs.watch picks
// both up). Finalizes report.md + pr_urls.json after the timeline ends.
async function runDeliverRunLive({ runId, featureName, featureSlug, withPr, daysAgo, stepMs }) {
  const runDir = path.join(WS_DIR, 'runs', 'deliver', runId);
  mkdirp(path.join(runDir, 'outputs'));
  mkdirp(path.join(runDir, 'tasks'));

  const phaseDefs = [
    { id: '1',    label: '1. Requirements',       duration: '2m 25s', tokens: '41K'  },
    { id: '2',    label: '2. Architecture',       duration: '4m 00s', tokens: '86K'  },
    { id: '3',    label: '3. Spec Edit',          duration: '8m 30s', tokens: '52K'  },
    { id: '4',    label: '4. Spec Sync',          duration: '0m 12s', tokens: '—'    },
    { id: '4.5',  label: '4.5. Implementation Plan', duration: '0m 25s', tokens: '12K' },
    { id: '5',    label: '5. Implementation',     duration: '7m 02s', tokens: '385K' },
    { id: '5.5',  label: '5.5. Code Review',      duration: '7m 45s', tokens: '201K' },
    { id: '5.75', label: '5.75. Security Review', duration: '—',      tokens: '—', alwaysSkipped: true },
    { id: '6',    label: '6. Assessment',         duration: '7m 40s', tokens: '174K' },
    { id: '7',    label: '7. Report',             duration: '3m 25s', tokens: '59K'  },
    { id: '8',    label: '8. Publish + Wrap-up',  duration: withPr ? '1m 50s' : '0m 30s', tokens: '—' },
  ];
  // Multi-stack fan-out — five implementers cover three backends (Java, TS,
  // Python via the nestjs path), the frontend, the mock, and one infra repo.
  const taskDefs = [
    { num: 1, id: `${featureSlug}-a1`, repo: 'demo-publisher-svc', agent: 'spring-boot-api-implementer', files: 8  },
    { num: 2, id: `${featureSlug}-a2`, repo: 'demo-search-svc',    agent: 'nestjs-implementer',          files: 6  },
    { num: 3, id: `${featureSlug}-a3`, repo: 'demo-frontend',      agent: 'react-feature-implementer',   files: 12 },
    { num: 4, id: `${featureSlug}-a4`, repo: 'demo-mock',          agent: 'mock-endpoint-implementer',   files: 2  },
    { num: 5, id: `${featureSlug}-a5`, repo: 'demo-infra-cdk',     agent: 'cdk-stack-implementer',       files: 3  },
  ];
  const phaseStatus = {};
  for (const p of phaseDefs) phaseStatus[p.id] = p.alwaysSkipped ? 'SKIPPED' : 'PENDING';
  const taskStatus = { 1: 'PENDING', 2: 'PENDING', 3: 'PENDING', 4: 'PENDING', 5: 'PENDING' };
  let runStatus = 'IN_PROGRESS';

  // Agent Dispatch Log entries — drives promotion of queued preseed characters
  // (tya / scribe) since Phase 5 + Phase 7 are intentionally omitted from the
  // server's PHASE_TO_ROLE map. Each entry has a stable _key so we can flip
  // outcome from in_progress → success on a later step.
  const dispatched = [];
  const upsertDispatch = (key, entry) => {
    const idx = dispatched.findIndex(d => d._key === key);
    if (idx >= 0) dispatched[idx] = { ...dispatched[idx], ...entry };
    else dispatched.push({ _key: key, ...entry });
  };

  function renderScratchpad() {
    const phaseRows = phaseDefs.map(p => {
      const s = phaseStatus[p.id];
      const dur = (s === 'COMPLETED') ? p.duration : (s === 'IN_PROGRESS' ? '…' : '—');
      const tok = (s === 'COMPLETED') ? p.tokens : '—';
      const trailing = (p.id === '8' && !withPr && s === 'COMPLETED') ? ' (publish skipped, feedback declined)' : '';
      return `| ${p.label} | ${s} | ${dur} | ${tok} |${trailing ? ` ${trailing} |` : ''}`;
    }).join('\n');
    const taskRows = taskDefs.map(t => {
      const s = taskStatus[t.num];
      const files = (s === 'COMPLETED') ? t.files : 0;
      return `| ${t.num} | ${t.id} | ${t.repo} | ${t.agent} | ${s} | ${files} |`;
    }).join('\n');
    const dispatchRows = dispatched.length === 0
      ? ''
      : dispatched.map((d, i) =>
          `| ${i + 1} | ${d.phase} | ${d.agent} | ${d.taskId || '—'} | ${d.duration} | ${d.tokens} | ${d.outcome} |`
        ).join('\n');
    const dispatchSection = `\n## Agent Dispatch Log

| # | Phase | Agent | Task ID | Duration | Tokens | Outcome |
|---|-------|-------|---------|----------|--------|---------|
${dispatchRows}
`;
    return `# Run Scratchpad (synthesized — live timeline)

## Run Info
- **Skill**: deliver
- **Run ID**: ${runId}
- **Feature**: ${featureName}
- **Workspace**: ${WORKSPACE_SLUG}
- **Started**: ${new Date().toISOString()}
- **Status**: ${runStatus}

## Phase Status
| Phase | Status | Duration | Tokens |
|-------|--------|----------|--------|
${phaseRows}

## Architecture Flags
- **Affected Services**: publisher-svc, search-svc, frontend, mock, infra-cdk
- **Frontend Required**: Yes
- **Mock Required**: Yes
- **Infra Required**: Yes

## Implementation Tasks
| # | Task ID | Repo | Agent | Status | Files Changed |
|---|---------|------|-------|--------|---------------|
${taskRows}
${dispatchSection}`;
  }

  // Same checkpoint event list the static path uses, indexed for emission.
  // Indices used by emitCp() — keep in sync with the timeline closures below:
  //   0: run_start
  //   1: product-owner          (phase 1)
  //   2: solution-architect     (phase 2)
  //   3: openapi-spec-editor    (phase 3)
  //   4: task-planner           (phase 4.5)
  //   5: spring-boot-api-impl   (phase 5 — publisher-svc)
  //   6: nestjs-implementer     (phase 5 — search-svc)
  //   7: react-feature-impl     (phase 5 — frontend)
  //   8: mock-endpoint-impl     (phase 5 — mock)
  //   9: cdk-stack-impl         (phase 5 — infra-cdk)
  //  10: spring-boot-code-rev   (phase 5.5)
  //  11: react-code-reviewer    (phase 5.5)
  //  12: assessor               (phase 6)
  //  13: reporter               (phase 7)
  //  14: context-manager        (phase 7)
  //  15: run_end
  // All events conform to templates/checkpoints-event.schema.json + the
  // canonical examples in rules/observability.md:
  //   - skill: 'deliver'
  //   - stage: Title Case prose (matches the doc's "Architect Discovery",
  //     "Backend implementation" examples — NOT lowercase slugs)
  //   - agent_end events include `description` (required by validator)
  //   - args on run_start is a string (the CLI form), not an object
  const cpEvents = [
    { event: 'run_start', skill: 'deliver', run_id: runId, workspace_slug: WORKSPACE_SLUG, args: `"${featureName}" --with-pr` },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '1',   stage: 'Requirements',           agent_type: 'product-owner',                description: `Requirements for ${featureName}`,                       status: 'ok', total_tokens: 41200,  duration_ms: 145000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '2',   stage: 'Architecture',           agent_type: 'solution-architect',           description: `Technical design for ${featureName}`,                   status: 'ok', total_tokens: 86000,  duration_ms: 240000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '3',   stage: 'Spec edit',              agent_type: 'openapi-spec-editor',          description: 'OpenAPI spec edits across publisher-svc + search-svc',  status: 'ok', total_tokens: 52000,  duration_ms: 510000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '4.5', stage: 'Implementation plan',    agent_type: 'task-planner',                 description: `Hydrate task skeleton for ${featureName}`,              status: 'ok', total_tokens: 12000,  duration_ms: 25000  },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Backend implementation', agent_type: 'spring-boot-api-implementer',  description: 'publisher-svc (Spring Boot)',                           status: 'ok', total_tokens: 135000, duration_ms: 375000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Backend implementation', agent_type: 'nestjs-implementer',           description: 'search-svc (NestJS)',                                   status: 'ok', total_tokens: 112000, duration_ms: 320000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Frontend implementation',agent_type: 'react-feature-implementer',    description: 'frontend (React)',                                      status: 'ok', total_tokens: 159000, duration_ms: 422000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Mock implementation',    agent_type: 'mock-endpoint-implementer',    description: 'mock (Express)',                                        status: 'ok', total_tokens: 91000,  duration_ms: 192000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5',   stage: 'Infra implementation',   agent_type: 'cdk-stack-implementer',        description: 'infra-cdk (AWS CDK)',                                   status: 'ok', total_tokens: 64000,  duration_ms: 210000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5.5', stage: 'Code review',            agent_type: 'spring-boot-code-reviewer',    description: 'Backend review — publisher-svc',                        status: 'ok', total_tokens: 82000,  duration_ms: 465000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '5.5', stage: 'Code review',            agent_type: 'react-code-reviewer',          description: 'Frontend review',                                       status: 'ok', total_tokens: 119000, duration_ms: 360000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '6',   stage: 'Cross-repo assessment',  agent_type: `${WORKSPACE_SLUG}-assessor`,   description: 'Cross-repo wire-shape + requirement coverage',          status: 'ok', total_tokens: 174000, duration_ms: 460000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '7',   stage: 'Report',                 agent_type: 'reporter',                     description: 'Execution report writer',                               status: 'ok', total_tokens: 38000,  duration_ms: 140000 },
    { event: 'agent_end', skill: 'deliver', run_id: runId, phase: '7',   stage: 'Context refresh',        agent_type: 'context-manager',              description: 'agent-context refresh across affected repos',           status: 'ok', total_tokens: 21000,  duration_ms: 65000  },
    { event: 'run_end',   skill: 'deliver', run_id: runId, status: 'completed', duration_ms: 1200000 },
  ];

  const cpPath = path.join(runDir, 'checkpoints.jsonl');
  fs.writeFileSync(cpPath, '');
  appendJsonl(cpPath, { ts: new Date().toISOString(), ...cpEvents[0] });
  write(path.join(runDir, 'scratchpad.md'), renderScratchpad());
  // Defensive: a prior interrupted run may have left an open gate. Clear it
  // before the timeline starts so the UI doesn't show a stale banner.
  const stalePath = path.join(runDir, 'awaiting_input.json');
  if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);

  // Phase outputs — Phase 1 + Phase 2 use realistic sample shapes (see
  // the helper definitions near the top of this file).
  write(path.join(runDir, 'outputs', 'phase-1-requirements.md'), generatePhase1Doc(featureName, featureSlug));
  write(path.join(runDir, 'outputs', 'phase-2-architecture.md'), generatePhase2Doc(featureName, featureSlug));
  write(path.join(runDir, 'outputs', 'phase-3-diffs.md'),         `# Phase 3 — Spec diffs\n\n+ POST /api/v1/${featureSlug}\n+ GET /api/v1/${featureSlug}/{id}\n`);
  write(path.join(runDir, 'outputs', 'phase-5-5-code-review.md'), `# Phase 5.5 — Review findings\n\n3 critical, 7 non-critical, 11 suggestions across 3 repos. All critical resolved in fix round.\n`);
  write(path.join(runDir, 'outputs', 'phase-6-assess.md'),        `# Phase 6 — Cross-repo assessment\n\nVerdict: PASS. Wire shapes match across backend ↔ frontend ↔ mock. No gating asymmetry detected.\n`);

  // Helpers used by the timeline closures below.
  const setPhase = (id, s) => { phaseStatus[id] = s; };
  const setTask  = (n, s)  => { taskStatus[n]  = s; };
  const flush    = ()      => write(path.join(runDir, 'scratchpad.md'), renderScratchpad());
  const emitCp   = (i)     => appendJsonl(cpPath, { ts: new Date().toISOString(), ...cpEvents[i] });

  // Awaiting-input gate — mirrors `scripts/gate.js open/close` from real
  // /deliver runs. Writing this file makes the site-view show the yellow
  // "WAITING FOR YOUR INPUT" banner, prefix the tab title with ⏸, and (if
  // the user enabled audio in the UI) play the periodic beep. Removing the
  // file clears all three. See docs/site-view.md → "Awaiting-input banner".
  const gatePath = path.join(runDir, 'awaiting_input.json');
  const gateOpen = ({ phase, gate, question, context_summary }) => {
    writeJson(gatePath, {
      since: new Date().toISOString(),
      phase, gate, question,
      ...(context_summary ? { context_summary } : {}),
    });
  };
  const gateClose = () => {
    if (fs.existsSync(gatePath)) fs.unlinkSync(gatePath);
  };

  // Settle: let the UI mount on PENDING state before the first transition.
  await sleep(stepMs);

  const timeline = [
    // Phase 1 — requirements. Real /deliver opens an `approval` gate after
    // product-owner produces the requirements doc; we mirror that here so
    // the user sees the WAITING-FOR-INPUT banner + (if enabled) the beep.
    () => { setPhase('1', 'IN_PROGRESS'); flush(); },
    () => {
      gateOpen({
        phase: '1', gate: 'approval',
        question: 'Approve requirements document?',
        context_summary: '12 FRs / 8 ECs captured. Backend + Frontend + Mock affected.',
      });
      flush();
    },
    () => { /* gate held — banner sits visible for one full step */ },
    () => {
      gateClose();
      setPhase('1', 'COMPLETED');
      flush();
      emitCp(1);
    },
    // Phase 2 — architecture. Approval gate after the technical design doc.
    () => { setPhase('2', 'IN_PROGRESS'); flush(); },
    () => {
      gateOpen({
        phase: '2', gate: 'approval',
        question: 'Approve technical design?',
        context_summary: 'Backend: new BulkUpload service. Frontend: new page + hook. No infra changes.',
      });
      flush();
    },
    () => { /* gate held */ },
    () => {
      gateClose();
      setPhase('2', 'COMPLETED');
      flush();
      emitCp(2);
    },
    // Phase 3 — spec edit. Approval gate after openapi diffs are written.
    () => { setPhase('3', 'IN_PROGRESS'); flush(); },
    () => {
      gateOpen({
        phase: '3', gate: 'approval',
        question: 'Approve OpenAPI spec changes?',
        context_summary: '+ POST /api/v1/bulk-upload\n+ GET  /api/v1/bulk-upload/{id}',
      });
      flush();
    },
    () => { /* gate held */ },
    () => {
      gateClose();
      setPhase('3', 'COMPLETED');
      flush();
      emitCp(3);
    },
    () => { setPhase('4', 'IN_PROGRESS'); flush(); },
    () => { setPhase('4', 'COMPLETED');   flush(); },
    // Phase 4.5 — task-planner hydrates the architect's TASK_SKELETON into
    // per-task markdown files. Foreman (the planner character) preseeded queued
    // by the server via PHASE_TO_ROLE['4.5']; the dispatch-log row promotes it
    // queued → working → done.
    () => {
      setPhase('4.5', 'IN_PROGRESS');
      upsertDispatch('foreman', {
        phase: '4.5', agent: 'task-planner',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    () => {
      upsertDispatch('foreman', {
        duration: '0:25', tokens: '12K',
        outcome: 'success — 5 task files written',
      });
      setPhase('4.5', 'COMPLETED');
      flush();
      emitCp(4);
    },
    // Phase 5 — multi-stack fan-out. Five implementers run in parallel
    // (publisher-svc Spring Boot, search-svc NestJS, frontend React, mock,
    // infra-cdk) plus the UX consultant. Tya (UX) is preseeded queued by
    // the server, so her queued → working → done transition rides on
    // dispatch-log rows.
    () => {
      setPhase('5', 'IN_PROGRESS');
      setTask(1, 'IN_PROGRESS');
      setTask(2, 'IN_PROGRESS');
      setTask(3, 'IN_PROGRESS');
      setTask(4, 'IN_PROGRESS');
      setTask(5, 'IN_PROGRESS');
      upsertDispatch('tya', {
        phase: '5', agent: 'ux-consultant',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    // UX finishes first (the user expects ux to complete before implementers).
    () => {
      upsertDispatch('tya', {
        duration: '3:08', tokens: '53K',
        outcome: 'success — IMPLEMENTATION_SPEC produced',
      });
      flush();
    },
    () => { setTask(1, 'COMPLETED'); flush(); emitCp(5); },  // spring-boot
    () => { setTask(2, 'COMPLETED'); flush(); emitCp(6); },  // nestjs
    () => { setTask(3, 'COMPLETED'); flush(); emitCp(7); },  // react
    () => { setTask(4, 'COMPLETED'); flush(); emitCp(8); },  // mock
    () => { setTask(5, 'COMPLETED'); setPhase('5', 'COMPLETED'); flush(); emitCp(9); },  // cdk
    // Phase 5.5 — code review is per-repo (one reviewer per affected
    // service + one for the frontend). Mock + infra are excluded by policy
    // (phase-5.5-code-review.md). Reviewers dispatch in parallel; if any
    // returns NEEDS_FIXES, the original implementer is re-dispatched in a
    // fix round (phase 5.5-fix) — modelled below as the implementers
    // briefly flipping back from done → working.
    () => {
      setPhase('5.5', 'IN_PROGRESS');
      upsertDispatch('crit-be', {
        phase: '5.5', agent: 'spring-boot-code-reviewer (demo-publisher-svc)',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      upsertDispatch('crit-fe', {
        phase: '5.5', agent: 'react-code-reviewer (demo-frontend)',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    // Both reviewers come back NEEDS_FIXES — the implementers will be
    // re-dispatched. Stagger completions by one step so the user can see
    // the parallel work resolving.
    () => {
      upsertDispatch('crit-be', {
        duration: '7:45', tokens: '82K',
        outcome: 'success — NEEDS_FIXES: 1 critical (auth branch missing)',
      });
      flush();
      emitCp(10);
    },
    () => {
      upsertDispatch('crit-fe', {
        duration: '6:00', tokens: '119K',
        outcome: 'success — NEEDS_FIXES: 2 critical (route guard + render-ref)',
      });
      flush();
      emitCp(11);
    },
    // Phase 5.5 fix-round gate — only fires when reviewers flagged critical
    // findings. Asks the user to authorize the re-dispatch.
    () => {
      gateOpen({
        phase: '5.5', gate: 'fix-round',
        question: 'Reviewers raised 3 critical findings. Approve fix round?',
        context_summary: 'Backend: 1 critical (auth branch missing).\nFrontend: 2 critical (route guard + render-ref).',
      });
      flush();
    },
    () => { /* gate held */ },
    () => {
      gateClose();
      flush();
    },
    // Fix round: re-dispatch the implementers in parallel against the
    // reviewer fix lists. bruno + pixel flip from done → working (phase
    // chip shows fix-r1).
    () => {
      upsertDispatch('bruno-fix', {
        phase: '5.5-fix', agent: 'spring-boot-api-implementer (demo-publisher-svc)',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      upsertDispatch('pixel-fix', {
        phase: '5.5-fix', agent: 'react-feature-implementer (demo-frontend)',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    () => {
      upsertDispatch('bruno-fix', {
        duration: '1:42', tokens: '21K',
        outcome: 'success — auth branch + perm alignment + tests',
      });
      flush();
    },
    () => {
      upsertDispatch('pixel-fix', {
        duration: '3:11', tokens: '44K',
        outcome: 'success — ProtectedRoute + render-ref + i18n',
      });
      setPhase('5.5', 'COMPLETED');
      flush();
    },
    // Phase 6.
    () => { setPhase('6', 'IN_PROGRESS'); flush(); },
    () => { setPhase('6', 'COMPLETED'); flush(); emitCp(12); },
    // Phase 7 — reporter is the only character we promote here.
    // Sage (context-manager) is intentionally NOT given a dispatch entry, so
    // it stays queued in the UI even though the checkpoint event fires (the
    // event still contributes realistic token totals to the run report).
    () => {
      setPhase('7', 'IN_PROGRESS');
      upsertDispatch('scribe', {
        phase: '7', agent: 'reporter',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    () => {
      upsertDispatch('scribe', {
        duration: '3:25', tokens: '38K',
        outcome: 'success — report.md written',
      });
      flush();
      emitCp(13);
    },
    () => { setPhase('7', 'COMPLETED'); flush(); emitCp(14); },
    // Phase 8 — PR publish + feedback offer. Feedback-learner (loop) is the
    // run's terminal agent and its `done` state is what closes the pyramid in
    // the UI. We model it as: queued → working when Phase 8 starts, then
    // success at the very end after PRs are recorded.
    () => {
      setPhase('8', 'IN_PROGRESS');
      upsertDispatch('loop', {
        phase: '8', agent: 'feedback-learner',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    () => {
      setPhase('8', 'COMPLETED');
      upsertDispatch('loop', {
        duration: '2:15', tokens: '18K',
        outcome: 'success — 3 findings (2 workspace-durable, 1 plugin-level)',
      });
      runStatus = 'COMPLETED';
      flush();
      emitCp(15);
    },
  ];

  for (const step of timeline) {
    step();
    await sleep(stepMs);
  }
  // Defensive: ensure no gate is left open at the end of the timeline.
  gateClose();

  // Finalize the report + PR artifacts (Phase 8 outputs).
  let report = `# Execution Report

## Feature: ${featureName}
## Run ID: ${runId}
## Date: ${isoOf(daysAgo).slice(0, 10)}

## Phase Execution Report

| Phase | Status | Duration | Tokens | Notes |
|-------|--------|----------|--------|-------|
| 1. Requirements         | Done    | 2m 25s | 41K  | 12 FR / 8 EC |
| 2. Architecture         | Done    | 4m 00s | 86K  | 1 revision  |
| 3. Spec Edit            | Done    | 8m 30s | 52K  | 2 endpoints added |
| 4. Spec Sync            | Done    | 0m 12s | —    | mock + frontend updated |
| 4.5. Implementation Plan| Done    | 0m 25s | 12K  | task-planner — 3 task files written |
| 5. Implementation       | Done    | 7m 02s | 385K | 3 tasks parallel |
| 5.5. Code Review        | Done    | 7m 45s | 201K | 3 critical → fixed |
| 6. Assessment           | Done    | 7m 40s | 174K | PASS |
| 7. Summary              | Done    | 3m 25s | 59K  | reporter + context-manager |
| **Total**               | —       | **41m 44s** | **1010K** | — |

## Repos Modified

### demo-backend
- 8 files changed; new \`${featureSlug}\` controller + service + 4 tests.

### demo-frontend
- 12 files changed; new \`${featureSlug}\` page + hook + i18n keys + 3 tests.

### demo-mock
- 2 files changed; mock handler + fixture for \`${featureSlug}\`.

## Cross-repo Assessment

PASS — wire shapes match.

## Next Steps
- [ ] Run integration tests
- [ ] Open PRs for review
`;
  if (withPr) {
    report += `\n---\n\n## Pull Requests\n\n| Repo          | PR              | Branch                       | Status |\n|---------------|-----------------|------------------------------|--------|\n| demo-backend  | [#142](https://github.com/demo-org/demo-backend/pull/142) | \`feature/${featureSlug}\` | DRAFT |\n| demo-frontend | [#89](https://github.com/demo-org/demo-frontend/pull/89)  | \`feature/${featureSlug}\` | DRAFT |\n| demo-mock     | [#31](https://github.com/demo-org/demo-mock/pull/31)      | \`feature/${featureSlug}\` | DRAFT |\n\nCreated via \`/deliver --with-pr\` on ${isoOf(daysAgo)}. Cross-repo linking applied.\n`;
    writeJson(path.join(runDir, 'pr_urls.json'), {
      created_at: isoOf(daysAgo),
      run_id: runId,
      feature_slug: featureSlug,
      publish_command: '/deliver --with-pr',
      prs: [
        { repo: 'demo-backend',  branch: `feature/${featureSlug}`, pr_number: 142, url: 'https://github.com/demo-org/demo-backend/pull/142', status: 'draft', target_branch: 'dev' },
        { repo: 'demo-frontend', branch: `feature/${featureSlug}`, pr_number:  89, url: 'https://github.com/demo-org/demo-frontend/pull/89',  status: 'draft', target_branch: 'dev' },
        { repo: 'demo-mock',     branch: `feature/${featureSlug}`, pr_number:  31, url: 'https://github.com/demo-org/demo-mock/pull/31',      status: 'draft', target_branch: 'dev' },
      ],
      failed: [],
    });
  }
  write(path.join(runDir, 'report.md'), report);
}

// ─── /learn run helpers ─────────────────────────────────────
function writeLearnRun({ runId, sourceLabel, daysAgo, applied, flagged }) {
  const runDir = path.join(WS_DIR, 'runs', 'learn', runId);
  mkdirp(runDir);

  // Schema-conformant /learn events: Title Case stage, agent_end carries
  // `description` (required by validator), args is a string.
  appendJsonl(path.join(runDir, 'checkpoints.jsonl'),
    { ts: isoOf(daysAgo),    event: 'run_start', skill: 'learn', run_id: runId, workspace_slug: WORKSPACE_SLUG, args: `--source="${sourceLabel}"` });
  appendJsonl(path.join(runDir, 'checkpoints.jsonl'),
    { ts: isoOf(daysAgo, 1), event: 'agent_end', skill: 'learn', run_id: runId, phase: '3', stage: 'Feedback analysis', agent_type: 'feedback-learner', description: `Analyze feedback from ${sourceLabel}`, status: 'ok', total_tokens: 18000, duration_ms: 135000 });
  appendJsonl(path.join(runDir, 'checkpoints.jsonl'),
    { ts: isoOf(daysAgo, 2), event: 'run_end',   skill: 'learn', run_id: runId, status: 'completed', duration_ms: 135000 });

  const findings = [];
  for (let i = 0; i < applied; i++) {
    findings.push(`### Finding ${i + 1} — workspace-durable — platform.md § Established Patterns

**Observation**: Implementer used manual SecurityContextHolder.

**Correction**: Use @PreAuthorize annotation declaratively.

**Evidence**:
> "We always declare auth via @PreAuthorize — never read SecurityContextHolder inside service methods"
> — reviewer comment on demo-backend PR #142

**Tier**: \`workspace-durable\`

**Confidence**: \`high\`

**Target**: \`{workspace_root}/${WORKSPACE_SLUG}/context/platform.md\` § Established Patterns
`);
  }
  for (let i = 0; i < flagged; i++) {
    findings.push(`### Finding ${applied + i + 1} — plugin-level — (plugin maintainer review)

**Observation**: Plugin's spring-boot-api-implementer defaulted to manual auth read.

**Correction**: Plugin should default to declarative @PreAuthorize on greenfield code.

**Evidence**:
> "Implementer's first draft used SecurityContextHolder; reviewer corrected"

**Tier**: \`plugin-level\`

**Confidence**: \`moderate\`

**Target**: (plugin maintainer review — no workspace file)
`);
  }

  write(path.join(runDir, 'learner-output.md'), `# Feedback analysis — ${sourceLabel}

## Summary
- **Source**: ${sourceLabel}
- **Signal strength**: strong
- **Findings produced**: ${applied + flagged} (${applied} workspace-durable, ${flagged} plugin-level)

## Actionable findings

${findings.join('\n')}
`);
}

// ─── Try to copy a real run as template (optional enrichment) ──
function copyRealRunIfAvailable() {
  if (!fs.existsSync(WORKSPACE_ROOT)) return false;
  const otherWorkspaces = fs.readdirSync(WORKSPACE_ROOT)
    .filter(d => d !== WORKSPACE_SLUG)
    .filter(d => fs.existsSync(path.join(WORKSPACE_ROOT, d, 'config.json')));

  // Find the most recent /deliver run across all real workspaces.
  let best = null;
  for (const ws of otherWorkspaces) {
    const dir = path.join(WORKSPACE_ROOT, ws, 'runs', 'deliver');
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      const sp = path.join(dir, id, 'scratchpad.md');
      if (!fs.existsSync(sp)) continue;
      const mtime = fs.statSync(sp).mtimeMs;
      if (!best || mtime > best.mtime) {
        best = { ws, id, srcDir: path.join(dir, id), mtime };
      }
    }
  }
  if (!best) return false;

  const destId = '2026-04-25-150000-from-real-run';
  const destDir = path.join(WS_DIR, 'runs', 'deliver', destId);
  mkdirp(destDir);
  for (const fname of ['scratchpad.md', 'report.md', 'pr_urls.json', 'checkpoints.jsonl']) {
    const src = path.join(best.srcDir, fname);
    if (!fs.existsSync(src)) continue;
    let body = fs.readFileSync(src, 'utf8');
    // Rename run_id occurrences so the new dir's contents reference itself.
    body = body.split(best.id).join(destId);
    write(path.join(destDir, fname), body);
  }
  console.log(`[sim] copied real run from ${best.ws}/${best.id} → ${destId}`);
  return true;
}

// ─── Generate everything ─────────────────────────────────────
mkdirp(path.join(WS_DIR, 'context', 'stacks'));
mkdirp(path.join(WS_DIR, 'agents'));
mkdirp(path.join(WS_DIR, 'runs', 'discover'));
mkdirp(path.join(WS_DIR, 'runs', 'deliver'));
mkdirp(path.join(WS_DIR, 'runs', 'learn'));

writeConfig();
writePlatformMd();
writeAuditFindings();
writeArchitectureDiagrams();
writeLearnLog();
writeDiscoverRun();

// Static mode: deliver_a is written fully completed.
// Live mode (STEP_MS > 0): deliver_a is initialized in PENDING state by
// runDeliverRunLive() below — we skip the static write here so the UI mounts
// on a blank/queued state and animates forward.
if (STEP_MS === 0) {
  writeDeliverRun({
    runId: RUN_IDS.deliver_a, featureName: 'Bulk Upload', featureSlug: 'bulk-upload',
    withPr: true, daysAgo: 1, pickedUpRealRun: false,
  });
}
writeDeliverRun({
  runId: RUN_IDS.deliver_b, featureName: 'Contract Modals', featureSlug: 'contract-modals',
  withPr: false, daysAgo: 4, pickedUpRealRun: false,
});
writeLearnRun({
  runId: RUN_IDS.learn_a, sourceLabel: 'PR #142 (demo-backend)', daysAgo: 2, applied: 2, flagged: 1,
});
writeLearnRun({
  runId: RUN_IDS.learn_b, sourceLabel: 'Run 2026-04-25 bulk-upload', daysAgo: 1, applied: 1, flagged: 0,
});

const usedReal = copyRealRunIfAvailable();

console.log(`\n[sim] demo workspace ready at:\n  ${WS_DIR}\n`);
console.log(`     /discover runs:    1 (${RUN_IDS.discover})`);
console.log(`     /deliver runs:     ${usedReal ? '3 (2 synthesized + 1 from real run)' : '2 synthesized'}`);
console.log(`     /learn runs:       2`);
console.log(`     diagrams:          context/diagrams/architecture.mmd + architecture-overview.mmd`);
if (STEP_MS > 0) {
  console.log(`     live timeline:     deliver_a will animate (${STEP_MS}ms / step)`);
}
console.log('');

// ─── Optionally launch the UI + drive the live timeline ──────
async function main() {
  let child = null;
  if (launchUi) {
    const serverJs = path.join(__dirname, '..', 'skills', 'site-view', 'server.js');
    child = spawn('node', [serverJs, `--workspace=${WORKSPACE_SLUG}`, `--run-id=${RUN_IDS.deliver_a}`, `--port=${port}`], {
      stdio: 'inherit',
    });
    child.on('exit', code => {
      console.log(`[sim] UI exited (code ${code})`);
      process.exit(code || 0);
    });
    process.on('SIGINT', () => {
      try { child.kill(); } catch (_) {}
      process.exit(0);
    });
  }

  if (STEP_MS > 0) {
    // Give the UI server a moment to bind + the browser to open before the
    // first transition fires. Skipped if no UI was launched (headless test).
    if (launchUi) await sleep(1500);
    await runDeliverRunLive({
      runId: RUN_IDS.deliver_a,
      featureName: 'Bulk Upload',
      featureSlug: 'bulk-upload',
      withPr: true,
      daysAgo: 1,
      stepMs: STEP_MS,
    });
    console.log(`[sim] live timeline complete — deliver_a finalized`);
    if (!launchUi) process.exit(0);
    // With UI: leave the server running so the user can keep exploring;
    // child.on('exit') will exit the parent when they Ctrl+C.
  }
}

main().catch(err => {
  console.error('[sim] error:', err);
  process.exit(1);
});
