# GitHub-backed workspace memory

Status: **proposed** (implemented behind opt-in config; review before enabling).

## Problem

pipecrew's durable "long-term memory" lives in two tiers:

| Tier | Where it lives | Already on GitHub? |
|---|---|---|
| **Per-repo** — `CLAUDE.md`, `agent-context/`, `DESIGN_SYSTEM.md` | inside each code repo | ✅ yes — versioned with the code |
| **Workspace** — `context/platform.md`, `context/observability.json`, `context/audit-findings.md`, `context/adrs/`, `agents/`, `history/learn-log.md`, `config.json` | `{workspace_root}/{slug}/` (local only) | ❌ **no** — local-only, unversioned |

The workspace tier is the *cross-repo* memory the `/learn` loop and `/discover` build up over time. Today it exists only on one machine: not versioned, not shareable with the team, not recoverable, and its evolution isn't diffable. This feature gives it a GitHub home.

## Design

**One private git repo per workspace, shared across the team.** `{workspace_root}/{slug}/` becomes a git repo whose remote is a **private** GitHub repo (default name `{slug}-memory`). Every teammate clones it, so PipeCrew reads the *same* cross-repo knowledge on every machine. The plugin commits + pushes the durable docs at the points where memory actually changes, and pulls the team's latest at each run's pre-flight.

Four hard problems drive the design:

### 1. Secrets must never reach git history (mandatory)

`audit-findings.md` and `platform.md § Known Constraints` routinely quote **live credentials** verbatim (e.g. a hardcoded API key found at `file:line`). Pushing those to GitHub — even a private repo — writes them into history permanently.

**Rule:** every sync runs `scripts/redact-secrets.js` over the committed files first. Findings keep the `file:line` + description (enough to locate and rotate the real secret in the *code* repo) but the **literal secret value is replaced** with `[REDACTED-<kind>]`. The repo is **private** as a second layer. Redaction is **in place** (local copy = committed copy) so the working tree never drifts from the remote and the doc never re-grows the secret.

