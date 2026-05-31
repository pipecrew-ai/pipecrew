# Node Mock Server — Known Anti-Patterns

Seed list for `type: node-mock` repos.

## Spec drift

- Mock response shape must match the OpenAPI spec **byte-for-byte** — field names, optionality, enum values, pagination envelope. A mock that responds with `{ pagination: {...}, items: [...] }` when the spec says `{ data, totalElements, totalPages, page, size }` silently breaks the frontend until integration time.
- Pre-cast every response through a shape-checker before returning (even a simple one like `JSON.stringify(expected).keys == JSON.stringify(actual).keys` suffices at dev time).

## Path prefix

- The `servers: [{url: ...}]` field in the spec is aspirational; live routes in the mock may use a different prefix (`/v1/backoffice` vs `/api/v1`). Match whatever existing live routes use in the repo, not the spec's `servers.url`.

## Seed data coverage

- Every enum value in the spec needs at least one seed row if the corresponding filter is tested. An empty `statuses` array that a status-filter loop references via `[i % arr.length]` produces `undefined` silently.
- Cover "no file" / "null field" cases — these are the ones that trip up `hasSignedFile` toggles and 404-on-missing endpoints.

## Download endpoints

- `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="..."`, `Content-Length` — all three. A minimal `%PDF-1.4\n%%EOF` stub is acceptable for mock.
- 404 body for no-file-available case must include the same error-code field (`CONTRACT_FILE_NOT_AVAILABLE` etc.) the real backend uses — frontend branches on it.

## Cross-publisher / cross-tenant scoping

- Mock must return 404 (not 403) for cross-tenant access. Simulating only the happy path hides existence-leak bugs that the real backend would catch.

## Dev script parity

- `npm run dev` should run with a watcher (nodemon) — not equal `npm start`. Missing watcher means every mock change requires a manual restart and silently misleads developers about whether changes are applied.

## Package discipline

- Version consistency across sub-services (multer, express, body-parser) — version skew across sister mocks causes divergent behavior.
- An `engines` field pinning Node version documents the contract.
