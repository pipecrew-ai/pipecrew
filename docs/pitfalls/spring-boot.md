# Spring Boot — Known Pitfalls

Seed list of predictable failure modes to inject into Phase 4.5 task files for `type: spring-boot` repos. The task-file generator selects the subset relevant to the endpoints + data model in scope.

## Exception → HTTP status convention

- Many repos map `IllegalArgumentException` → **400**. If the spec documents **404** for "not-found", a bespoke `XxxNotFoundException` must be created AND registered in `GlobalExceptionHandler` before the endpoint ships. Tests that assert `isBadRequest()` for a cross-entity-not-found are asserting the bug, not the spec.
- `PublisherNotFoundException` and siblings that extend `IllegalArgumentException` create handler-ordering fragility — prefer extending `RuntimeException` directly and relying on explicit `@ExceptionHandler` dispatch.
- For "exists but forbidden" cross-entity cases (e.g., publisher-A tries to read publisher-B's row), return the same 404 as "doesn't exist" to avoid existence leaks. Do NOT return 403 — it leaks that the ID is valid.

## JPQL / Hibernate 6 (Spring Boot 3.2+)

- Ad-hoc `JOIN EntityA a JOIN EntityB b ON b.x = a.x` between entities that have NO mapped `@ManyToOne`/`@OneToOne` association will throw `SemanticException` at runtime. Tests that mock `EntityManager.createQuery` hide this — the failure only surfaces under real Hibernate.
- Fix: add the `@ManyToOne(fetch = LAZY) @JoinColumn(..., insertable = false, updatable = false)` association and use path-based join (`JOIN a.b`). Or use a correlated subquery (`WHERE a.x IN (SELECT b.x FROM EntityB b WHERE ...)`).
- Service-layer integration tests should execute against an in-memory H2 or a Testcontainers Postgres so cross-entity JPQL is actually parsed.

## DB schema / migrations

- Hibernate `ddl-auto: validate` fails at startup on nullability mismatch between JPA annotation and Liquibase column definition. Check `@Column(nullable = false)` vs `constraints: nullable: ...` on every new column.
- DB CHECK constraints that enumerate status values MUST be updated every time a new enum value is added. Silent acceptance of unpersistable enum variants is a common trap.
- Add explicit indexes for every filter + sort column used by a list endpoint (`(status, updated_at DESC)`, `contract_request_id`, etc.). SQL planners do not fall back gracefully on 50k-row tables.

## Sort / filter param validation

- Default-arm switch on a free-form `sort` string silently swallows invalid values. The spec's `sort` enum does not validate at binding when the generator emits `String`. Validate against an explicit allowlist in the service layer; throw `IllegalArgumentException` with the offending value for 400.
- `MethodArgumentTypeMismatchException` handlers should echo `ex.getValue()` into the `details` map so callers see the rejected enum string.

## Role / authz matrix

- Role-gate checks in service code (`SecurityContextHolder.getContext().getAuthentication()`) bypass the HTTP layer, so tests that mock `MockMvc` with an unauthenticated principal may pass even if the controller would receive a valid JWT at runtime. Add explicit role-denial tests per HTTP method for every denied role — NOT just one representative.
- If the platform has a known multi-role permission bug (first-match-wins), document it in the task's "Known Pitfalls" section so implementers don't accidentally rely on the broken behavior.

## N+1 queries

- List endpoints that map each row through a `repository.findById` for related data are N+1 by construction. Batch-fetch with `findAllById(ids)` + `Map<UUID, Entity>` lookup before the stream's `.map(...)`.
- This is particularly dangerous when the list max page size is 100 — p95 latency explodes.

## Streaming / S3

- Download endpoints: use `InputStreamResource` wrapping the live S3 `ResponseInputStream` — never read into a `byte[]`. `StreamingResponseBody` is also fine; both are non-buffering.
- Handle `NoSuchKeyException` explicitly and re-throw as a 404 `FileNotFoundException`-equivalent. Broad `catch (Exception e)` that silently returns a placeholder masks runtime S3 issues.
- `Content-Length` via `headObject` is one extra S3 call — acceptable on the download path but never on list paths.

## SQS payload compatibility

- When extending an existing SQS event payload, every new field MUST be optional and Jackson-tolerant (`@JsonProperty` without `required = true`, default null). Deploy publisher-before-consumer or consumer-before-producer based on which side is tolerant — document the order in the architect design.

## DI / bean wiring

- `new ObjectMapper()`, `new BCryptPasswordEncoder()`, `new ObjectMapper()` in service methods bypass Spring's DI and the configured bean customizations (dates, null-inclusion policy). Inject the bean.
- `@Modifying` repository methods without `@Transactional` throw `TransactionRequiredException` when called outside a transactional context. Annotate the method directly — don't rely on the caller.
- `@Bean` declared but never `@Autowired`ed is dead code. `@Component` on a filter class without a matching `FilterRegistrationBean` means the filter is never in the chain.

## Hard-coded config / secrets

- Any bucket name, queue name, or secret in `application-*.yaml` must cross-reference a provisioned resource in the infra repo. Missing bucket = runtime `NoSuchBucket`. Cross-check against `abvi-infra/**` (or equivalent) during the architect phase and flag via an infra sub-task if new resources are needed.
- Hard-coded secrets, API keys, or bypass headers committed to YAML are critical findings — move to Secrets Manager.

## OpenAPI code generation

- Never edit `target/generated-sources/` — regenerate instead.
- Annotation-processor order in `pom.xml` matters: Lombok first, then MapStruct. Changing it breaks generated mappers silently.
- The generated `Api` interface MUST be implemented by the controller; do NOT add `@RequestMapping` on controller methods.
