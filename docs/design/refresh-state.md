# Design note — shared, committed refresh-state baseline

**Status:** implemented. Engine: `scripts/refresh-state.js` (+ tests). Wired into `/discover`
(seed), `/context-refresh` (decide/advance), and `/deliver` (advance). Supersedes the
machine-local `runs/context-refresh/state.json` fast-path state.

## The idea in one sentence

Drop a **bookmark** — *"these docs were verified as of commit X"* — inside each repo's
`agent-context/` folder and **commit it**, so the next `/context-refresh` reads only what changed
since X (a git diff) instead of the whole codebase, and so a teammate who pulls the docs gets the
bookmark too.

## Problem

`/context-refresh`'s fast path needs that baseline so it can diff `X..HEAD`, map changed files to
the docs they affect, and re-verify only those instead of re-reading everything.

Historically the baseline lived in **machine-local** `runs/context-refresh/state.json`, which
`/memory-sync` deliberately never syncs. Two consequences:

1. **It was never shared.** Dev A refreshes, advances their local baseline to SHA `X`, and syncs
   the *doc* to the team. Dev B pulls the doc but has no matching baseline, so B's next
   `/context-refresh` re-audits work A already did. "Verified through `X`" is a property **of the
   doc**, yet it was stranded on one laptop.
2. **A fresh `/discover` left no baseline at all.** `/discover` reads the whole codebase and
   generates the docs *from* it — current by construction — but wrote no baseline, so the first
   `/context-refresh` fell through to a full re-read of everything just read. Same gap after
   `/deliver` merges a feature.

## Principle

**Co-locate the bookmark with the doc it describes, in the same git unit.** A git SHA is a
globally-identical, mergeable key, so "verified through `X`" is portable — and if the bookmark
lives in the same versioned unit as the doc, it travels with the doc across clones, branches, and
merges automatically, with no separate distribution channel.

For per-repo `agent-context/`, that unit is the **code repo itself** → a committed
`agent-context/.refresh-state.json`. It is branch-correct for free: a feature branch sees the
bookmark as of its branch point, and every clone already has it.

(The workspace-level `platform.md` bookmark rides the existing `/memory-sync` channel and is a
separate follow-up — this note + implementation cover the per-repo half, which is the important,
branch-correct one.)

## File format

One file per repo, one baseline, at `agent-context/.refresh-state.json`:

```json
{
  "schema": 1,
  "repo": "publisher-service",
  "baseline": {
    "head_sha": "4a9e8f2c…",
    "branch": "main",
    "ran_at": "2026-07-08T12:00:00Z",
    "mode": "full",
    "by": "discover"
  }
}
```

`mode` (`full`/`fast`) and `by` (`discover`/`context-refresh`/`deliver`) are **informational** —
they record who moved the bookmark and how; no decision logic reads them. It is **committed, not
ignored** — that is the whole point. It's tiny and human-editable; delete it to force a full audit
on the next run.

## The decision: full / fast / skip

`decide(state, ctx)` is the whole decision tree in one pure function:

| Result | Means | Chosen when |
|---|---|---|
| **skip** | read nothing | HEAD == bookmark SHA and the working tree is clean |
| **fast** | read only `bookmark..HEAD` | HEAD moved past the bookmark |
| **full** | re-read the whole codebase | no bookmark, branch changed, uncommitted changes with no new commit, an unreadable/conflicted file, or `--full` |

The guiding rule: **when in doubt, choose `full`.** A full scan is always correct — it never skips
unverified code. So every uncertain case (no baseline, wrong branch, garbage file, merge conflict)
degrades safely to a full scan rather than risking a stale doc.

## Concurrency: merge conflicts are left to engineers (deliberate trade-off)

Because the bookmark is **committed**, two teammates can each `advance` it on different branches and
it will **conflict on merge** — git leaves `<<<<<<<` / `=======` / `>>>>>>>` markers in the JSON,
exactly like any other file.

