# Flag naming conventions

Every skill in the plugin uses the same conventions for command-line flags. The goal: a user who has learned `/discover` can guess `/deliver` flag names, and vice versa.

## The five flag families

### 1. `--skip-<phase>` — skip a specific phase

Use when the user wants to omit a named phase entirely (because it's already done outside the pipeline, or genuinely not wanted).

Examples:
- `--skip-divergence-harvest` — `/discover` skips Phase B2.5.
- `--skip-requirements` — `/deliver` skips Phase 1 (caller passes pre-built requirements).
- `--skip-assessment` — `/deliver` skips Phase 6.
- `--skip-spec-edit` — `/deliver` skips Phase 3 (spec already updated).
- `--skip-backend` — `/deliver` skips Phase 3 + Phase 5a (spec + backend done).

Phase name is lowercase kebab, matching the phase title (or a short mnemonic). Don't invent new names per skill.

### 2. `--no-<auto-behavior>` — disable a default-ON behavior

Use when the skill has an automatic behavior that is on by default and the user wants to suppress it.

Examples:
- `--no-review` — disables Phase 5.5 code review.
- `--no-context-update` — disables Phase 7.2 context-manager refresh.
- `--no-security` — disables the smart-trigger security review.

Pair with `--force-<auto-behavior>` when the auto-behavior is smart-triggered (conditional on keywords, heuristics, etc.) and the user wants to force it ON:
- `--force-security-review` — forces security review even without trigger keywords.

Plain `--no-X` (without a `--force-X` sibling) means "I know this is on by default; turn it off for this run." Users don't need to invoke `--force-X` in that case.

### 3. `--with-<opt-in-action>` — enable an off-by-default extra action

Use when the skill can optionally do something extra that is off by default.

Examples:
- `--with-pr` — create a pull request at the end of `/deliver` (default is commits only, no PR).

If the extra action has a smart-trigger variant, use the `--no-` / `--force-` pair from family 2 instead.

### 4. `--<scope>-only` — positive scope restriction

Use when restricting the run to a subset of the natural scope.

Examples:
- `--backend-only` — `/deliver` runs Phase 5a only (no 5b/5c/5d).
- `--frontend-only` — `/deliver` runs Phase 5b only.

Scope names are lowercase kebab. Only use `-only` when there's a well-understood default scope the user is restricting.

### 5. `--<resource>=<value>` — typed parameter

Use when the flag carries a value the skill needs to operate.

Examples:
- `--workspace=<slug>` — pick a workspace by slug (all skills).
- `--feature=<slug>` — pick an in-flight `/deliver` run by slug (for `/deliver --resume` and `/site-view`).
- `--base=<ref>` — `/review`'s diff base.

Values are not quoted by default; shell quoting handles spaces.

## Anti-patterns — do NOT use these

- ❌ `--<phase>-ready` — ambiguous ("the phase is ready" could mean "run it" or "skip it"). Replace with `--skip-<phase>`.
- ❌ `--disable-X` — use `--no-X`.
- ❌ `--enable-X` — use `--force-X` or `--with-X`.
- ❌ `--X` as boolean-flag synonym of `--force-X` — spell out `--force-X` to stay grep-friendly.
- ❌ `--verbose`, `--debug`, `--quiet` — logging modes are out of scope for skills; the plugin emits structured events to `checkpoints.jsonl` instead.

## Renames applied 2026-04-15

| Old | New |
|---|---|
| `--spec-ready` | `--skip-spec-edit` |
| `--backend-ready` | `--skip-backend` |
| `--security-review` | `--force-security-review` |

Old names are not aliased — the rename is breaking (which is free since the plugin has no external users).

## Per-skill flag inventory (current state)

### `/discover`
`--workspace=<slug>`, `--resume`, `--greenfield`, `--skip-divergence-harvest`.

### `/deliver`
`--workspace=<slug>`, `--resume`, `--feature=<slug>`, `--skip-requirements`, `--skip-assessment`, `--skip-spec-edit`, `--skip-backend`, `--frontend-only`, `--backend-only`, `--no-review`, `--no-security`, `--force-security-review`, `--no-context-update`, `--with-pr`.

### `/review`
`--workspace=<slug>`, `--branch=<name>`, `--type=<stack>`, `--base=<ref>`.

### `/assess`
`--workspace=<slug>`, `--branch=<name>`, `--requirements=<path>`.

### `/context-refresh`
`--workspace=<slug>`, `--mode=<audit|refresh>`.

### `/site-view`
`--workspace=<slug>`, `--feature=<slug>`.

## Adding a new flag — checklist

1. Identify the family (1–5 above).
2. Pick a name following the family's pattern.
3. If it's a `--no-X` with smart-trigger logic, also expose `--force-X`.
4. Add to the skill's SKILL.md `### Flags` table.
5. Add to the per-skill inventory above.
6. If the flag changes phase selection, update the skill's Flag Behavior Summary table.
