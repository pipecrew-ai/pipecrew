---
name: draw-diagram
description: Generate or refresh architecture diagrams for a workspace. Default mode regenerates the two canonical Mermaid files (architecture-overview.mmd + architecture.mmd) for an onboarded workspace by re-dispatching the solution-architect in discovery mode. Optional --topic flag produces a focused diagram on a specific concern (auth flow, event flow, deploy topology, etc.) without touching the canonical files. Reuses the same conventions documented in docs/discovery-diagram-rules.md that /discover uses. Standalone — does not run the rest of /discover.
---

# /draw-diagram

Standalone skill for generating or refreshing architecture diagrams. The two canonical workspace diagrams (`architecture-overview.mmd` + `architecture.mmd`) are normally produced by `/discover` Phase B; this skill lets you regenerate them without re-running discovery, or produce focused topic diagrams off the canonical pair.

## When to use

- **Architecture has shifted** since onboarding — new services, removed services, restructured queues — and you want the diagrams to match reality without re-running `/discover` (which would also rewrite `platform.md` and re-publish workspace agents).
- **Workspace was onboarded with an older plugin version** that didn't generate diagrams.
- **You need a focused diagram** for a specific concern (auth flow, event flow, deployment topology) that doesn't belong in the two canonical files.
- **Diagrams have drifted** and a CI cron or developer wants to regenerate them as part of a docs refresh.

## Two source modes

**Workspace mode** (default — uses pre-discovered metadata):
- Source of truth: `platform.md` + `config.json` (well-grounded, fast, narrative-aware)
- Dispatches: `solution-architect` in discovery mode
- Requires: workspace already onboarded via `/discover`

**Code-scan mode** (truly standalone — reads code directly):
- Source of truth: the repos themselves (no `platform.md` needed)
- Dispatches: `architecture-mapper` agent
- Requires: nothing beyond the repo paths
- Trades narrative grounding for not requiring `/discover` to have run

## Usage

```
# Workspace mode (default — fast, narrative-grounded)
/draw-diagram                              refresh canonical diagrams for the auto-detected workspace
/draw-diagram --workspace=<slug>           target a specific workspace
/draw-diagram --topic=<name>               focused topic diagram (workspace mode)

# Code-scan mode (standalone — works without /discover)
/draw-diagram --scan=<dir>                 scan all repos under <dir>, infer topology from code
/draw-diagram --repos="<a>,<b>,<c>"        scan an explicit list of repo paths
/draw-diagram --scan=<dir> --topic=<name>  focused topic diagram in code-scan mode

# Diagram style (any source)
/draw-diagram --c4                         emit Mermaid C4 syntax (Context + Container) instead of flowchart
/draw-diagram --c4 --c4-level=all          add component-level C4 for every container
/draw-diagram --c4 --c4-level=component:<system>  add component diagram for a specific system

# Modes (any source)
/draw-diagram --output=<path>              write to a custom path (with --topic)
/draw-diagram --audit                      read-only staleness report (no writes)
```

**Flags**:
- `--workspace=<slug>` — workspace slug (matches `{workspace_root}/{slug}/`). Auto-detected when only one workspace exists. Triggers **workspace mode**.
- `--scan=<dir>` — directory containing one or more repos to auto-detect. The skill walks the dir, identifies repos (presence of `.git`, `package.json`, `pom.xml`, etc.), passes them to the mapper. Triggers **code-scan mode**.
- `--repos="<a>,<b>,<c>"` — explicit comma-separated list of absolute repo paths. Triggers **code-scan mode**. Use this when `--scan` would pick up too much.
- `--c4` — emit Mermaid C4 syntax instead of flowchart. Produces `c4-context.mmd` + `c4-container.mmd` (additive — does NOT overwrite the flowchart pair). Conventions: `{plugin_dir}/docs/c4-diagram-rules.md`.
- `--c4-level=<level>` — only meaningful with `--c4`. Values: `default` (Context + Container — the default), `component` (also produce component-level for every container — verbose), `all` (same as `component` today), `component:<system>` (component diagram for one specific container, e.g., `--c4-level=component:order-service`).
- `--topic=<name>` — produces `{output-base}/diagrams/{topic}.mmd` for a focused concern (`auth-flow`, `event-flow`, `deploy-topology`, etc.). Default output base is workspace-context-dir in workspace mode, or current working directory in code-scan mode. Compatible with `--c4` — emits C4-style topic diagram.
- `--output=<path>` — overrides default output path. Only meaningful with `--topic`.
- `--audit` — read-only mode. Reads existing diagrams + current state, reports staleness, does not write.

