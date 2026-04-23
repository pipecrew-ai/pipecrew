## Phase B: Domain Questions + Architect-Led Discovery

Two parts: minimal human questions (B1), then automated code discovery (B2).

---

### B1: Domain Interrogation (3 questions — name was already captured in Pre-phase 0)

The project name was already collected in Pre-phase 0 (used to create the scratchpad dir). Do NOT re-ask it. Ask only the three remaining questions. The opener should echo the name back for confirmation so the user can catch a typo without another round-trip:

```
Domain details for {workspace.name}. Three quick questions:

1. **Domain in one sentence**: What does it do?
   (e.g., "Arabic-language book publishing and review platform")

2. **User roles**: Who uses it? List the roles.
   (e.g., Publisher, Manager, Reviewer, Admin)

3. **Languages + RTL**: Which UI languages, and is RTL needed?
   (e.g., "English + Arabic, yes RTL" or "English only, no RTL")
```

From these answers + Pre-phase 0 name, derive:
- `workspace.name` = name from Pre-phase 0
- `workspace.slug` = kebab-case of the name (lowercase, non-alphanum → `-`, truncate to 20 chars)
- `domain.name` = same as `workspace.name`
- `domain.domain_notes` = answer 1
- `domain.user_roles` = answer 2 (split by comma)
- `domain.i18n_languages` = answer 3 (parse language codes)
- `domain.rtl_support` = true if RTL mentioned in answer 3

**If the user corrects the name in their answer** (e.g., "Actually it's called X, not Y"), treat that as a name-change request: update the scratchpad, rename the workspace directory if the slug changes, and re-confirm before proceeding.

Do NOT ask about:
- Tech stack — already detected in Phase A
- Entities — architect discovers from code in B2
- API design — not the user's job
- Deployment — discovered from infra repo

**Update scratchpad**: write answers to `## Domain Answers` in `scratchpad.md`. Set Phase B1 status to COMPLETED. Set Current Phase to "B2. Architect Discovery".

---

### B2: Architect-Led Context Discovery

Launch the `solution-architect` agent to read actual code and produce a rich platform context document. This is the heavy-lift step that replaces dozens of human questions with automated discovery.

**Tool**: `Agent`
**subagent_type**: `solution-architect`
**description**: `"Onboard — architect discovery for {workspace.name}"`
**prompt**:

```
MODE: discovery

You are onboarding to a new project: {workspace.name}.
{domain.domain_notes}

This invocation is DISCOVERY MODE — your output is descriptive (what exists in
this system), not prescriptive (what to build). Design-mode invocations happen
later from the /deliver pipeline and read the file you produce here. Do not
propose new architecture, refactors, or technical solutions in this mode.

Your job: read the actual codebases and produce a platform context document.

REPOS TO ANALYZE (read CLAUDE.md if it exists, then explore key files):
{for each repo in the confirmed list:}
- {repo.name} ({repo.type}, {repo.role}) at {repo.path}
  {if repo.spec_file: "Spec: {repo.path}/{repo.spec_file}"}
  {if repo.has_claude_md: "Has CLAUDE.md — read it first"}

DOMAIN CONTEXT FROM USER:
- Name: {domain.name}
- Description: {domain.domain_notes}
- User roles: {domain.user_roles}
- Languages: {domain.i18n_languages}, RTL: {domain.rtl_support}

DISCOVERY TASKS:
1. For each api-service repo: read the OpenAPI spec (or controller files if no spec). List all entities with their key fields and status lifecycles.
2. Identify entity ownership — which service owns which entity.
3. Map integration patterns: sync (REST calls between services), async (events/queues/S3 triggers), shared resources.
4. Read infra repo (if exists) to identify: queue names, bucket names, deployment topology.
5. For frontend repos: identify the component library, design system, routing pattern, state management.
6. Note any established patterns that all agents should follow (naming conventions, error handling patterns, auth mechanism, test patterns).
7. List known constraints or tech debt items visible from the code.

OUTPUT FORMAT:
Produce the platform context document using the section structure from the template below. Fill in every section with what you discovered — leave none blank. If a section has no data (e.g., no infra repo exists), write "Not applicable — no infrastructure repo in the workspace."

The `## Architect Guidance` section is a STUB — leave it with the exact placeholder content specified below. It is meant for the user (or future onboarding passes) to fill in with workspace-specific design heuristics that future design-mode invocations should apply. Do not populate it from your own discovery; it's a human-edited slot.