**We do NOT auto-resolve this.** An earlier draft shipped an "older-wins" resolver (pick the
bookmark whose SHA is an ancestor of the other; collapse divergent histories to a full-audit
sentinel). We removed it, on purpose, because:

- The file is committed, so the conflict surfaces **at merge time in git** — the normal place an
  engineer resolves conflicts. Resolving is trivial: keep either SHA, or delete the file. There is
  no data to lose (it's a regenerable bookmark, not source of truth).
- If an *unresolved* conflicted file ever reaches a `/context-refresh` run, the engine can't parse
  it, treats it as **no baseline**, and does a **full scan** — always safe. `decide` reports the
  reason as *"unresolved merge conflict … resolve it in git; running full audit meanwhile"* so the
  operator knows to fix it.

**The risk we accepted:** a merge conflict on `.refresh-state.json` is a small manual chore for
whoever does the merge, and — if they don't notice or ignore it — costs **one extra full scan** on
the next refresh (after which `advance` rewrites a clean file and normal fast-path resumes).
Correctness is never at stake; only the occasional wasted full scan. We judged that a far better
trade than ~40 lines of ancestry-resolution logic and a `git merge-base --is-ancestor` dependency
for a rare event. If clashes ever prove frequent in practice, the resolver can be reintroduced
behind `readStateFile` without touching the file format or the wiring.

## The engine — `scripts/refresh-state.js`

Zero-dependency, pure-core + thin git/FS layer, offline-testable (`decide --input=<json>`).

| Subcommand | Used by | Effect |
|---|---|---|
| `seed --repo=<p>` | `/discover` (Phase C) | write a baseline at current HEAD (`mode: full`) — only if `agent-context/` exists |
| `decide --repo=<p>` | `/context-refresh` (Step 1.5) | print `{path: full\|fast\|skip, comparisonSha, reason}` |
| `advance --repo=<p> --mode=fast\|full` | `/context-refresh` (Step 4.5), `/deliver` (Phase 7) | move the bookmark to current HEAD |
| `path --repo=<p>` | tooling | print the state-file path |

## Lifecycle

1. **`/discover`** generates `agent-context/` for a repo, then `seed`s the bookmark at the current
   commit → the docs ship *with* a "verified through this SHA" stamp. The team gets it on clone;
   the first `/context-refresh` anyone runs is already incremental.
2. **`/context-refresh`** runs `decide` per repo → full / fast / skip. After a successful refresh it
   `advance`s the bookmark and commits it alongside the doc edits. A **failed** refresh does NOT
   advance (preserves the comparison point so the next run retries the same delta).
3. **`/deliver`** advances the bookmark in its worktree at Phase 7 for repos whose docs it touched,
   so it merges to `main` with the feature and the next refresh diffs from the delivered commit.
4. **Merges** may conflict on the file → an engineer resolves it in git (or leaves it, costing one
   full scan). No automatic reconciliation.

## What was intentionally left out

- **No periodic "every Nth fast run → full audit" counter.** The original had one as a drift
  backstop. Dropped for simplicity; the safe-default-to-full behavior already bounds the blast
  radius of any single stale bookmark, and `--full` is always available for an explicit re-verify.
- **No dirty-tree threshold.** Any uncommitted change with no new commit → full (rather than a
  tunable "> N files" rule).
- **No legacy `runs/state.json` migration.** Existing workspaces take one full scan on first run
  after upgrading, then seed a clean committed bookmark — a one-time cost, not worth migration code.
- **No conflict resolver** (see the concurrency section above).

## Trade-off

A PipeCrew bookkeeping file (`agent-context/.refresh-state.json`) now lives inside each code repo,
and merge conflicts on it are a manual chore. That's the cost of branch-correct, zero-channel
sharing with a dead-simple engine. Teams that refuse a tool file in the app repo can fall back to a
`repo → {sha, branch}` map in the memory tier — but that loses clean branch-awareness, so it's only
recommended if committing to the code repo is off the table.