## Modes

### Refresh canonical diagrams (default — no `--topic`)

Re-runs the same logic `/discover` Phase B uses to produce the two canonical files. Existing diagrams are **rewritten** (not merged) — the architect produces a fresh view of the current code.

Output paths:
- `{workspace_root}/{slug}/context/diagrams/architecture-overview.mmd` — high-level C4-style for new team members
- `{workspace_root}/{slug}/context/diagrams/architecture.mmd` — detailed topology with every service, DB, queue, Lambda

The conventions live in `{plugin_dir}/docs/discovery-diagram-rules.md`. The architect reads that file at the start of the run.

### Topic diagram (`--topic=<name>`)

Produces a focused single-file diagram. The canonical pair is **not** modified. Default output path is `{workspace_root}/{slug}/context/diagrams/{topic}.mmd`; override with `--output`.

Topics the architect knows how to handle out-of-the-box (interpreted from the `--topic` argument as a hint):
- `auth-flow` — request → guard → service → role check
- `event-flow` — producer → bus → consumer → DLQ
- `deploy-topology` — VPC / region / availability zones
- `data-flow-{X}` — trace data X through the system
- Any other name — the architect interprets the name and produces a relevant diagram, reading workspace context to ground the choice.

### Audit mode (`--audit`)

Read-only. The architect reads the existing `.mmd` files and the current code, reports staleness:

- Services that exist in code but not in diagrams
- Services in diagrams that no longer exist in code
- Cross-service relationships that have changed
- New queues, buckets, Lambdas, etc. not yet drawn

Output is a report saved to `{workspace_root}/{slug}/context/diagrams/audit-{date}.md`. No diagrams are modified.

## Instructions for the orchestrator

When the user invokes `/draw-diagram`:

1. **Decide the source mode.**
   - If `--scan=` or `--repos=` is passed → **code-scan mode** (dispatches `architecture-mapper`).
   - Otherwise → **workspace mode** (dispatches `solution-architect`).
   - If both workspace flags AND scan flags are passed, prefer the explicit one; if ambiguous, ask.

2. **Resolve inputs.**
   - **Workspace mode**: read `--workspace=` if passed; otherwise check `{workspace_root}/` for workspace directories. If exactly one exists, use it; if multiple, ask which. Verify `config.json` + `platform.md` exist.
   - **Code-scan mode (`--scan`)**: walk the scan directory (one level deep), identify repos (directories containing any of: `.git`, `package.json`, `pom.xml`, `pyproject.toml`, `go.mod`). Build the repo list.
   - **Code-scan mode (`--repos`)**: parse the comma-separated list; verify each path exists. No discovery needed.

