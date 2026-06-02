# Discovery-Mode Diagram Rules

**Load only in `/discover` Phase B2** — the solution-architect reads this file when generating architecture diagrams. It is NOT included in the agent's system prompt to keep the context window lean during `/deliver` design-mode invocations.

The architect produces two complementary Mermaid files during discovery:

1. `architecture-overview.mmd` — high-level C4-style block diagram for a new team member.
2. `architecture.mmd` — detailed topology with every service, DB, queue, Lambda.

Both render live in the site-view "Project" drawer via `mermaid.js`.

---

## Mermaid conventions for `architecture-overview.mmd` (high-level)

**Audience**: a new team member who just joined. They need to understand the system shape in under 30 seconds. If the diagram takes longer to read than that, simplify.

### Block taxonomy — ONLY these four categories, each in its own subgraph

1. **Frontends** — user-facing SPAs / web apps
2. **Backend services** — HTTP services AND async Lambdas/workers (Lambdas count as services here)
3. **Queues / Topics** — SQS queues, SNS topics, any message bus
4. **Data sources** — databases and object storage

### Node shapes — consistent per category

- Frontends: rectangle `[label]`
- Backend services: rectangle `[label]` (styled prominently — largest font, bold)
- Queues: subroutine shape `[[label]]`
- Data sources: cylinder `[(label)]` (the "database icon" convention — applies to both RDS and S3 for shape consistency)

### Node labels — short and scannable

- Drop organization/company prefixes (e.g., `abvi-`) from service names unless the prefix IS the AWS resource name.
- Databases: use short logical names (`auth_db`, `publisher_db`), not the full AWS name (`abvi_auth_db_prod`).
- Object storage (S3): use a short logical purpose (`books S3`, `bulk upload S3`) rather than the full bucket name — the cylinder shape is narrow and long names get truncated. The detailed diagram carries the full AWS names.
- Queues: short logical name (`email-send`, `bulk-review`), same reason.
- Prefer single-line labels. Use `<br/>` only when a meaningful two-part split clarifies the role.

### Edge semantics — only two kinds, every edge labeled

- `-->` **synchronous** interaction. Label with ONE word: `REST`, `access`, `validate`.
- `-.->` **asynchronous** interaction. Label with ONE word: `queue`, `event`, `poll`, `upload`.

No `==>` in the overview diagram (detailed-diagram convention only). Every edge gets a label — if you can't label it in one word, you're drawing an implementation detail that doesn't belong here.

### What to INCLUDE

- Every frontend (production only — drop dev-only mocks)
- Every backend service, grouped
- Every queue / topic
- Every database and object-storage bucket
- Frontend → backend sync edges
- Service → own-DB edges
- All async flows (they define the async architecture)

### What to EXCLUDE

- End users / actor nodes (implied by the frontend existing)
- External third-party systems (out of scope)
- Edge infrastructure (CloudFront, ALB — transport not blocks)
- Secrets Manager, monitoring, logging
- Capability-domain groupings ("Identity", "Catalog", "Review Workflow") — those are conceptual, not physical
- Mock servers (dev-only)
- Inter-service JWT-validate edges (every service validates tokens — noise)
- Inter-service read edges unless they represent a MAJOR coupling. Routine cross-service reads are implementation detail.

### classDef palette (consistent tones across workspaces)

```
classDef frontend fill:#E6F4EA,stroke:#1E8E3E,stroke-width:1.5px,color:#0D5223,font-size:14px
classDef service  fill:#FFF4E5,stroke:#E67C00,stroke-width:2px,color:#5A3A00,font-size:17px,font-weight:600
classDef queue    fill:#FDECEA,stroke:#C5221F,stroke-width:1.5px,color:#7A0D0D,font-size:13px
classDef data     fill:#E8F0FE,stroke:#1A73E8,stroke-width:1.5px,color:#0B3D91,font-size:14px
```

Services get the largest/bold font — they're the visual-dominant row. Data sources 14px. Queues 13px. This hierarchy is deliberate: a new joiner looks at services first.

### Init directive — line 1 of every overview file

```
%%{init: {"flowchart": {"nodeSpacing": 55, "rankSpacing": 70, "curve": "basis", "padding": 15, "htmlLabels": true}}}%%
```

### Simplification discipline — target and checklist

