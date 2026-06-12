# Reducing tool-permission prompts during `/deliver`

If a `/deliver` run prompts you constantly during implementation — "Allow
`Bash(mvn test)`?", "Allow `Edit`?", "Allow `Write`?" — those are **Claude
Code's own tool-permission prompts**, not pipeline approval gates. This doc
explains the difference and how to quiet them.

## These are NOT pipeline gates

Two different systems can pause a run. Don't confuse them:

| | Pipeline approval gate | Claude Code tool-permission prompt |
|---|---|---|
| Looks like | `Phase X — approve to continue? (yes/no)` | `Allow Bash(mvn test)? / Allow Edit?` |
| Raised by | the `/deliver` orchestrator (`scripts/gate.js`) → yellow site-view banner | Claude Code itself, per tool call |
| Frequency | ~once per phase boundary | **once per Bash/Edit/Write a dispatched agent makes** |
| Quieted by | flags (`--auto-fix-mechanical`, `--no-review`) | **this doc** (permission config) |

`/deliver` pauses for a *pipeline gate* only at phase boundaries (requirements,
architecture, spec, plan, the Phase 5b UX step, and per-repo Phase 5.5 review
gates). Implementation itself runs unattended. So a flood **during
implementation** is always tool-permission prompts — each backend/frontend
implementer makes dozens of `Bash`/`Edit`/`Write` calls, and Claude Code prompts
for each one that isn't pre-approved.

> Reviewers are `Read, Glob, Grep`-only (see `rules/reviewer-common.md`), so
> Phase 5.5 review is naturally quiet — read tools rarely prompt. Prompts during
> *review* are usually the per-repo pipeline gates, not tool permissions.

## Fastest fix — permission mode

Press **Shift+Tab** in the Claude Code prompt to cycle permission modes and pick
**"accept edits"**. That auto-accepts every `Edit`/`Write` (the bulk of the
flood) while still prompting for `Bash`. Or launch the session with:

```
claude --permission-mode acceptEdits
```

The built-in **`/fewer-permission-prompts`** skill walks you through this
interactively.

## Durable fix — an allowlist

Add a `permissions.allow` block to **`~/.claude/settings.json`** (user-level,
applies to every project) or a project's **`.claude/settings.json`**. Allow
rules are additive and apply to dispatched subagents too, so one block covers
every implementer the pipeline spawns.

```jsonc
{
  "permissions": {
    "allow": [
      "Edit",
      "Write",

      // version control the implementers + worktree setup use
      "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)",
      "Bash(git diff:*)", "Bash(git log:*)", "Bash(git rev-parse:*)",
      "Bash(git merge-base:*)", "Bash(git worktree:*)",
      "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git restore:*)",

      // build + test — keep only the stacks your workspace actually uses
      "Bash(mvn:*)", "Bash(./mvnw:*)", "Bash(gradle:*)", "Bash(./gradlew:*)",
      "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(yarn:*)",
      "Bash(node:*)", "Bash(tsc:*)", "Bash(jest:*)", "Bash(vitest:*)",
      "Bash(eslint:*)", "Bash(prettier:*)",
      "Bash(pytest:*)", "Bash(python:*)", "Bash(python3:*)",
      "Bash(poetry:*)", "Bash(ruff:*)", "Bash(mypy:*)",
      "Bash(go:*)", "Bash(cargo:*)", "Bash(dotnet:*)",

      // the plugin's own zero-dep scripts (gate.js, extract-block.js, …)
      "Bash(node *pipecrew/scripts/*)"
    ]
  }
}
```

### Safety tradeoff — read before pasting

A wildcard like `Bash(npm:*)` also auto-allows `npm publish`; `Bash(git
checkout:*)` can discard uncommitted work; `Bash(cargo:*)` allows `cargo
install`. The list above trades some safety for far fewer prompts — fine for an
interactive run you're watching, riskier for an unattended one. To tighten,
scope each rule to the exact invocation instead of a wildcard, e.g.:

```jsonc
"Bash(npm ci)", "Bash(npm test)", "Bash(npm run build)", "Bash(npm run test:*)"
```

Start with just `"Edit"` + `"Write"` — that alone removes most of the flood,
because file edits vastly outnumber commands — and add `Bash(...)` rules only
for the build/test commands you actually see prompting.

### Never default to this

`--permission-mode bypassPermissions` (a.k.a. "yolo" mode) auto-approves
**everything**, including `rm -rf`, deploys, and pushes. Use it only in a
throwaway sandbox, never against real repos.

## Scope note

Subagents inherit the session's permission mode and allowlist, so configuring
the session once covers every implementer and reviewer the pipeline dispatches —
you do not configure agents individually.

## Related

- `docs/site-view-notifications.md` — the `gate.js` allowlist (a different,
  narrow set of rules so the orchestrator's gate-open/close calls don't prompt).
- `docs/design/autonomy-trust-mode.md` — design notes on a fuller hands-off
  mode for `/deliver`.