Redaction is heuristic (see the script). Patterns favor *no false negatives on real credential shapes* over catching every high-entropy string — it deliberately does **not** redact git SHAs, AWS account IDs, or `${ENV_VAR}` references (those aren't credentials, and mangling them would corrupt ADRs/diffs). The private-repo default is the backstop for anything the heuristic misses.

### 2. config.json is machine-specific — keep it out of the committed memory

`config.json` embeds absolute local repo paths (`C:/ABVI/repos/abvi-auth-service`). Committing it breaks on any other machine.

**Approach (zero runtime change):**
- `config.json` stays exactly as today — local, absolute paths — and is **gitignored** from the memory repo.
- The sync routine generates a portable **`config.portable.json`** (the same structure, but each repo's absolute `path` replaced by `dir` = the path *relative to* `repos_root`, with `repos_root` factored out). That portable file **is** committed — it's the durable record of "which repos / services / spec policies / domain this workspace has".
- On a fresh clone, `/discover --rehydrate` (or `--resume`) rebuilds the local `config.json` from `config.portable.json` by prompting for / detecting the local `repos_root`.

No existing config reader changes — they keep reading the local absolute `config.json`.

### 3. Concurrent writers — keep every machine in sync (shared repo)

Because the repo is shared, two machines can change memory between syncs. The sync routine handles this on both sides:

- **Read (pre-flight).** `sync-memory.js pull <ws>` runs at the start of each `/discover` / `/deliver` / `/learn` / `/context-refresh` run: `fetch` + `pull --rebase`, so the run starts from the team's latest. It refuses to pull over a dirty local tree (the next sync reconciles instead) and warn-skips on any failure — a stale-but-local copy is better than a blocked run.
- **Write (rebase before publish).** Every sync commits first, then `fetch` + `rebase` its fresh commit onto `origin/<branch>` before pushing — so a sibling's push isn't warn-dropped on a non-fast-forward race.
- **Conflict.** A rebase conflict in any mode **aborts and falls back to PR** — the commit is parked on a `memory/<checkpoint>-<sha>` branch and a human resolves it in GitHub. We never auto-resolve canon, and local `main` is reset back to `origin/main` so the next run starts clean.

#### Sync modes (`workspace.memory.sync_mode`)

| Mode | Behavior | For |
|---|---|---|
| `commit` (default) | pull --rebase → commit straight to `main` | solo / single-machine workspace |
| `pr` | always push a `memory/<checkpoint>-<sha>` branch + `gh pr create` | teams that want every memory change reviewed |
| `hybrid` (recommended for shared repos) | **structural** changes (`context/platform.md` or `context/adrs/**` — the shared mental model + durable decisions) open a PR; **bookkeeping** (audit-findings, observability, learn-log, `config.portable.json`) commits directly | teams that want review on canon but frictionless propagation for the rest |

In all modes a rebase conflict forces PR. `gh` absence/auth-failure degrades gracefully: the branch is still pushed; the warning tells the user to open the PR manually.

### 4. Version durable memory, ignore run noise

Committed: `context/` (platform.md, diagrams/, observability.json, audit-findings.md, adrs/), `agents/`, `history/learn-log.md`, `config.portable.json`, the `.gitignore` itself.

Ignored (`templates/workspace-memory.gitignore`): `runs/` (scratchpads, checkpoints.jsonl, outputs, reports — large & churny; token trends stay local), `config.json`, `config.local.json`, `.observability-draft.json`, `.in_use/`, `awaiting_input.json`, autoapprove markers, `settings.local.json`, OS cruft.

## Components

| File | Role |
|---|---|
| `scripts/redact-secrets.js` | Redact credential values in text files. `--check` mode (report only, exit 1 on hit) for pre-commit/CI; default redacts in place. Reused by the sync routine. |
| `scripts/sync-memory.js` | The end-to-end sync: redact → regenerate `config.portable.json` → commit → `rebase` onto `origin` → publish per `sync_mode` (commit / PR). Plus read-only `pull` (pre-flight fetch+rebase) and `status` (freshness / ahead-behind / unpushed, `--json` for tooling) subcommands. Idempotent; no-ops cleanly when nothing changed; warns (never fails the skill) on no-remote/auth/conflict. |
| `skills/memory-sync/SKILL.md` | The `/pipecrew:memory-sync` skill — manual control surface over the script: `status`, `pull`, `sync` (retry a failed push / publish hand edits), `enable` (turn memory on for an already-onboarded workspace without re-running `/discover`). Named `memory-sync` (not `memory`) to avoid Claude Code's built-in `/memory`. The automatic syncs are unaffected. |
| `templates/workspace-memory.gitignore` | The `.gitignore` written into the memory repo at bootstrap. |
| `workspace-config.schema.json` → `workspace.memory` | Opt-in config: `{ enabled, remote, repo_name, visibility, sync_mode }`. Absent ⇒ feature off (current behavior). |

## Config block

```jsonc
// config.json  (workspace.memory — optional; absent = feature disabled)
"memory": {
  "enabled": true,
  "remote": "git@github.com:acme/dal-platform-memory.git",  // set at bootstrap
  "visibility": "private",                                   // private REQUIRED for safety
  "sync_mode": "hybrid"                                      // commit | pr | hybrid (default commit)
}
```
`repos_root` (for config.portable.json generation) lives in the gitignored `config.local.json`, or is inferred as the longest common parent of the repo paths.

## Lifecycle / sync points

| When | Action |
|---|---|
| **Pre-flight** — start of any `/discover` / `/deliver` / `/learn` / `/context-refresh` run (if `memory.enabled`) | `sync-memory.js pull {ws}` — fetch + `pull --rebase` so the run reads the team's latest memory (warn-skips on dirty tree / failure). |
| **Bootstrap** — `/discover` end (if `memory.enabled` and no remote yet), or `/discover --memory-remote=<url>` | `git init`, write `.gitignore`, `gh repo create {repo_name} --private` (or use the provided remote), redact, generate `config.portable.json`, first commit + push. |
| **`/discover`** completes | `sync-memory.js {ws} --message "discover: onboard {slug}" --checkpoint=discover` |
| **`/learn`** applies findings | `sync-memory.js {ws} --message "learn: {n} updates ({run_id})" --checkpoint=learn` |
| **`/context-refresh`** writes docs | `sync-memory.js {ws} --message "context-refresh: {scope}" --checkpoint=context-refresh` |
| **`/deliver`** that changed context (new ADR / audit-findings update) | `sync-memory.js {ws} --message "deliver: {feature} (context updates)" --checkpoint=deliver` |

Each sync is **redact-first**, so no path produces an unredacted commit. The publish path (direct commit vs PR) is chosen by `sync_mode` + what changed — see §3.

### Freshness — computed, not stored

"When was memory last refreshed?" is deliberately **not** kept as a stored field. For a *shared* repo it's a remote/git fact: a local `last_synced_at` would be machine-specific and would lie the moment a teammate pushed. The source of truth is the memory repo's own commit history (`git log -1 origin/main` → date + author + subject), plus `history/learn-log.md` for the `/learn` audit trail.

So freshness is **computed live** and surfaced where it's useful, never persisted:
- `pull` reports `last change <relative> (<subject>), you were N commits behind`.
- `status` (and `status --json`) reports last change + author, behind/ahead of origin, unpushed local commits, and dirty-tree state — for the user, the reporter, and the site-view.

## Auth

Uses the user's existing `git` / `gh` credentials (same as `/deliver` Phase 8 branch pushes). If push fails (no auth, no remote, diverged), the routine logs a warning and leaves the commit local — it never aborts the surrounding skill. Never `git push --force`.

## Domain identity and dependency edges (Parts 1 + 2)

These fields are part of the domain-durable-memory rollout. Both are purely additive — existing configs that omit them behave byte-identically.

### `domain.id` — stable opaque workspace identity

A workspace's `config.json` may carry a `domain.id` field:

```jsonc
"domain": {
  "id": "dom_01ARZ3NDEKTSV4RRFFQ69G5FAV",   // dom_<26-char Crockford-base32 ULID>
  ...
}
```

**Format**: `dom_` prefix + 26 Crockford-base32 characters (a ULID, time-ordered, ~122 bits of randomness). Minted once by `scripts/mint-domain-id.js`, idempotent on re-run.

**Purpose**: a stable opaque id that survives workspace rename or path changes — the precondition for cross-domain references. Nothing reads or validates it yet beyond the warn-only `validate-config.js` check.

**Carry-through**: `regeneratePortableConfig()` deep-clones the whole config before stripping only `repos[].path`. `domain.id` therefore flows into `config.portable.json` and to teammates via `/join` with zero code change.

**Back-fill**: run `node scripts/mint-domain-id.js --config=<path>` once per existing workspace. The `/discover` run mints an id automatically into any new config it writes.

### `external_dependencies[]` — cross-domain dependency edges (dangling)

A workspace may declare known upstreams as a top-level array:

```jsonc
"external_dependencies": [
  {
    "target_id":  "dom_OTHER26CHARCROCKFORDULID",   // the peer's domain.id (dom_ prefix required)
    "relation":   "upstream",                        // child | peer | upstream
    "resolution": {
      "kind":          "absent",                     // local | github | absent
      "expected_name": "payments-workspace",         // optional hint (human-readable)
      "hint":          "git@github.com:acme/payments-memory.git",  // optional
      "pin":           "abc123def456..."             // optional git SHA
    },
    "trust":       "manual",                         // auto | manual | blocked (default manual)
    "share_scope": "semantic"                        // any string — enum open until Q3
  }
]
```

**All edges are currently inert.** They are declarations of intent — a human-readable, diffable, shareable dependency map. No resolution machinery exists yet (that is Part 3, blocked on Q3). The `resolution.kind: "absent"` value is the canonical starting state for any edge whose remote config has not yet been fetched.

**Validation**: `validate-config.js` checks shape when the array is present (warn-only on any malformed entry; absence of the array is completely silent). `share_scope` is deliberately not enforced — its enum is open until Q3.

**Carry-through**: like `domain.id`, the array deep-clones into `config.portable.json` for free and flows to teammates.

## Non-goals

- Not auto-public. `visibility: private` is required; bootstrap refuses `public`.
- Not a replacement for per-repo docs — those stay in their repos.
- Not versioning run history — `runs/` is local (use the reporter for trends).
