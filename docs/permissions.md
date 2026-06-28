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

## Plugin-native fix — `/deliver --auto-approve`

If you don't want to touch `settings.json` at all, run the pipeline with
`--auto-approve`. At pre-flight it writes an opt-in marker
(`scripts/autoapprove-marker.js on`) that the plugin's
`scripts/deliver-autoapprove-hook.js` (a `PreToolUse` hook) reads to suppress
prompts — but **only for clearly-safe calls**:

- **Auto-approved:** `Edit` / `Write` / `MultiEdit`, and `Bash` whose every
  `&&`/`|`/`;`-separated segment leads with a known build/test/local-git/read
  verb (`mvn`, `npm`, `pytest`, `go`, `cargo`, `git diff/add/commit`, `ls`,
  `grep`, …).
- **Still prompts (never auto-approved, even with the flag on):** `rm`,
  `git push`, `--force`, `git reset --hard`, deploys (`cdk deploy`, `terraform
  apply`, `serverless deploy`), `kubectl apply/delete`, `npm publish`, `sudo`,
  shell substitution (`$(…)`, backticks), pipes into a shell, output redirects
  (except `/dev/null`), and any unknown binary. These fall through to the normal
  permission prompt.

This is **not** `bypassPermissions` — it removes the routine flood while keeping
a human in the loop for anything risky or unclassifiable. The marker is removed
at run end / interruption and self-expires ~6h after the run goes idle, so it
never leaks into a later session. Differences vs. the allowlist above:

| | `--auto-approve` | `permissions.allow` |
|---|---|---|
| Setup | none — just pass the flag | edit `settings.json` once |
| Scope | only while that `/deliver` run is active | always on (until you remove it) |
| Dangerous commands | always still prompt | whatever you allowlisted is allowed unconditionally |
| Granularity | fixed safe-verb policy | you choose exact patterns |

After a plugin install/upgrade the hook needs a **`claude` restart** to load
(confirm with `/hooks`); until then `--auto-approve` writes a harmless marker
that simply has no effect.

## Plugin-native fix (interactive) — `setup-workspace-permissions.js`

The `--auto-approve` hook above only fires during an active `/deliver` run. When
you work **interactively** in a workspace — editing across repos, reviewing,
committing, running tests — two things prompt repeatedly:

1. **Cross-repo edits/commands.** Claude Code trusts the launch cwd's tree; a
   sibling repo or git worktree is outside it, so every edit there prompts.
2. **Routine safe commands** the allowlist above would cover, if you'd set one up.

`/discover` Step 3.5 (Part B) offers to fix both at once, deterministically:

```bash
node {plugin_dir}/scripts/setup-workspace-permissions.js --config={workspace_root}/{slug}/config.json
# preview without writing:
node {plugin_dir}/scripts/setup-workspace-permissions.js --config=… --dry-run
```

It reads `config.repos`, finds the repos' common parent directory, and
writes/merges a `.claude/settings.local.json` there with:

- **`additionalDirectories`** = every repo parent + the workspace dir — so editing
  any repo from inside another no longer prompts. Because Claude Code walks up
  from the launch cwd to find settings, one file at the shared parent loads for
  **every** repo and worktree beneath it.
- a **safe-only** allowlist (Edit/Write, read-only + local-only git, the `git
  worktree` lifecycle the pipeline drives, build/test for the common stacks, read
  tools, and the Phase-6 `chrome-devtools` MCP `mcp__chrome-devtools__*` for live
  browser verification). `git push`, `reset --hard`, `clean`, `rm`, deploys,
  `docker push`, and language `install`/`publish` subcommands (`go install`,
  `cargo install`/`publish`, `npm publish`, `dotnet nuget push`) are deliberately
  omitted, so they keep prompting.

Both `/discover` Step 3.5 and **`/deliver` pre-flight** surface this helper: pre-flight
runs it in `--dry-run` and, if the workspace has no allowlist yet, prints the exact
command to run (then a `claude` restart loads it). This is what stops the cross-repo
edit flood, the dispatched-agent ADR write being denied under `context/adrs/`, the
backend-compile prompt, and the Phase-6 browser-verification MCP prompts.

It MERGES (union, order-stable) and never clobbers a hand-curated file; an
unparseable existing file is left untouched. Re-runnable on an already-onboarded
workspace — it's idempotent. Restart `claude` (or run `/permissions`) afterward
to load the rules.

This is the right tool for the everyday cross-repo friction; the `--auto-approve`
hook is the right tool for an unattended `/deliver` run. They're complementary.

## Scope note

Subagents inherit the session's permission mode and allowlist, so configuring
the session once covers every implementer and reviewer the pipeline dispatches —
you do not configure agents individually.

## Related

- `docs/site-view-notifications.md` — the `gate.js` allowlist (a different,
  narrow set of rules so the orchestrator's gate-open/close calls don't prompt).
- `docs/design/autonomy-trust-mode.md` — design notes on a fuller hands-off
  mode for `/deliver`.
