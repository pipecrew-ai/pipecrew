# Spec-policy modes — api-first, code-first, no-api

> Every backend `*-implementer.md` agent in this plugin references this document, alongside `{plugin_dir}/rules/implementer-common.md`. It defines the three contract modes the pipeline supports, who decides which to use, and what each downstream stage does per mode.

> `rules/reviewer-common.md` Step 4 mirrors this doc on the review side — reviewers walk the contract per `spec_policy` using the matching directive. Edits to mode semantics must keep the two files consistent.

---

## The three modes

| `spec_policy` | When it applies | Contract source |
|---|---|---|
| **`api-first`** | The repo has (or will gain) a hand-edited OpenAPI YAML spec at HEAD. The spec is the lead artifact; the implementation conforms to it | The OpenAPI spec file (`spec_file`) |
| **`code-first`** | The repo has no spec, or the team's working pattern is to write code first and treat the spec as a build artifact (or skip the spec entirely) | The architect's inline contract block (`inline_contract`) inside the task file's `API_DESIGN` section |
| **`no-api`** | The repo has no HTTP endpoints — it's an event-driven worker (SQS / SNS / Kinesis / Kafka / Celery / scheduled). HTTP-flavored contract concepts don't apply | The event schema file(s) in a shared schema repo (JSON Schema / Avro / Protobuf), passed as `event_schemas` |

**`api-first` is the recommended default.** It is the only mode that produces a hand-maintained spec artifact other services can consume. When an OpenAPI spec exists OR can reasonably be authored, prefer `api-first`. Use `code-first` only when the workspace's existing convention precludes it.

---

## Per-stack support

| Stack | Implementer | Modes supported | Default |
|---|---|---|---|
| Spring Boot | `spring-boot-api-implementer` | `api-first` \| `code-first` | api-first |
| NestJS | `nestjs-implementer` | `api-first` \| `code-first` | api-first |
| FastAPI | `fastapi-implementer` | `api-first` \| `code-first` | api-first |
| Flask | `flask-implementer` | `api-first` \| `code-first` | api-first |
| Django · DRF | `django-implementer` | `api-first` \| `code-first` | api-first |
| Python worker | `python-worker-implementer` | `no-api` (always) | n/a |

Frontend stacks (React, Next.js) consume the contract but don't produce one — `spec_policy` is not an input on those implementers. Mock servers (`mock-endpoint-implementer`) mirror the API and follow the same spec.

**Naming note**: the name `spring-boot-api-implementer` predates dual-mode support; the `-api-` infix is historical, not a constraint. It supports both modes.

---

## Where `spec_policy` is set

`spec_policy` is a **per-service field in the workspace config** (`config.services[svc].spec_policy`), set once at `/discover` time:

| Condition (during `/discover` Phase A Step 3.5) | Inferred `spec_policy` |
|---|---|
| Repo `role` is `api-service` AND an OpenAPI spec file was found | `api-first` (default for stacks with a spec) |
| Repo `role` is `api-service` AND no spec file was found | `code-first` |
| Repo `role` is `worker` (python-worker or other non-HTTP runtime) | `no-api` |

The user reviews and can correct the inferred policy at the `/discover` Step 6 confirmation gate. Once written to `config.json`, the value is binding for every subsequent `/deliver` run.

**`api-first` is the recommended default and is auto-selected whenever a spec exists.** `code-first` is the fallback for spec-less repos. If you want to convert a `code-first` service to `api-first`, hand-author an OpenAPI spec, then re-run `/discover --refresh-cache` (which will detect the spec and flip the policy) — OR edit `config.json` directly and add the `spec_file` field.

## How each phase uses `spec_policy`

Once set, the policy flows through every downstream phase:

- **`/deliver` Phase 2 (architect)** — reads `config.services[svc].spec_policy` and emits a matching `API_DESIGN` block per service (a short spec reference for `api-first`, an inline contract for `code-first`, an Event Triggers block for `no-api`). See `agents/solution-architect.md` § "spec_policy — three flavors" for the emit format.
- **`/deliver` Phase 3 (spec edit)** — runs `openapi-spec-editor` only for `api-first` services. Skips `code-first` (no spec to edit) and `no-api` (Phase 3a handles event schemas instead).
- **`/deliver` Phase 4.5 (task planner)** — copies `spec_policy` into each task file's frontmatter, plus the matching contract input (`spec_file` for api-first, `inline_contract` for code-first, `event_schemas` for no-api).
- **`/deliver` Phase 5 (implementer)** — reads `spec_policy` from the task file (per R0) and follows the matching directive below.
- **`/deliver` Phase 5.5 (reviewer)** — reads `spec_policy` from the dispatch's `## Contract inputs` block and applies the matching contract-compliance pass from `rules/reviewer-common.md` Step 4.

---

## What Phase 3 does per mode

Phase 3 of `/deliver` is the spec-edit phase. It runs differently per service based on the service's `spec_policy`:

