# Stack Pitfalls Catalog

Curated, stack-specific failure modes for each `type` in the workspace config. The Phase 4.5 task-file generator reads the relevant file plus the workspace's `audit-findings.md` to inject a `## Known Pitfalls` section into every implementation task, so implementers are briefed on the most common predictable bugs before writing code.

## Files

| Stack | File | Applies to repos with type |
|---|---|---|
| Spring Boot | `spring-boot.md` | `spring-boot` |
| NestJS | `nestjs.md` | `nestjs` |
| FastAPI | `fastapi.md` | `fastapi` |
| Flask | `flask.md` | `flask` |
| Django | `django.md` | `django` |
| Python worker | `python-worker.md` | `python-worker` |
| React | `react.md` | `react` |
| Next.js | `nextjs.md` | `nextjs` |
| Node mock | `node-mock.md` | `node-mock` |
| AWS CDK | `cdk.md` | `cdk` |
| Terraform | `terraform.md` | `terraform` |

## How the task-file generator uses these

During `/deliver` Phase 4.5, for each task file the orchestrator:

1. Reads the relevant stack file from this directory based on the repo's `type`.
2. Reads `{workspace_root}/{slug}/context/audit-findings.md` and filters to findings whose `file_ref` falls under the task's `file_refs` (or the task's repo, if `file_refs` is empty).
3. Merges both into a `## Known Pitfalls` section added to the task body — stack bullets first, audit findings second.
4. Drops the section if fewer than 3 bullets survive the filter (avoids noise).

The implementer reads the pitfalls alongside the rest of the task body and is expected to actively avoid each one.

The per-repo code reviewer (Phase 5.5) is instructed to check the implementation against these pitfalls as a review checklist — so the catalog doubles as an implementation guide and a review lens.

## How to extend

Each stack file should:

- Use one `## Section` heading per failure mode category
- Under each section, 2–6 bullets describing the pitfall in terms a cold implementer can spot
- Reference concrete evidence patterns ("code that looks like `IllegalArgumentException` for not-found") rather than abstract advice

Keep each file under ~80 lines — agents read them fresh on every dispatch.

## Why not per-repo CLAUDE.md only?

Per-repo CLAUDE.md captures conventions ("use `@RequiredArgsConstructor`"). This catalog captures **anti-patterns** ("don't use `IllegalArgumentException` for not-found cases"). They're different tools with different audiences — the CLAUDE.md guides you toward the right thing; this catalog warns you about the predictable wrong thing.
