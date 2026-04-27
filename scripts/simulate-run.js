#!/usr/bin/env node
/**
 * simulate-run.js — generate the demo workspace at
 *   {workspace_root}/simulate-run-demo/
 * with full /discover + /deliver + /learn artifacts following the latest
 * plugin schema (Phase 8 PR publish, pr_urls.json, learn runs, stacks docs,
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

function writeStacks() {
  const writeStack = (name, title, sections) => {
    const body = `# ${title} standards — ${WORKSPACE_NAME}

> **Last Updated**: ${isoOf(5).slice(0, 10)}
> **Bootstrapped by**: PipeCrew \`/discover\` — Phase B2.5 (simulated).

${sections.map((s, i) => `## §${i + 1} ${s.title}

**Detected pattern**: ${s.pattern}

**Reference files:**
${s.refs.map(r => `- ${r}`).join('\n')}
`).join('\n---\n\n')}
`;
    write(path.join(WS_DIR, 'context', 'stacks', `${name}.md`), body);
  };

  writeStack('spring-boot', 'Spring Boot', [
    { title: 'Auth / role enforcement', pattern: 'Spring Security filter + @PreAuthorize', refs: ['config/SecurityConfig.java', 'controller/UserController.java:45'] },
    { title: 'Persistence', pattern: 'Spring Data JPA with Specification predicates', refs: ['repository/UserRepository.java', 'service/UserService.java'] },
    { title: 'Pagination', pattern: 'Spring Data Pageable, default size 20', refs: ['controller/UserController.java:80'] },
    { title: 'Migrations', pattern: 'Liquibase YAML changesets, additive only', refs: ['db/changelog/db.changelog-master.yaml'] },
    { title: 'Tests', pattern: '@WebMvcTest + @WithMockUser + spring-security-test', refs: ['test/.../UserControllerTest.java'] },
  ]);

  writeStack('react', 'React', [
    { title: 'API client factory', pattern: 'createApiClient() with Axios + interceptors', refs: ['src/api/client.ts', 'src/api/auth.ts'] },
    { title: 'OpenAPI types', pattern: 'Generated via openapi-typescript at build time', refs: ['src/api/types.gen.ts'] },
    { title: 'Data fetching', pattern: 'TanStack Query, staleTime: 30s', refs: ['src/features/users/hooks.ts'] },
    { title: 'Hooks', pattern: 'Per-feature custom hooks under src/features/{feature}/hooks/', refs: ['src/features/users/hooks/useUsers.ts'] },
    { title: 'Routing', pattern: 'React Router 6 with role guards', refs: ['src/routes.tsx', 'src/auth/RequireRole.tsx'] },
    { title: 'i18n', pattern: 'i18next with EN + AR; logical CSS for RTL', refs: ['src/i18n/index.ts'] },
    { title: 'Tests', pattern: 'Vitest + React Testing Library + msw for API mocking', refs: ['src/features/users/__tests__/UserList.test.tsx'] },
  ]);

  writeStack('node-mock', 'Node mock-server', [
    { title: 'Routing', pattern: 'Express routers per resource, prefix /api/v1/*', refs: ['src/routes/users.js'] },
    { title: 'Spec compliance', pattern: 'Each handler returns shape matching OpenAPI schema', refs: ['src/routes/users.js:20'] },
    { title: 'Seed data', pattern: 'JSON fixtures under src/fixtures/', refs: ['src/fixtures/users.json'] },
  ]);

  writeStack('cdk', 'AWS CDK', [
    { title: 'Module layout', pattern: 'lib/stacks/ + lib/constructs/', refs: ['lib/stacks/StorageStack.ts'] },
    { title: 'Naming', pattern: '{project}-{stack}-{env}', refs: ['bin/app.ts'] },
    { title: 'Stage handling', pattern: 'CDK context: cdk deploy -c env=dev', refs: ['cdk.json'] },
    { title: 'Resource patterns — S3', pattern: 'Block public access, enforce SSL, versioning enabled', refs: ['lib/stacks/StorageStack.ts:18'] },
  ]);

  writeStack('nestjs', 'NestJS', [
    { title: 'Module structure', pattern: 'feature.module.ts groups controller + service + repository per feature', refs: ['src/publishers/publishers.module.ts'] },
    { title: 'Spec policy', pattern: 'api-first — OpenAPI is the source of truth, controllers generated via openapi-typescript-codegen', refs: ['openapi.yaml'] },
    { title: 'Persistence', pattern: 'TypeORM with explicit migrations under src/db/migrations/', refs: ['src/publishers/publisher.entity.ts'] },
    { title: 'Auth', pattern: '@UseGuards(JwtAuthGuard) on controller methods, JWT decoded by Passport strategy', refs: ['src/auth/jwt.strategy.ts'] },
    { title: 'Tests', pattern: 'Jest + supertest, separate e2e suite under test/', refs: ['test/publishers.e2e-spec.ts'] },
  ]);

  writeStack('fastapi', 'FastAPI', [
    { title: 'Module layout', pattern: 'app/api/{feature}/router.py + service.py + schemas.py', refs: ['app/api/billing/router.py'] },
    { title: 'Spec policy', pattern: 'api-first — generated openapi.yaml committed; FastAPI app validates against it on startup', refs: ['app/openapi.yaml'] },
    { title: 'Persistence', pattern: 'SQLAlchemy 2.x + Alembic migrations; sync engine, no asyncpg', refs: ['app/db/models.py'] },
    { title: 'Auth', pattern: 'Bearer token via fastapi.security.HTTPBearer, JWT verified with python-jose', refs: ['app/auth/dependencies.py'] },
    { title: 'Tests', pattern: 'pytest + httpx.AsyncClient against TestClient(app); fixtures in conftest.py', refs: ['tests/test_billing.py'] },
  ]);

  writeStack('python-worker', 'Python Worker', [
    { title: 'Trigger', pattern: 'AWS SQS — boto3.client("sqs").receive_message poll loop', refs: ['src/handlers/notifications.py'] },
    { title: 'Idempotency', pattern: 'Each message must be safe to re-process — DynamoDB conditional put on message_id', refs: ['src/util/idempotency.py'] },
    { title: 'Retry / DLQ', pattern: 'Failures raise; SQS handles retry up to maxReceiveCount=5, then DLQ', refs: ['src/handlers/notifications.py:42'] },
    { title: 'Logging', pattern: 'Structured JSON via structlog; each log includes message_id + handler_name', refs: ['src/log_config.py'] },
    { title: 'Tests', pattern: 'pytest + moto-mock for SQS / DynamoDB; tests run in-process', refs: ['tests/test_notifications.py'] },
  ]);

  writeStack('terraform', 'Terraform', [
    { title: 'Module layout', pattern: 'modules/{name}/{main,variables,outputs}.tf — composable units', refs: ['modules/vpc/main.tf'] },
    { title: 'State backend', pattern: 'S3 backend per env, DynamoDB lock table; `dev` and `prod` share the same backend bucket with prefix segmentation', refs: ['envs/dev/backend.tf'] },
    { title: 'Variable conventions', pattern: 'snake_case, nullable=true only when truly optional, descriptions required', refs: ['modules/rds/variables.tf'] },
    { title: 'Plan-as-artifact', pattern: 'CI runs terraform plan into a tfplan file, posts it to PR; apply is gated on human approval', refs: ['.github/workflows/terraform.yml'] },
    { title: 'Drift detection', pattern: 'Nightly terraform plan against prod posts to Slack on diff', refs: ['scripts/drift-check.sh'] },
  ]);
}

function writeArchitectureDiagrams() {
  // High-level capability view — sync vs async only, no infra detail.
  // Mirrors the platform.md service table: 3 backends + 1 worker + frontend.
  const overview = `flowchart LR
  user["User<br/>(Browser)"]
  fe["Frontend<br/>React + TanStack Query"]
  pub["publisher-svc<br/>Spring Boot"]
  search["search-svc<br/>NestJS"]
  billing["billing-svc<br/>FastAPI"]
  worker["notifications-worker<br/>Python (SQS)"]
  data[("Postgres + OpenSearch + S3")]
  bus[("Event bus — SQS")]

  user --> fe
  fe -->|REST + JWT| pub
  fe -->|REST + JWT| search
  fe -->|REST + JWT| billing
  pub --> data
  search --> data
  billing --> data
  pub -.->|book.* events| bus
  billing -.->|invoice.created| bus
  bus -->|consume| search
  bus -->|consume| worker
`;
  // Detailed topology — every service, DB, queue, Lambda, with edge labels.
  // Mock shown as local-dev sidecar; CDK + Terraform infra outlined.
  const detailed = `flowchart TB
  subgraph client[Client tier]
    fe[Frontend - React]
    mock[Mock Server - Express]
  end

  subgraph services[Service tier — 3 backends + 1 worker]
    pub[publisher-svc - Spring Boot]
    search[search-svc - NestJS]
    billing[billing-svc - FastAPI]
    worker[notifications-worker - Python]
  end

  subgraph data[Data — Terraform-owned]
    pubdb[(RDS Postgres - publisher)]
    billdb[(RDS Postgres - billing)]
    os[(OpenSearch - search)]
    idem[(DynamoDB - notification idempotency)]
  end

  subgraph infra[Per-service AWS — CDK-owned]
    s3[(S3 demo-books-dev)]
    sqs[(SQS book-events)]
    invq[(SQS invoice-events)]
    notifq[(SQS notification-queue)]
    cf[CloudFront - frontend CDN]
  end

  fe -->|REST| pub
  fe -->|REST| search
  fe -->|REST| billing
  fe -.->|local dev| mock
  cf -.-> fe

  pub --> pubdb
  pub --> s3
  pub -->|book.published| sqs

  search --> os
  sqs -->|consume + reindex| search

  billing --> billdb
  billing -->|invoice.created| invq
  invq -->|consume| worker

  sqs -->|*.notify| notifq
  notifq -->|consume| worker
  worker --> idem
  worker -.->|email + push| ext[/External providers/]
`;
  write(path.join(WS_DIR, 'context', 'architecture-overview.mmd'), overview);
  write(path.join(WS_DIR, 'context', 'architecture.mmd'), detailed);
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
| 1 | workspace-durable | stacks/spring-boot.md §1 | Auth pattern documented as SecurityConfig + @PreAuthorize (matches what shipped in PR #142) |
| 2 | workspace-durable | stacks/spring-boot.md §2 | Query pattern documented as Specification<>; reviewer correction post-merge |

### Findings flagged (plugin-level)
| # | Summary |
|---|---|
| 3 | Plugin-level: spring-boot implementer should default to declarative @PreAuthorize on greenfield code |

### Notes
- Invocation args: \`--pr=https://github.com/demo-org/demo-backend/pull/142 --note="reviewer pushed back on manual SecurityContextHolder reads"\`
- Duration: 2:15
- Learner tokens: ~18k
`;
  write(path.join(WS_DIR, 'context', 'learn-log.md'), body);
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
  appendJsonl(cp, { ts: isoOf(7, 3), event: 'agent_end', skill: 'discover', run_id: RUN_IDS.discover, phase: 'B2.5', stage: 'Stack discovery',   agent_type: 'general-purpose',    description: 'Stack pattern discovery across repos',     status: 'ok', total_tokens: 41205,  duration_ms: 58000  });
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

  // Phase outputs (placeholders that the reporter would have written)
  write(path.join(runDir, 'outputs', 'phase-1-requirements.md'), `# Phase 1 — Requirements\n\nFR-1 through FR-12 + EC-1 through EC-8 (synthesized).\n`);
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
| 5. Implementation       | Done    | 7m 02s | 385K | 3 tasks parallel |
| 5.5. Code Review        | Done    | 7m 45s | 201K | 3 critical → fixed |
| 6. Assessment           | Done    | 7m 40s | 174K | PASS |
| 7. Summary              | Done    | 3m 25s | 59K  | reporter + context-manager |
| **Total**               | —       | **41m 19s** | **998K** | — |

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
  // (mira / scribe) since Phase 5 + Phase 7 are intentionally omitted from the
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
  //   4: spring-boot-api-impl   (phase 5 — publisher-svc)
  //   5: nestjs-implementer     (phase 5 — search-svc)
  //   6: react-feature-impl     (phase 5 — frontend)
  //   7: mock-endpoint-impl     (phase 5 — mock)
  //   8: cdk-stack-impl         (phase 5 — infra-cdk)
  //   9: spring-boot-code-rev   (phase 5.5)
  //  10: react-code-reviewer    (phase 5.5)
  //  11: assessor               (phase 6)
  //  12: reporter               (phase 7)
  //  13: context-manager        (phase 7)
  //  14: run_end
  // All events conform to templates/checkpoints-event.schema.json + the
  // canonical examples in docs/observability.md:
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

  write(path.join(runDir, 'outputs', 'phase-1-requirements.md'), `# Phase 1 — Requirements\n\nFR-1 through FR-12 + EC-1 through EC-8 (synthesized).\n`);
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
    // Phase 5 — multi-stack fan-out. Five implementers run in parallel
    // (publisher-svc Spring Boot, search-svc NestJS, frontend React, mock,
    // infra-cdk) plus the UX consultant. Mira (UX) is preseeded queued by
    // the server, so her queued → working → done transition rides on
    // dispatch-log rows.
    () => {
      setPhase('5', 'IN_PROGRESS');
      setTask(1, 'IN_PROGRESS');
      setTask(2, 'IN_PROGRESS');
      setTask(3, 'IN_PROGRESS');
      setTask(4, 'IN_PROGRESS');
      setTask(5, 'IN_PROGRESS');
      upsertDispatch('mira', {
        phase: '5', agent: 'ux-consultant',
        duration: '—', tokens: '—', outcome: 'in_progress',
      });
      flush();
    },
    // UX finishes first (the user expects ux to complete before implementers).
    () => {
      upsertDispatch('mira', {
        duration: '3:08', tokens: '53K',
        outcome: 'success — IMPLEMENTATION_SPEC produced',
      });
      flush();
    },
    () => { setTask(1, 'COMPLETED'); flush(); emitCp(4); },  // spring-boot
    () => { setTask(2, 'COMPLETED'); flush(); emitCp(5); },  // nestjs
    () => { setTask(3, 'COMPLETED'); flush(); emitCp(6); },  // react
    () => { setTask(4, 'COMPLETED'); flush(); emitCp(7); },  // mock
    () => { setTask(5, 'COMPLETED'); setPhase('5', 'COMPLETED'); flush(); emitCp(8); },  // cdk
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
      emitCp(9);
    },
    () => {
      upsertDispatch('crit-fe', {
        duration: '6:00', tokens: '119K',
        outcome: 'success — NEEDS_FIXES: 2 critical (route guard + render-ref)',
      });
      flush();
      emitCp(10);
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
    () => { setPhase('6', 'COMPLETED'); flush(); emitCp(11); },
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
      emitCp(12);
    },
    () => { setPhase('7', 'COMPLETED'); flush(); emitCp(13); },
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
      emitCp(14);
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
| 5. Implementation       | Done    | 7m 02s | 385K | 3 tasks parallel |
| 5.5. Code Review        | Done    | 7m 45s | 201K | 3 critical → fixed |
| 6. Assessment           | Done    | 7m 40s | 174K | PASS |
| 7. Summary              | Done    | 3m 25s | 59K  | reporter + context-manager |
| **Total**               | —       | **41m 19s** | **998K** | — |

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
    findings.push(`### Finding ${i + 1} — workspace-durable — stacks/spring-boot.md

**Observation**: Implementer used manual SecurityContextHolder.

**Correction**: Use @PreAuthorize annotation declaratively.

**Evidence**:
> "We always declare auth via @PreAuthorize — never read SecurityContextHolder inside service methods"
> — reviewer comment on demo-backend PR #142

**Tier**: \`workspace-durable\`

**Confidence**: \`high\`

**Target**: \`{workspace_root}/${WORKSPACE_SLUG}/context/stacks/spring-boot.md\` §1
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
writeStacks();
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
console.log(`     stacks docs:       8 (spring-boot, nestjs, fastapi, python-worker, react, node-mock, cdk, terraform)`);
console.log(`     diagrams:          architecture.mmd + architecture-overview.mmd`);
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
