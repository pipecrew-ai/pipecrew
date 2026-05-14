# Domain: {{BOUNDED_CONTEXT_NAME}}

## Bounded Context

{{BOUNDED_CONTEXT_PARAGRAPH}}

In scope:
{{IN_SCOPE_BULLETS}}

Out of scope (lives elsewhere):
{{OUT_OF_SCOPE_BULLETS}}

For product framing (what the parent product is, who the actors are), see
`../business-context.md`.

## State Model

{{STATE_MODEL_DIAGRAM_OR_TABLE}}

{{STATE_TRANSITIONS_DESCRIPTION}}

## Actors and Permissions

{{ACTORS_PERMISSIONS_TABLE}}

<!-- human-owned -->

## Invariants

{{INVARIANTS_LIST}}

<!-- /human-owned -->

## External Workflow Wiring (if applicable)

{{WORKFLOW_WIRING_DETAILS}}

<!-- agent-updatable -->

## Key Services / Entry Points

{{KEY_SERVICES_TABLE}}

<!-- /agent-updatable -->

## Filtering and Pagination (if applicable)

{{FILTERING_PATTERNS}}

<!-- human-owned -->

## What NOT to Do

{{WHAT_NOT_TO_DO_BULLETS}}

<!-- /human-owned -->

<!--
AGENT INSTRUCTIONS (strip these comments before writing the final file):

This is the canonical shape for domains/{name}.md. Copy this template,
rename to a lowercase-dashed bounded-context name (e.g., book-review.md,
contracts.md), and fill the placeholders.

Create a new domain file ONLY when the bounded context has real workflow
complexity:
  - 3+ states with non-trivial transitions, OR
  - Multiple roles with different permissions, OR
  - Load-bearing invariants not obvious from code, OR
  - External workflow wiring (engine, scheduler, queue).

If the "domain" is just CRUD on an entity, do NOT create a file — extend
database.md and conventions.md instead.

- {{BOUNDED_CONTEXT_NAME}}: human-readable title (e.g., "Book Review Workflow",
  "Contract Signing"). Used as the H1.
- {{BOUNDED_CONTEXT_PARAGRAPH}}: 2-4 sentences describing what this context
  covers in business terms.
- {{IN_SCOPE_BULLETS}}: bulleted list of tables, workflows, and operations
  this context owns.
- {{OUT_OF_SCOPE_BULLETS}}: bulleted list of adjacent things owned by other
  contexts or other services. Name the owner.
- {{STATE_MODEL_DIAGRAM_OR_TABLE}}: ASCII diagram of state transitions if
  there are 5+ states; otherwise a table. Show terminal vs intermediate
  states clearly.
- {{STATE_TRANSITIONS_DESCRIPTION}}: prose describing the meaning of each
  state and what causes each transition.
- {{ACTORS_PERMISSIONS_TABLE}}: markdown table with Actor | Group/Role |
  Operations columns.
- {{INVARIANTS_LIST}}: bulleted list of business rules that MUST hold —
  these are the load-bearing assertions the codebase enforces. HUMAN-OWNED:
  these define the domain; agents follow them, don't change them.
- {{WORKFLOW_WIRING_DETAILS}}: external engine wiring (Flowable task keys,
  Temporal workflow IDs, Step Functions ARNs, queue names, business keys).
  Skip if no external workflow engine.
- {{KEY_SERVICES_TABLE}}: AGENT-UPDATABLE table mapping File | Responsibility.
  When new services are added in this domain, add a row.
- {{FILTERING_PATTERNS}}: query/filter shapes if relevant; skip otherwise.
- {{WHAT_NOT_TO_DO_BULLETS}}: domain-specific footguns.
-->