TEMPLATE SECTIONS:
## Domain
## Entities & Ownership (table: Entity | Owning Service | Key States)
## User Roles & Permissions (table: Role | Description | Key Permissions)
## Status Lifecycles
## Service Map (table: Service | Repo | Type | Spec | Description)
## Tech Stack
## Integration Patterns
## Infrastructure Topology
## Established Patterns (all agents must know these)
## Known Constraints
## Open Questions / Evolving Decisions
## Architect Guidance

For the `## Architect Guidance` section, write EXACTLY this stub content (replace {workspace.name} with the actual name):

    Workspace-specific heuristics for the architect to apply in DESIGN mode
    (during /deliver pipeline invocations). Leave this stub in place if
    empty — the file still loads cleanly.

    Examples of the kind of guidance that belongs here (do NOT write these
    unless they're real for {workspace.name} — this is a template):

    - For any status-transition work, prefer extending the existing workflow
      orchestrator over adding a new service-layer state machine.
    - Cross-service writes go through the established async pattern; never
      introduce new synchronous cross-service DB writes.
    - Never propose RDS schema changes without calling out the migration
      tool (Liquibase / Flyway / Alembic) changeset explicitly.

    (Empty by default. Fill in during or after onboarding.)
```

**After the architect returns**: save the output as `~/.claude/workspaces/{slug}/context/platform.md`. Present a summary to the user:

```
## Platform Context Generated

The architect analyzed {N} repos and discovered:
- {N} entities across {N} services
- {N} integration patterns (sync/async)
- Tech stack: {summary}
- {N} established patterns identified

Full context saved to: ~/.claude/workspaces/{slug}/context/platform.md

Review it? (yes / continue)
```

If the user says "yes", show the platform.md content.

**Update scratchpad**: Set Phase B2 status to COMPLETED. Set Current Phase to "B2.5. Divergence Harvest".

---

### B2.5: Per-Service Divergence Harvest

The architect's B2 pass necessarily generalizes — it surveys N repos in one reading and tends to describe the Tech Stack / Established Patterns as if all similar repos are uniform. In reality, individual repos often diverge: one auth-service might be on Spring Boot 3.3.5 with Nimbus JOSE while the others are on 3.5.7 with JJWT; one frontend might use `application.properties` while the platform expects YAML. Catching these divergences AFTER platform.md is written but BEFORE B3 / Phase C means every downstream agent reads correct facts.

**Skip this phase if:**
- The workspace has **only one api-service** AND no frontend (nothing to diverge from), OR
- `--skip-divergence-harvest` was passed (escape hatch for fast iteration), OR
- The user explicitly declined in the B2 summary prompt.

Otherwise, run it. It's cheap (~6 parallel agents, ~60s wall, ~40-50k tokens total) and high-value.

#### Step 1: Select repos to fan out

Include: every repo in the config with `role` ∈ {`api-service`, `frontend`, `infrastructure`, `mock-server`}. Exclude pure docs/example repos if any.

For each selected repo, record the single most load-bearing manifest file and at most one config file — this list bounds the divergence agent's reads:

| Repo type | Manifest | Config (if any) |
|---|---|---|
| `spring-boot` | `pom.xml` | `src/main/resources/application.*` |
| `nestjs` / `react` / `nextjs` / `node-mock` | `package.json` | `tsconfig.json`, `vite.config.*`, `next.config.*` |
| `fastapi` | `pyproject.toml` or `requirements.txt` | `pyproject.toml` (again — reuses) |
| `cdk` | `package.json`, `cdk.json` | `cdk.json`, `bin/*.ts` |
| `other` | — (skip) | — |

#### Step 2: Dispatch divergence agents in parallel

**Tool**: `Agent`
**subagent_type**: `general-purpose` (this is lightweight inspection, not architect-level reasoning)
**description**: `"Divergence harvest — {repo-name}"`
**prompt** (per repo — dispatch all calls in a single orchestrator message to parallelize):

```
MODE: divergence-harvest
Repo: {repo_path}
Repo type: {repo.type}
Repo role: {repo.role}

Read ONLY these files (do not explore the rest of the repo):
- {manifest file}
- {config file, if any}

Read the Tech Stack section of platform.md at:
~/.claude/workspaces/{slug}/context/platform.md

For this specific repo ({repo.name}), emit ONLY divergences from what
platform.md claims about the workspace's tech stack. Format each as:

  - {dimension}: platform says X, repo shows Y  (evidence: {file:line or filename})

Dimensions to check:
  - Framework major.minor version (e.g., Spring Boot, Next.js, CDK)
  - Build/generator tool version (e.g., openapi-generator, tsc target)
  - Libraries listed in platform.md that are MISSING in this repo
  - Libraries present here that platform.md did NOT mention
  - Config format (e.g., properties vs yaml vs toml, JS vs TS config)
  - Root package / module path (if different from sibling services)
  - Runtime base image if a Dockerfile is visible in the manifest

If the repo matches platform.md on all dimensions, output EXACTLY the string:
  No divergences.

Do NOT explain what the repo does. Do NOT propose fixes. Do NOT describe
the architecture. Emit only the delta list or the no-op token.

Maximum 20 bullets. If you reach 20 you've probably over-scoped — collapse
minor bullets.
```

All dispatches go out in one orchestrator message so they run concurrently. Expected: 30-60s wall time for the whole fan-out regardless of repo count.

#### Step 3: Merge results into platform.md

Collect each agent's response. For each agent that returned `No divergences.`, drop it.

For the remaining agents, append a new subsection to platform.md under **Tech Stack** (insert AFTER the existing Tech Stack paragraphs, BEFORE the next top-level `##` heading):

```markdown
### Per-Service Divergences

Discovered in Phase B2.5 on {date}. The general Tech Stack block above
describes the workspace baseline; these per-repo overrides apply where
a specific repo diverges. Use these when briefing implementers for that
specific repo — do not apply the baseline blindly.

#### {repo-name-1}
- {dimension}: platform says X, repo shows Y (evidence: {ref})
- ...

#### {repo-name-2}
- ...
```

Rules for the merge:
- One H3 subsection per repo with divergences. Repos with "No divergences" are omitted.
- Copy bullets verbatim from the agent response; do not re-word.
- If a divergence contradicts something elsewhere in platform.md (e.g., the Integration Patterns section assumed OpenFeign everywhere), append a note at the end of the relevant original paragraph: `> Note: see ## Per-Service Divergences — {repo} uses RestTemplate, not Feign.`

#### Step 4: Apply transient-failure and audit-findings rules

- **Transient failure** (529 / 503 / 429): apply the same rules documented in the Phase C "Transient failure handling" block. A single-repo retry is cheap; if the retry also fails, skip that repo's divergence and mark it under the scratchpad's `## Phase Status` notes.
- **Audit Findings contract**: the divergence-harvest agent's narrow prompt intentionally does NOT invite audit findings — that's Phase C's job, with wider file access. Do not extend the prompt with audit-findings instructions here; it would balloon the token budget for a job that's designed to be cheap.

#### Step 5: Present summary to the user

```
## Divergence Harvest Complete

Fanned out {N} agents in parallel, {M} returned divergences:
- {repo-1}: {count} divergences ({top-severity dimension summary})
- {repo-2}: {count} divergences
- ... ({K} repos matched the baseline — no divergences)

platform.md now includes a `### Per-Service Divergences` subsection under Tech Stack.
Review it? (yes / continue)
```

**Update scratchpad**: Set Phase B2.5 status to COMPLETED with a one-line summary of divergences found. Set Current Phase to "B3. Design System" (if frontend repo exists) or "C. Generation".

---

### B3: Design System Discovery (only if frontend repo exists)

**Skip if**: no repo in the config has `role: "frontend"`. Proceed directly to Phase C.

**Step 1: Detect design system presence**

For each frontend repo, check for signals:

```bash
cd {frontend.path} && (
  grep -q "storybook\|@storybook" package.json 2>/dev/null && echo "HAS_STORYBOOK" || echo "NO_STORYBOOK"
  test -d .storybook && echo "HAS_STORYBOOK_DIR" || true
  grep -q "\"@mui\|\"antd\|\"@radix\|\"@chakra\|\"@mantine" package.json 2>/dev/null && echo "HAS_COMPONENT_LIB" || echo "NO_COMPONENT_LIB"
  find src -maxdepth 3 -name "tokens.*" -o -name "theme.*" -o -name "design-tokens.*" 2>/dev/null | head -3
)
```

**Step 2: If design system signals found** → dispatch a discovery agent:

**Tool**: `Agent`
**description**: `"Design system discovery — {frontend-repo-name}"`
**prompt**:

```
Read the frontend repository at {frontend.path}. Start with CLAUDE.md if it exists.

Discover the design system and answer these questions with specific file paths and component names:

1. COMPONENT LIBRARY: which one? (MUI, Ant Design, Radix, Chakra, Mantine, custom, none)
   - Version? (e.g., MUI v5 vs v6 matters for API)
   - Import pattern? (e.g., `import { Button } from '@mui/material'`)

2. STORYBOOK: does it exist?
   - Path to stories directory
   - How many components have stories?
   - Run `ls {storybook_dir}` to list available stories

3. DESIGN TOKENS: where are colors, spacing, typography defined?
   - File path (e.g., `src/theme/tokens.ts`, `tailwind.config.js`)
   - Token format (CSS vars, JS object, Tailwind classes)

4. ESTABLISHED UI PATTERNS: read 3-4 existing feature pages and identify:
   - How tables are built (which component, pagination pattern)
   - How modals/dialogs are built (which component, open/close pattern)
   - How forms are built (controlled vs uncontrolled, validation library)
   - How navigation/routing works

5. COMPONENTS TO AVOID: search for comments like "deprecated", "do not use",
   "broken", "TODO: replace". Also check if any imported components have known
   RTL issues (common: Drawer, Tooltip positioning, icon direction).

6. CUSTOMIZATION LEVEL: does the team use library components as-is, or wrap
   them in custom abstractions? (check for a `components/ui/` or `components/common/` 
   directory with thin wrappers)

Output format — structured, not narrative:

## Design System Report: {repo-name}

### Component Library
- Name: {name} v{version}
- Import pattern: `{example}`

### Storybook
- Available: yes/no
- Path: {path}
- Component count: {N}

### Design Tokens
- Location: {file path}
- Format: {CSS vars / JS object / Tailwind}
- Key tokens: {list 5-6 most-used: primary color, spacing unit, font family}

### Established Patterns
| Pattern | Component used | Example file |
|---------|---------------|-------------|
| Data tables | {component} | {path} |
| Modals/dialogs | {component} | {path} |
| Forms | {approach} | {path} |
| Navigation | {pattern} | {path} |

### Components to Avoid
| Component | Reason | Alternative |
|-----------|--------|------------|
| {name} | {why} | {use instead} |

### Customization Level
- {as-is / thin wrappers / heavy customization}
- Wrapper directory: {path or "none"}
```

**After the agent returns**: save the report to `~/.claude/workspaces/{slug}/context/design-system.md`. This file will be used to fill `{{DESIGN_SYSTEM_CONTEXT}}` in Phase C.

**Step 3: If NO design system signals found** → ask the user:

```
Frontend repo "{repo-name}" has no detected design system
(no Storybook, no component library, no design tokens).

Options:
  (a) Continue without — UX consultant will recommend components
      based on what already exists in the codebase
  (b) Note as a gap — add "no established design system" to
      platform.md Known Constraints so agents are aware

Choose (a) or (b):
```

- **(a)**: set `{{DESIGN_SYSTEM_CONTEXT}}` to: "No design system detected. Recommend components based on what exists in the codebase. Do not assume any component library is available — check before recommending."
- **(b)**: same as (a), plus append to `~/.claude/workspaces/{slug}/context/platform.md` under `## Known Constraints`: "No established design system in the frontend. Components are ad-hoc. Consider establishing a component library + Storybook before scaling the frontend."

**Update scratchpad**: Set Phase B3 status to COMPLETED. Set Current Phase to "C. Generation".

---