| Mode | Phase 3 action |
|---|---|
| `api-first` | Dispatch `openapi-spec-editor` against this service's repo. Edits the YAML spec to add the new endpoints / schemas. User reviews the spec diff at the Phase 3 gate. |
| `code-first` | **Skip** Phase 3 for this service. The inline contract from Phase 2 IS the contract; nothing to edit. Phase 3 still runs for any api-first services in the same feature. |
| `no-api` | Run **Phase 3a** (contract / schema edit) instead — `schema-implementer` updates event schemas in the contract repo. The OpenAPI spec edit is skipped. |

A feature that touches multiple services with different `spec_policy` values is normal — Phase 3 dispatches selectively.

---

## What the implementer does per mode

When an implementer is dispatched in Phase 5, the task file's `## Contract inputs` section names the mode and the contract source. The implementer follows the matching directive:

### `spec_policy: api-first`

The dispatch sets `spec_file` to the absolute path of the service's OpenAPI spec inside the worktree.

- Read the spec for the affected endpoints (paths, methods, request/response schemas, status codes, security).
- Match every DTO / model field-by-field against the spec schema — same names, same nullability, same enums.
- Match every endpoint annotation / decorator against the spec path + method.
- Match every status code the controller / view returns against the spec's declared codes.
- Any drift is a Critical issue at review time. Treat the spec as immutable from the implementer's side — Phase 3 already edited it; do not touch the spec file in Phase 5.

### `spec_policy: code-first`

The dispatch sets `inline_contract` to the architect's full inline contract block (copied verbatim from the Phase 2 `API_DESIGN` output for this service).

- Treat the inline contract as the spec. Walk every new DTO / model and endpoint implementation field-by-field against it. Drift = Critical.
- Use the inline contract's status codes verbatim — every code it lists must be reachable from the service.
- Apply the same validation discipline as api-first — field names exact, types exact, nullability exact.
- Do NOT generate or scaffold an OpenAPI spec on the side. The workspace's convention says no spec — respect that. The architect's `API_DESIGN` block remains the audit trail.
- For FastAPI specifically: FastAPI's runtime spec (generated by the framework from Pydantic + decorators) will naturally exist as a build artifact at `/openapi.json`. That's fine. Do not check it into the repo; the inline contract is still the source of truth.

### `spec_policy: no-api`

The dispatch sets `event_schemas` to the list of `(schema_repo_path, schema_file_path)` pairs for the event types this worker consumes or produces.

- Read each schema file. Walk every typed event model in your code field-by-field against its schema. Drift = Critical.
- Verify the idempotency guard, partial-failure reporting, DLQ + retry config per `rules/reviewer-common.md` Step 4's `no-api` directive (the reviewer enforces the same set).

---

## Task-file frontmatter contract (per mode)

When the orchestrator creates an implementer task file (Phase 4.5), the YAML frontmatter includes `spec_policy` and the matching contract input. Per mode:

```yaml
# api-first
spec_policy: api-first
spec_file: /abs/path/to/spec.yaml
inline_contract: null

# code-first
spec_policy: code-first
spec_file: null
inline_contract: |
  Method: POST
  Path: /v1/books/{id}/content
  Request: ...
  Response: ...
  Status codes: 201, 400, 403, 409, 422

# no-api
spec_policy: no-api
spec_file: null
inline_contract: null
event_schemas:
  - { schema_repo_path: ..., schema_file_path: ... }
```

The implementer reads its mode from the frontmatter (per R0 — task file is your source of truth). It does NOT ask the caller to confirm the mode — the architect's choice in Phase 2 is binding for this feature.

---

## How to convert a code-first service to api-first

`code-first` is the fallback for spec-less repos. To upgrade a service from `code-first` to `api-first`:

1. Hand-author an OpenAPI YAML at the repo root (e.g., `openapi.yaml` or `specs/api.yaml`).
2. Re-run `/discover --refresh-cache --workspace=<slug>` — the cache invalidation will trigger a re-scan; Phase A Step 3.5 will detect the new spec and emit `spec_policy: api-first` for the service.
3. OR edit `config.json` directly: set `services[svc].spec_policy: "api-first"` and `services[svc].spec_file: "<relative path>"`. Validate with `node {plugin_dir}/scripts/validate-config.js`.

Either path is reversible. The plugin does not block a downgrade from `api-first` to `code-first`, but doing so abandons the spec artifact — which most cross-service tooling (frontend codegen, mock servers, contract tests) depends on. Don't downgrade without a deliberate reason.

---

## Cross-reference

- `{plugin_dir}/rules/implementer-common.md` — R0 references `spec_policy` and the inline contract as task-file frontmatter; the implementer trusts the frontmatter over conversation context.
- `{plugin_dir}/rules/reviewer-common.md` — Step 4 (contract compliance pass) handles all three modes with mirrored directives. Reviewer enforcement matches implementer behavior.
- `{plugin_dir}/skills/deliver/phases/phase-3-spec-edit.md` — implements the Phase 3 skip behavior for code-first / no-api services.
- `{plugin_dir}/skills/deliver/phases/phase-2-architecture.md` — defines the architect's choice criteria above and the `AFFECTED_SERVICES` block format.
