# CLAUDE.md — working on the PipeCrew plugin

Guidance for any agent editing **this repository**. This repo *is* the PipeCrew Claude Code
plugin (and its marketplace). Editing files here changes the shipped plugin — it is **not** a
user workspace.

> Don't confuse this file with the `CLAUDE.md` files PipeCrew *generates* for user repos during
> `/discover`. Those are agent-context for someone else's codebase; this one is the dev guide for
> the plugin itself.

## What this repo is

A git-based Claude Code plugin marketplace. Users install it from GitHub and get slash-skills
(`/discover`, `/deliver`, `/review`, `/assess`, `/patch`, `/learn`, `/context-refresh`,
`/memory-sync`, plus the site-view tooling). The plugin manifests live in `.claude-plugin/`
(`marketplace.json`, `plugin.json`, `hooks/hooks.json`).

## Layout

| Dir | What's in it |
|-----|--------------|
| `skills/` | One dir per slash-skill; `SKILL.md` is the entry, `phases/` holds the pipeline steps |
| `agents/` | Sub-agent definitions dispatched by the skills |
| `scripts/` | Zero-dependency Node helpers + their co-located `*.test.js` |
| `rules/` | Cross-cutting contracts every skill obeys — **`observability.md` is the checkpoint source of truth** |
| `templates/` | JSON Schemas + block templates (e.g. `checkpoints-event.schema.json`) |
| `eval/` | Layered regression harness (`run.js`) |
| `docs/` | Deep references (e.g. `docs/site-view.md`) |

## Testing — run before every push

```bash
node eval/run.js            # all layers that need no API key (structural + script behavior)
node scripts/<name>.test.js # a single unit test
```

- Every script in `scripts/` should have a co-located `scripts/<name>.test.js`; the eval's layer 2
  auto-discovers them. Add one when you add a script.
- `node eval/run.js` must be green (exit 0) before you push. It's the same gate every PR passes.

## Conventions

- **Scripts are zero-dependency, pure Node stdlib.** Prefer a small deterministic script over
  asking an LLM to parse — and give it an offline test hook (`--input=<file>`) like
  `collect-pr-feedback.js` / `collect-session-feedback.js`.
- **Checkpoints (`rules/observability.md`) are authoritative.** Anything that reads run state
  (site-view, reporter) consumes `checkpoints.jsonl`; the schema is
  `templates/checkpoints-event.schema.json` and the validator is `scripts/validate-checkpoints.js`
  — keep all three in lockstep.
- **`scripts/stages.js` is the single source of truth for the phase→stage mapping** (the six
  chapters: Understand → Contract → Build → Verify → Ship → Learn). The site-view server, the
  checkpoint validator, and any future reporter derive stages from it. `phase` is authoritative;
  `stage_group` is an optional, derived, validated echo.
- **Site-view:** the v2 stage-flow UI (`skills/site-view/public/index-v2.html`) is the default at
  `/`; the original stays at `/v1` for rollback. Both share the same `/state` + `/events` backend.

## Previewing site-view / UI changes

```bash
node scripts/simulate-run.js --port=5173               # live demo, animates ~33s (v2 at /)
node scripts/simulate-run.js --step-ms=0 --port=5173   # static, completed run
```

Fabricates a demo workspace under `{workspace_root}/simulate-run-demo/` and serves the UI — no
agent tokens spent. Open `http://127.0.0.1:5173/` (v2) or `/v1`. See `docs/site-view.md`.

## Releasing — how users actually get updates

**The gate: `plugin.json`'s `version`.** Claude Code offers an update only when that string
changes. If you merge work to `main` without bumping it, **existing users see nothing.** So every
user-facing change ships as a version bump + release.

Release ritual (semver — feature → minor, fix → patch):

1. **Bump `version` in `.claude-plugin/plugin.json`.** Keep the version there **only** — never also
   in `marketplace.json` (if both are set, `plugin.json` silently wins).
2. **Update `CHANGELOG.md`** with the new version's Added/Fixed notes.
3. **Tag and publish a GitHub Release:**
   ```bash
   git tag -a vX.Y.Z -m "PipeCrew vX.Y.Z" && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "…"   # reuse the CHANGELOG entry
   ```

Tag `main` at the release commit, after the work is merged. Once the Release is published,
`releases/latest` returns the new tag, which drives:

- the once-a-day, fail-silent **update-notify hook** (`scripts/update-check-hook.js`, wired as a
  `SessionStart` hook in `.claude-plugin/hooks/hooks.json`) that nudges users when they're behind;
- users with **auto-update** on (off by default for third-party marketplaces) get prompted to
  `/reload-plugins` at startup.

How a user updates: `/plugin marketplace update pipecrew` → `/plugin install pipecrew@pipecrew`
→ `/reload-plugins`. (Documented in the README "Updating" section — keep it current.)

## Git / PR conventions

- Branch off `main`; don't commit UI/feature work onto an unrelated branch.
- PRs are **squash-merged** to `main` (one commit per PR, `… (#N)`).
- After pushing, verify the push actually landed before merging — a silent push failure will merge
  a stale branch.
- Commit trailers used in this repo: `Co-Authored-By:` and `Claude-Session:`.
