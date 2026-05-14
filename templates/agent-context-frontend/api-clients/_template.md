# {{SERVICE_NAME}} API Client

<!-- human-owned -->

## Service Overview

{{SERVICE_OVERVIEW_PARAGRAPH}}

| Property | Value |
|---|---|
| Base URL config key | `{{BASE_URL_CONFIG_KEY}}` |
| Default URL (dev) | `{{DEFAULT_DEV_URL}}` |
| Auth model | {{AUTH_MODEL}} |
| Client file | `{{CLIENT_FILE_PATH}}` |
| Service file | `{{SERVICE_FILE_PATH}}` |
| Types file | `{{TYPES_FILE_PATH}}` |

## Authentication

{{AUTH_DETAILS}}

<!-- /human-owned -->

<!-- agent-updatable -->

## Endpoints Used

{{ENDPOINTS_USED_TABLE}}

## Types

{{TYPES_TABLE}}

<!-- /agent-updatable -->

<!-- human-owned -->

## Error Handling Specific to This Service

{{SERVICE_ERROR_HANDLING}}

## Adding a Call to This Service

{{ADDING_CALL_STEPS}}

## Known Divergences (Do Not Replicate)

{{KNOWN_DIVERGENCES_LIST}}

<!-- /human-owned -->

<!--
AGENT INSTRUCTIONS (strip these comments before writing the final file):

This is the canonical shape for api-clients/{service}.md. Copy this
template, rename to a short lowercase name matching the backend service
(publisher.md, backoffice.md, user-management.md), and fill the
placeholders.

- {{SERVICE_NAME}}: human-readable name (e.g., "Publisher", "Backoffice",
  "User Management"). Used as the H1.
- {{SERVICE_OVERVIEW_PARAGRAPH}}: 1-2 sentences naming what this service
  is responsible for and which app surfaces consume it.
- {{BASE_URL_CONFIG_KEY}}: the env-var-style key in src/api/config.ts
  (e.g., VITE_PUBLISHER_API_URL).
- {{DEFAULT_DEV_URL}}: localhost URL used in dev when the env var is
  absent.
- {{AUTH_MODEL}}: short string (e.g., "JWT Bearer", "X-Internal-Request",
  "API Key").
- {{CLIENT_FILE_PATH}}: path of the client file (e.g.,
  src/api/clients/publisher.client.ts).
- {{SERVICE_FILE_PATH}}: path of the service functions file.
- {{TYPES_FILE_PATH}}: path of the types file.
- {{AUTH_DETAILS}}: how auth headers are injected, refresh handling,
  per-endpoint exceptions.
- {{ENDPOINTS_USED_TABLE}}: AGENT-UPDATABLE markdown table Method | Path |
  Service Function | Used By columns. Add rows when new endpoints are
  consumed.
- {{TYPES_TABLE}}: AGENT-UPDATABLE markdown table Type | Purpose. Cover
  the request/response interfaces for this service.
- {{SERVICE_ERROR_HANDLING}}: any error patterns specific to this service
  (retryable codes, custom error response shapes).
- {{ADDING_CALL_STEPS}}: numbered list (config.ts → types/ → services/ →
  index.ts → use in component).
- {{KNOWN_DIVERGENCES_LIST}}: bulleted list of footguns observed in how
  this service is currently consumed (e.g., one endpoint that returns
  inconsistent shapes, deprecated routes still in use).
-->
