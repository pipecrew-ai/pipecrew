# PipeCrew on OpenCode — feasibility assessment

**Status**: exploration / strategy — not a commitment to ship.
**Date**: 2026-05-31

---

## Why this question is worth asking now

OpenCode (by sst/Anomaly) crossed 160k GitHub stars and 7.5M monthly users in early 2026. It's the largest open-source AI coding agent, multi-provider (Anthropic, OpenAI, Gemini), terminal-native, with three extensibility tiers (agents / skills / plugins) that look *structurally similar* to Claude Code's. A second runtime would roughly double PipeCrew's reachable audience and remove single-vendor risk.

The real question isn't *can* we — it's *how cleanly*, and *what we'd have to refactor in PipeCrew's core to support both without forking*.

---

## OpenCode's extensibility model in one page

| Primitive | Where it lives | Format | Invoked how |
|---|---|---|---|
| **Agents** | `.opencode/agents/<name>.md` or `~/.config/opencode/agents/` | Markdown + YAML frontmatter | Primary: Tab-cycle. Subagent: `@mention` or `task` tool |
| **Skills** | `.opencode/skills/<name>/SKILL.md` (also reads `.claude/skills/` and `.agents/skills/`) | Markdown + YAML frontmatter | The native `skill` tool — agent calls `skill({name: "x"})` to load on demand |
| **Commands** | `.opencode/commands/<name>.md` | Markdown + YAML frontmatter | `/<filename>` slash command |
| **Plugins** | `.opencode/plugins/` directory or npm package | TypeScript/JavaScript | Lifecycle hooks fire automatically; plugins register custom tools and (as of v1.14.33) custom agents |
| **MCP servers** | `opencode.jsonc` under `mcp.*` | JSON config | Tools auto-available to agents |

**Agent frontmatter fields:** `description` (required), `mode` (`primary`/`subagent`/`all`), `model` (`provider/model-id`), `temperature`, `permission`, `top_p`, `steps`, `disable`, `hidden`, `color`.

**Skill frontmatter fields:** `name` (required, 1-64 chars), `description` (required, 1-1024 chars), `license`, `compatibility`, `metadata`.

**Command frontmatter fields:** `description`, `agent`, `model`, `subtask` (forces subagent invocation), `template` (required — the prompt).

**Command body placeholders:** `$ARGUMENTS`, `$1`/`$2`/`$3`, `` !`bash-command` `` (injects output), `@filename` (includes file content).

**Plugin lifecycle hooks (25+):** `tool.execute.before`/`after`, `session.created`/`compacted`/`idle`/`updated`, `file.edited`/`watcher.updated`, `permission.asked`/`replied`, `message.part.updated`/`removed`, `lsp.client.diagnostics`, `tui.command.execute`, `tui.toast.show`, etc.

---

## PipeCrew structure mapped to OpenCode

| PipeCrew today | OpenCode equivalent | Fit |
|---|---|---|
| `agents/*.md` (24 agents with markdown bodies) | `.opencode/agents/*.md` | **Direct map.** Frontmatter fields differ but the file shape is identical. Need a translator for `model: opus` → `anthropic/claude-opus-4-7`. |
| `skills/*/SKILL.md` (13 multi-phase orchestrators) | `.opencode/commands/*.md` | **Partial map.** OpenCode skills are *prompt templates*; PipeCrew skills are *multi-phase orchestrators with conditional logic*. Better fit is OpenCode **commands**, not skills. |
| `skills/*/phases/*.md` (phase files loaded mid-flow) | No native equivalent | **Mismatch.** OpenCode commands are single-template; the "skill reads phase-b.md when ready" pattern needs simulation via `@filename` includes or a plugin tool. |
| `scripts/*.js` (Node.js helpers) | Bash injection `` !`node script.js` `` in commands, or plugin tool helpers | **Direct map.** PipeCrew's zero-dep Node is already portable. |
| `templates/blocks/*.json` (block schemas, validators) | File-based, no runtime change | **Direct map.** Pure data. |
| `settings.json` hooks (PreToolUse Bash guard) | Plugin with `tool.execute.before` hook | **Direct map** in concept; **rewrite** in code — JSON config → TypeScript plugin. |
| MCP servers | Same protocol, same config shape (different file: `opencode.jsonc` vs `.mcp.json`) | **Direct map** with file-path tweak. |
| Marketplace install (`marketplaces/pipecrew`) | npm package or local plugin dir | **Rewrite.** Distribution model differs — need an npm package. |
| Workspace concept (`{workspace_root}/{slug}/`) | Pure file-path convention; agents own this | **Direct map.** No runtime support needed. |
| Site-view (SSE fed by `checkpoints.jsonl`) | Same Vite app, fed by OpenCode plugin emitting events from `session.updated` hooks | **Bridge needed.** The viewer is portable; the *source of telemetry* needs a per-runtime adapter. |

---

## The structural mismatches that matter

### 1. Skill vs. Command vs. Phase