- Target: **~10 nodes, 12-15 edges.** If more, cut. Collapse duplicates (one "S3 books" node rather than `book-metadata` + `book-data` if they serve the same purpose).
- After drafting, step back and ask: *"Can a new team member see the system shape in 30 seconds?"* If not, cut more. Common cuts: inter-service reads, duplicate data sources, actor nodes, edge infra.

### Lexical safety (parse-error prevention)

- No periods inside dotted-edge labels (`-.LABEL.->`) — the terminating `.` is swallowed.
- No unescaped `<` or `>` in labels; only `<br/>` is allowed. **No `<b>`, `<span>`, `<font>`, `<div>` or any other HTML tag** — styling belongs exclusively in `classDef`, never inline.
- No reserved words as node IDs (`graph`, `subgraph`, `end`, `classDef`).

### Self-check BEFORE returning the overview diagram

Walk this checklist item-by-item. If any item fails, fix the diagram. Do NOT return a diagram that fails even one item — compliance is enforced.

1. **All 4 subgraphs present**: `Frontends`, `"Backend services"`, `"Queues / Topics"`, `"Data sources"`. Nothing else.
2. **Lambdas are INSIDE `Backend services`** (not their own category). Every Python Lambda, every async worker, every non-HTTP code unit = a backend service node.
3. **No excluded blocks**: zero user/actor nodes, zero external-system nodes (Zoho, Stripe, etc.), zero edge infra (CloudFront, ALB, Nginx), zero Secrets Manager, zero capability-domain groupings ("Identity", "Review Workflow"), zero mock servers.
4. **Every edge is labeled**. Run your eye down every `-->` and `-.->` line. Even service→own-DB edges need a label — use `access` if nothing better fits.
5. **Labels are ONE word** (`REST`, `access`, `validate`, `queue`, `poll`, `event`, `publish`, `upload`). Multi-word labels (`Feign PublisherClient`) belong in the detailed diagram, NOT here.
6. **Zero inter-service validate/read noise**: no `PUB -->|validate| UM`, no `BO -->|read| PUB`, no routine cross-service Feign edges. If they exist in the detailed diagram, they stay there.
7. **classDef palette matches EXACTLY** — copy the fill/stroke/color hex codes from the palette block above. The queue is `fill:#FDECEA` (red), NOT purple (`#F3E8FD`). The frontend class is `font-size:14px` with normal weight, NOT bold 17px. Only the `service` class is 17px bold.
8. **No HTML tags in labels except `<br/>`**. Grep your output for `<b>`, `<span>`, `<font>`, `<div>`, `<em>`, `<i>`, `<strong>` — if any appear, strip them. Let `classDef` do the styling.
9. **Data-source labels are short** (`auth_db`, `books S3`) — if any label would be clipped by the cylinder shape, shorten it further. The detailed diagram holds the full AWS resource names.
10. **Node count ≤ 15**. If higher, collapse duplicates (e.g., `book-metadata` + `book-data` S3 buckets → one `books S3` node).
11. **Init directive on line 1** — the `%%{init: ...}%%` line is present with the exact config defined above.
12. **Lexical safety**: grep for `-.` followed by any text containing `.` before `.->` — that's a parse error waiting to happen.

If all 12 pass, the diagram is ready to return. If you catch one on step 9 but fixing it cascades into a step 3 violation, fix both — do not return partial compliance.

---

## Mermaid conventions for `architecture.mmd` (detailed)

**Audience**: an implementer who needs to know "what actually talks to what" before changing code. Every real resource is drawn; every edge carries its specific label (endpoint prefix, Feign client name, queue ARN).

- Use `graph LR` unless the topology is clearly top-down (then `graph TB`).
- Group related nodes in `subgraph` blocks: Frontends, Services, Workers, Databases, Infrastructure, External.
- Edge conventions:
  - `-->` for **synchronous REST/RPC** calls — label with the endpoint prefix, Feign client name, or route.
  - `-.->` for **async events** — label with the queue/topic name.
  - `==>` for **shared-resource writes** — DB write, S3 upload.
- `classDef` styling: `infra` (blue tones), `frontend` (green tones), `worker` (purple tones), `external` (orange tones), `orphan` (red dashed — for resources that exist but have no current owner).
- Draw only edges you confirmed in code or configuration. If an integration is ambiguous, leave it out and flag it under `## Open Questions` in platform.md.

Full phase-specific instructions (exact section list, skeletons, post-processing) live in `skills/discover/phases/phase-b2-architect-synthesis.md` — the orchestrator inlines the relevant parts at dispatch time.
