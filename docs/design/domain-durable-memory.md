# Domain-based durable memory — id-linked domains as the unit of shared knowledge

Status: **agreed baseline, not implemented**. Captured from the 2026-09-01 technical
brainstorm (session "domain based durable memory", solution-architect in MODE: brainstorm;
input sketch: the user's `pipecrew-durablememory.drawio.png`). The structural design below
was explicitly accepted; the open questions at the bottom were never answered — resume
there before implementing.

## Problem

PipeCrew's durable memory today is workspace-shaped: one workspace = one optional private
memory repo (`docs/design/github-memory.md`), holding `context/platform.md`, `adrs/`,
`history/`, and per-repo `CLAUDE.md` / `agent-context/`. That model has no story for
knowledge that crosses team or ownership boundaries:

1. **A team can't reference another team's memory.** An ordering team that depends on a
   payments platform has nowhere to declare "payments' semantic map lives *there*" — let
   alone consume it, whether it sits on GitHub, only on one individual's machine, or
   belongs to a team that doesn't use PipeCrew at all.
2. **No boundary unit between "one workspace" and "everything".** Real organizations are
   groups of repos/components (**domains**) with sub-domains, recursively. Mapped fully,
   that structure could connect an organization's knowledge end-to-end — but the current
   flat workspace can't express it.
3. **All memory is one undifferentiated pile.** Three kinds live together with different
   sharing semantics:

   | Tier | What | Produced by | Cross-boundary sharable? |
   |---|---|---|---|
   | **Semantic** | facts — platform map, topology, conventions | `/discover` | yes |
   | **Episodic** | events — run reports, history | each `/deliver` | no (likely not even agent-facing — see Q5) |
   | **Procedural** | how-to — reusable recipes | `/deliver` + `/learn` | yes |

## Design (agreed)

### 1. The domain artifact

Each domain is its **own on-disk artifact** — a `domain.json` plus its own `context/`
(and, when shared, its own memory remote). Domains reference other domains **by id,
never by physical containment**: there is no nesting of domain configs inside one file.
A "child domain" is simply an `external_dependencies` entry with `relation: child`, and
hierarchy is recoverable from `parent_id` — one mechanism serves nesting and external
dependencies alike. This keeps memory-sync exactly as clean as today: one domain = one
`context/` = one optional remote.

```jsonc
{
  "domain": {
    "id": "dom_01J9X4...",        // globally unique, opaque, minted once
    "name": "ordering",           // display only — never used for identity
    "parent_id": "dom_...|null",
    "services": { /* ... */ },
    "repos":    { /* ... */ },
    "memory":   { /* ... as today's workspace.memory ... */ }
  },
  "external_dependencies": [
    {
      "target_id": "dom_7Z...",
      "relation": "child | peer | upstream",
      "expected_name": "payments",              // human hint, not identity
      "resolution": { "kind": "local | github | absent", "hint": "..." },
      "trust": "auto | manual | blocked",
      "share_scope": "semantic+procedural"
    }
  ]
}
```

### 2. Identity ≠ resolution ≠ permission

- **Identity**: `id` is globally unique, opaque, minted once at domain creation, never
  derived from name or path. It lives inside the domain artifact, survives moves and
  renames, and travels through memory-sync.
- **Resolution**: where the domain currently *is* (`local` path, `github` remote, or
  `absent`) — the only mutable part of an edge, deliberately cheap to update.
- **Permission**: `trust` and `share_scope` govern what a referrer may consume — split
  cleanly from the other two so sharing policy never contaminates identity or location.

### 3. Referrer-owned, one-directional edges (the highest-leverage decision)

A domain lists **what it depends on — never who depends on it**. There is no global graph
object, no back-edges, no bidirectional sync; the "graph" is just N independent local
lists. Consequences, and the answer to "won't maintaining relations be complex?":

- Moving or deleting a domain touches **zero** other files.
- **`absent` is a first-class, non-fatal state**: an unresolvable reference is logged and
  skipped; nothing cascades; it self-repairs the moment the target reappears, because the
  id still matches.
- Resolution is **lazy / best-effort** via a single read-only `resolve` command
  (optionally run at the top of `/deliver` — see Q2). No daemon, no eager validation.
- All ongoing maintenance cost is confined to the one mutable `resolution` field.

### 4. Workspace demotes to a manifest

The **domain is the successor to today's workspace**. "Workspace" survives only as a thin
manifest (`workspace.json`): a pure lookup table of domain ids → local paths describing
what this machine works on — no schema of its own, no memory, nothing to sync. (This
rhymes with, but is separate from, the v1.10.0 workspace registry in
`docs/design/workspace-registry.md`, which solved multi-root discovery for today's
workspaces.)

### 5. Graceful degradation for non-PipeCrew dependencies

A dependency that doesn't use PipeCrew still gets an edge — with `resolution.kind` set to
whatever exists (a repo URL, a local path, or `absent`). What content stands in for its
memory is open (Q4: hand-written stub vs auto-generated thin profile vs recorded dangling
pointer).

## Decisions of record

1. Domains as separate, id-linked artifacts; no physical nesting (accepted explicitly).
2. Stable opaque domain `id` with the identity/resolution/permission split.
3. `external_dependencies` as the single first-class edge type (covers child/peer/upstream).
4. Referrer-owned one-directional edges; `absent` non-fatal; lazy `resolve`.
5. Workspace becomes a thin manifest; domain carries everything else.

## Open questions (resume here — in this order)

- **Q2a — resolve trigger**: purely on-demand, or also automatically at the top of
  `/deliver`?
- **Q2b — caching**: are resolved results cached/vendored into the referrer (offline use,
  pinned GitHub deps) or re-fetched fresh each time?
- **Q3 — what crosses the boundary**: semantic map only, procedural recipes too, or both
  (per-edge `share_scope` already reserves the knob)?
- **Q4 — non-PipeCrew fallback content**: hand-written stub vs auto-generated thin
  profile vs dangling pointer.
- **Q5 — episodic memory's fate**: drop entirely, or keep as a tier agents never load but
  `/learn` reads? (Architect's prior: it's a human audit trail, not agent memory.)
- **Format round (never reached)**: knowledge graph vs README-style files vs hybrid for
  each memory tier.
- **Migration (never reached)**: the minimal-change path from today's
  workspace/config.json + memory-sync model to domains — including how existing
  workspaces mint ids and how `sync-memory.js`, `/discover`, `/deliver`, and `/join`
  change.

## Relationship to existing designs

- `docs/design/github-memory.md` — the current per-workspace memory-sync substrate this
  design evolves; the per-domain `memory` block is intentionally shaped like today's
  `workspace.memory`.
- `docs/design/workspace-registry.md` (v1.10.0, implemented) — solves *finding* today's
  workspaces on one machine; the `workspace.json` manifest here would eventually subsume
  that role for domains.