PipeCrew's "skill" concept covers two distinct OpenCode primitives:

- The **entry point** (`/discover`, `/deliver`) → OpenCode **command**
- The **on-demand loaded knowledge** (block schemas, stack docs) → OpenCode **skill** (the actual SKILL.md kind)

And PipeCrew's **phase files** have no direct OpenCode equivalent. Three resolution paths:

- (a) Inline all phase content into the command template (fast, ugly, hits token limits on `/deliver`)
- (b) Use `@filename` includes in the command template to pull each phase file as needed (works for static includes, can't do conditional logic)
- (c) Build a small plugin tool `load_phase(name)` that returns phase content — the orchestrator agent calls it phase-by-phase (closest to current behavior)

**Recommended**: (c). Adds ~50 lines of TypeScript plugin code for a clean translation.

### 2. Agent-dispatches-agent depth

PipeCrew's orchestrator pattern is `/deliver` command → solution-architect agent → repo-discoverer subagent. OpenCode's `task` tool supports subagent invocation via `@mention` or by name, and the v1.14.33 fix allowed plugin-registered agents to be invocable. The hierarchy works — but every PipeCrew agent that spawns sub-agents needs to switch from Claude Code's `Agent` tool to OpenCode's `task` tool.

This is **prompt-layer surgery**, not code. The wrapper would translate `Agent({subagent_type: "x"})` patterns to `task({agent: "x"})`-equivalent prompts in our agent bodies.

### 3. Model identity translation

PipeCrew agents say `model: opus`. OpenCode wants `model: anthropic/claude-opus-4-7`. We need either:

- A build step that emits OpenCode-flavored agents from a single source
- A wrapper plugin that intercepts agent loads and rewrites the model field at load time (uses `session.created` hook + agent file reads)

Build-step is simpler and predictable.

### 4. Hooks

Today PipeCrew has one PreToolUse hook (`troubleshooter-bash-guard.js`) wired via `settings.json`. OpenCode's equivalent is a TypeScript plugin registering `tool.execute.before`. Direct port — ~100 lines of TS to replace ~80 lines of JS + JSON config.

### 5. The `Workflow` tool gap

Claude Code's new `Workflow` tool (see `workflow-tool-integration.md`) doesn't exist in OpenCode. But:

- OpenCode plugins like **Subtask2** and **Pocket Universe** already implement multi-agent orchestration with flow control
- A PipeCrew-on-OpenCode design can stay deliberate about *not* depending on Workflow primitives — the orchestration stays in skill markdown + agent dispatch chains, which both runtimes support

This is actually a *reason* to support both runtimes: keeping the orchestration runtime-portable forces cleaner abstractions.

---

## Three approaches, with cost and fidelity

### Approach A: Light compatibility layer (1-2 weeks)

- Keep PipeCrew as a Claude Code plugin
- Add a `dist/opencode/` directory with **mirrored** agents (rewritten frontmatter + model identifiers)
- Rewrite skills as OpenCode commands with inline phase content
- Document install steps for OpenCode users: copy `dist/opencode/agents/` to `~/.config/opencode/agents/`, etc.

**Pros**: Cheapest to validate. Reaches OpenCode users in 1-2 weeks.
**Cons**: Two codebases drift; multi-phase orchestration is degraded; no plugin distribution channel.

### Approach B: Full OpenCode plugin (4-6 weeks)

- Build npm package `@pipecrew/opencode` that:
  - Registers all 24 agents via plugin agent registration (v1.14.33+ feature)
  - Registers commands for `/discover`, `/deliver`, `/review`, etc.
  - Exposes a `load_phase(name)` tool that returns phase markdown content from bundled files
  - Registers a `tool.execute.before` hook replacing the current Bash guard
  - Ships scripts as bundled JS, invocable from commands via `!node`
  - Emits session telemetry to a `state.json`/`checkpoints.jsonl` mirror so site-view can be reused

**Pros**: Native OpenCode experience, distributable via npm, single canonical agent definition per runtime.
**Cons**: Two codebases still drift over time; new TypeScript skillset; need to track OpenCode breaking changes.

### Approach C: Runtime-agnostic core (8-12 weeks, ideal long-term)

Refactor PipeCrew into three layers:

```
pipecrew/
├── core/                          # runtime-agnostic
│   ├── agents/<name>.md           # superset frontmatter, prose body
│   ├── skills/<name>/             # SKILL.md + phases/
│   ├── scripts/*.js               # pure node, no platform deps
│   └── templates/                 # JSON schemas, prose templates
├── runtimes/
│   ├── claude-code/               # current marketplace plugin shim
│   │   ├── plugin.json
│   │   └── adapters/              # frontmatter rewriting, hook config
│   └── opencode/                  # new npm package shim
│       ├── package.json
│       ├── src/plugin.ts          # lifecycle hooks
│       └── adapters/              # frontmatter rewriting, command wrappers
└── build/
    └── emit-{runtime}.js          # generates the runtime-specific shapes from /core
```

A build step (`pnpm build:opencode` / `pnpm build:claude-code`) emits the runtime-specific shapes. Agents/skills/scripts are authored **once** in `core/`.

**Pros**: Single source of truth, both runtimes always in sync, clean separation between *what PipeCrew is* (the core) and *how it runs* (the adapters).
**Cons**: Large refactor; needs a build pipeline; design choices in the frontmatter superset that constrain future agent fields.

---

## What to do first

Don't pick an approach yet. **Run a spike to prove the smallest possible PipeCrew piece works on OpenCode**. Suggested spike:

1. Copy `agents/solution-architect.md` to `.opencode/agents/solution-architect.md` on an OpenCode test install — does it load?
2. Translate the `model:` field to OpenCode format — does the agent dispatch?
3. Create `.opencode/commands/discover.md` that's a thin wrapper invoking `solution-architect` with a small prompt — does the command appear in `/`?
4. From the discover command, can we get to a subagent dispatch via `task` tool?
5. Can our `scripts/extract-block.js` be called from the command via `!node`?

Five questions. Each is binary. The spike takes ~half a day and tells us whether Approach A/B/C is realistic at all, or whether OpenCode has a constraint that kills the idea.

**OpenCode's skill discovery already accepts `.claude/skills/` and `.agents/skills/` paths.** That's a strong signal that the porting effort is anticipated by the platform. We may discover the lift is smaller than this doc suggests.

---

## Recommendation

1. **Run the half-day spike** above. Confirm or refute the basic compat story.
2. **If the spike passes**: pick Approach **B** (full OpenCode plugin) for the v1. Approach A degrades multi-phase orchestration too much; Approach C is too much refactor before we know if OpenCode users actually want this.
3. **Defer Approach C** until both runtime shims have ~3 months of production use. Then we'll know which fields/conventions belong in the runtime-agnostic core and which are runtime-specific.
4. **Pilot scope** for Approach B: `/discover` only, on a single workspace, with one stack family (e.g., FastAPI + React). Don't port `/deliver` until `/discover` is stable on OpenCode.

---

## Risks and unknowns

| Risk | Why it matters | Mitigation |
|---|---|---|
| Agent-spawns-agent depth limits in OpenCode | `/deliver` Phase 5 spawns 5+ implementer agents in parallel; if OpenCode caps depth or concurrency, the phase breaks | Spike test the `task` tool with depth-3 dispatch (orchestrator → architect → repo-discoverer → grep agent) |
| Plugin agent registration (v1.14.33) maturity | Recent feature, may have edge cases with 24 agents at once | Test loading the full agent fleet; report bugs upstream |
| Telemetry format for site-view | site-view depends on `checkpoints.jsonl` shape; OpenCode session events are different | Build a thin adapter plugin that writes `checkpoints.jsonl`-shaped output from session hooks |
| Marketplace discoverability | npm has no "Claude-Code-style plugin marketplace" — discovery is via `awesome-opencode` | Register PipeCrew there; rely on docs and a clear install path |
| Model parity | `model: opus` mapping to provider-specific IDs needs to track Anthropic model renames | Centralize the mapping in one config file; bump when Anthropic ships a new model |
| OpenCode breaking changes | Pre-1.0 SemVer, frequent lifecycle hook changes | Pin to a known-good version in package.json peerDependencies; track changelog |

---

## What this doesn't address (out of scope here)

- Whether OpenCode users actually want a multi-repo orchestrator (likely yes given Subtask2/Pocket Universe traction, but unproven for PipeCrew specifically)
- Whether to support Cursor, Continue.dev, or other agents — same analysis would be needed per platform
- How to handle workspace state files when a user has the same workspace open in both Claude Code and OpenCode simultaneously (race conditions on `state.json`)
- Pricing/licensing implications of distributing an npm package vs. a Claude Code marketplace plugin

---

## Sources

- [OpenCode docs — Agents](https://opencode.ai/docs/agents/)
- [OpenCode docs — Agent Skills](https://opencode.ai/docs/skills/)
- [OpenCode docs — Custom Commands](https://opencode.ai/docs/commands/)
- [OpenCode docs — MCP Servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode docs — Intro](https://opencode.ai/docs/)
- [OpenCode home page](https://opencode.ai/)
- [awesome-opencode plugin/agent/skill registry](https://github.com/awesome-opencode/awesome-opencode)
- [sst/opencode on DeepWiki](https://deepwiki.com/sst/opencode)
- [BSWEN — Plugins, Skills, and Agents complete extensibility guide](https://docs.bswen.com/blog/2026-03-05-opencode-plugins-skills-agents/)
- [Cefboud — How Coding Agents Actually Work: Inside OpenCode](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/)
- [Lushbinary — OpenCode Developer Guide](https://lushbinary.com/blog/opencode-developer-guide-terminal-ai-coding-agent/)
- [Context Studios — OpenCode Custom Agents](https://www.contextstudios.ai/blog/opencode-custom-agents-the-star-inversion-story)