3. **Dispatch the right agent.**

   **Workspace mode** — `solution-architect` in discovery mode:
   - **subagent_type**: `pipecrew:solution-architect`
   - **prompt** must include: this is a **diagram-only** invocation (no `platform.md` rewrite), the mode (canonical / topic / audit), the **diagram style** (`flowchart` default, or `c4` if `--c4` was passed), the **C4 level** if applicable, and instruct the architect to **read the right rules file**:
     - flowchart style → `{plugin_dir}/docs/discovery-diagram-rules.md`
     - C4 style → `{plugin_dir}/docs/c4-diagram-rules.md`

   **Code-scan mode** — `architecture-mapper`:
   - **subagent_type**: `pipecrew:architecture-mapper`
   - **prompt** must include the resolved repo list, the workspace name (default to scan-dir basename or first repo's parent dir name), `output_mode` (canonical / topic / audit), `diagram_style` (flowchart / c4), `c4_level` if applicable, and topic name if applicable. The agent reads the right rules file based on `diagram_style`.

4. **Extract the agent's output:**
   - **Canonical mode, flowchart style**: extract `<!-- BEGIN architecture-overview.mmd -->` and `<!-- BEGIN architecture.mmd -->` blocks, strip inner `\`\`\`mermaid` fences, save:
     - Workspace mode → `{workspace_root}/{slug}/context/diagrams/` (create the directory if it doesn't exist)
     - Code-scan mode → current working directory (or `--output` directory)
   - **Canonical mode, C4 style**: extract `<!-- BEGIN c4-context.mmd -->` and `<!-- BEGIN c4-container.mmd -->` blocks (and any `<!-- BEGIN c4-component-{system}.mmd -->` blocks if `--c4-level=component` or `all`), save to the same locations as flowchart canonical files. **Does NOT overwrite the flowchart pair** — they coexist.
   - Topic mode: extract single `<!-- BEGIN {topic}.mmd -->` block, save to the resolved output path. With `--c4`, the topic block uses C4 syntax internally.
   - Audit mode: save the report to `{output-base}/diagrams/audit-{date}.md`.
   - **Code-scan mode also**: extract `<!-- BEGIN MAPPER_REPORT -->`, save as `mapper-report.json` adjacent to the diagrams. Print a summary to the user (edges by confidence, unresolved hosts, skipped items).

5. **Present a diff summary** — what files were written or compared, line counts before/after, and (code-scan mode only) high-level scan stats from the MAPPER_REPORT.

## Standalone agent invocation (without the slash-command)

**Workspace mode**:
```
Use the pipecrew:solution-architect agent in discovery mode for workspace
{slug}. Diagram-only refresh — do NOT rewrite platform.md. Read
{plugin_dir}/docs/discovery-diagram-rules.md first. Produce both
architecture-overview.mmd and architecture.mmd inside the documented
delimiters.
```

**Code-scan mode**:
```
Use the pipecrew:architecture-mapper agent. Repo paths: /path/to/repo1,
/path/to/repo2, /path/to/repo3. Workspace name: {dir-name}. Output mode:
canonical. Read {plugin_dir}/docs/discovery-diagram-rules.md first, then
follow your four-tier scan process.
```

## What this skill does NOT do

- **Does not run other `/discover` phases** — no `platform.md` refresh, no per-repo `agent-context/` updates, no agent re-publishing. Use `/discover --resume` if those need refreshing too.
- **Does not edit MMD files inline** — diagrams are always rewritten as a whole; partial diff edits aren't safe with Mermaid.
- **Does not render diagrams to images** — Mermaid source is the artifact; rendering is the consumer's job (GitHub renders inline, IDE plugins render previews, the site-view UI renders them, etc.).
- **Does not require `/discover` to have run** — code-scan mode reads repos directly. Workspace mode does require `platform.md`.
- **Code-scan mode does not write outside cwd / `--output` path** — it never touches workspace metadata. The workspace canonical files only get rewritten in workspace mode.

## Quality tradeoff: workspace mode vs. code-scan mode

| Aspect | Workspace mode (default) | Code-scan mode (`--scan` / `--repos`) |
|---|---|---|
| Source of truth | `platform.md` + `config.json` (narrative + structured) | Code itself (OpenAPI specs, HTTP client calls, event pub/sub, configs) |
| Setup needed | Workspace onboarded via `/discover` | Just repo paths |
| Token cost | Lower (concentrated in pre-extracted docs) | Higher (per-repo scan, but bounded by HARD RULE R1 — ~38 reads max per repo) |
| Quality | High where `platform.md` is current; degrades with staleness | Tiered confidence (high/medium/low) per edge — never fabricates targets |
| Best for | Active workspaces where `/discover` is current | Brand-new projects, archived projects, second-opinion checks against `platform.md` |

Code-scan mode is **honest about uncertainty** — unresolved hosts emit `(unknown-host)` nodes rather than guesses. Workspace mode trusts `platform.md`. Pick the source that matches what you actually have.

## See also

- [`docs/discovery-diagram-rules.md`](../../docs/discovery-diagram-rules.md) — Mermaid conventions for both canonical diagrams (used by both modes)
- [`skills/discover/phases/phase-b-domain-and-architect.md`](../discover/phases/phase-b-domain-and-architect.md) — the original Phase B logic workspace mode re-uses
- [`agents/solution-architect.md`](../../agents/solution-architect.md) — workspace-mode agent (discovery mode)
- [`agents/architecture-mapper.md`](../../agents/architecture-mapper.md) — code-scan-mode agent
- [`templates/blocks/block-schemas.md#mapper_report`](../../templates/blocks/block-schemas.md) — schema for the MAPPER_REPORT block emitted in code-scan mode
