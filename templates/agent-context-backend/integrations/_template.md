# {{INTEGRATION_NAME}} Integration

<!-- human-owned -->

{{INTEGRATION_OVERVIEW_PARAGRAPH}}

---

{{INTEGRATION_RESOURCE_SECTIONS}}

---

## Region / Endpoint / Credentials Summary

<!-- /human-owned -->

<!-- agent-updatable -->

{{REGION_CREDS_TABLE}}

<!-- /agent-updatable -->

<!-- human-owned -->

---

## Known Divergences (Do Not Replicate)

These are real footguns in the existing code. Read them; do not copy them.

{{KNOWN_DIVERGENCES_LIST}}

<!-- /human-owned -->

<!--
AGENT INSTRUCTIONS (strip these comments before writing the final file):

This is the canonical shape for integrations/{name}.md. Copy this template,
rename to a short lowercase name matching the external system (aws.md,
kafka.md, stripe.md, datadog.md), and fill the placeholders.

ONE file per external system. Cross-cutting concerns that are NOT
integrations (logging, security, observability) belong in the matching
top-level file (infrastructure.md, authentication.md), not here.

- {{INTEGRATION_NAME}}: human-readable name (e.g., "AWS", "Kafka",
  "Stripe"). Used as the H1.
- {{INTEGRATION_OVERVIEW_PARAGRAPH}}: 2-3 sentences naming SDK + version,
  region/endpoint conventions, credential source, what this integration is
  used for at a high level.
- {{INTEGRATION_RESOURCE_SECTIONS}}: one ## section per resource type used
  (S3, SQS, Secrets Manager OR Topic, Stream, Consumer Group OR Charges,
  Subscriptions, Webhooks). Each section: client wiring, config source,
  operations used, test/local override pattern.
- {{REGION_CREDS_TABLE}}: AGENT-UPDATABLE markdown table with Component |
  Region/Endpoint | Credentials columns. One row per client/initializer.
  Update when a new client is added.
- {{KNOWN_DIVERGENCES_LIST}}: bulleted list of footguns observed in
  existing code. Each entry: file + line, the divergence, the right
  pattern, why the existing code is wrong. This is the most load-bearing
  section — agents read it to avoid repeating mistakes.
-->
