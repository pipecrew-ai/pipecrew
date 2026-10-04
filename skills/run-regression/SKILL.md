---
name: run-regression
description: "Run a workspace's durable acceptance test suite ({workspace_root}/{slug}/testcases/, authored via /pipecrew:design-tests) and produce a release-gate report. Wraps the pipecrew:regression-runner agent. Three uses: full regression against a test environment (--env=<name>), UAT first-pass for one feature (--scope=feature:<slug> — the report doubles as the human sign-off sheet), and production smoke (--env flagged production → prod_safe read-only cases only). No environment configured → code-grounded verification against the current code. Uses the chrome-devtools MCP for UI cases when available. Standalone — does not touch /deliver or /discover."
---

## Usage
```
/run-regression [--env=<name>] [--scope=all|feature:<slug>] [--workspace=<slug>]
```

### Flags
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--env` | no | none → code-grounded mode | A key of `config.workspace.environments` (e.g. `uat`, `staging`, `production`). An env with `"production": true` restricts the run to `prod_safe` cases |
| `--scope` | no | `all` | `all` = the whole suite (regression); `feature:<slug>` = one feature's cases (UAT first-pass — report includes the human sign-off sheet) |
| `--workspace` | no | auto-detect | Workspace slug — resolved via the registry |

### Environments config (optional, in `config.json`)
```jsonc
"workspace": {
  "environments": {
    "uat":        { "base_url": "https://uat.example.com", "production": false },
    "staging":    { "base_url": "https://stg.example.com", "production": false,
                    "services": { "publisher-service": "https://stg-api.example.com" } },
    "production": { "base_url": "https://app.example.com", "production": true }
  }
}
```
No `environments` block (or no `--env`) is fine — the runner verifies cases against the current code instead (verdicts capped at `consistent`; only `fail` and `unverifiable` beyond that, plus `pass` where a repo's own test suite is runtime evidence).

### Examples
```
/run-regression --env=staging                       # full-suite release gate
/run-regression --env=uat --scope=feature:book-upload   # UAT first-pass + sign-off sheet
/run-regression --env=production                    # post-deploy smoke (prod_safe only)
/run-regression                                     # code-grounded verification, whole suite
```

## Instructions

### CRITICAL RULES

1. **Production is confirm-first.** If the resolved env has `"production": true`, show exactly what will run (the `prod_safe` case list and the target URL) and get an explicit `yes` before dispatching. Recommend read-only credentials. Never pass mutating cases to a production run — and the runner independently re-checks every step regardless (its Invariant 2).
2. **Read-isolation.** The orchestrator reads `testcases/INDEX.md` only — to select case FILES by scope. Case content loads into the runner agent, never into this session's context. Relay the runner's summary + report path, not the suite.
3. **Credentials are the operator's.** If the env needs auth, ask the user to provide it for this run (a token / test account they type, or already-exported env vars). Never fetch credentials from stores or files, never echo values back.
4. **Verdicts are the runner's.** Do not soften, reinterpret, or round up its pass/fail/consistent/unverifiable — a NO-GO gate is relayed as NO-GO.

### Step 1: Resolve workspace, scope, environment

1. Registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json` (add `--workspace=<slug>` if passed) → `{slug}`, `{workspace_root}`.
2. Read `{workspace_root}/{slug}/testcases/INDEX.md`. Missing/empty → `No test suite yet — run /design-tests first.` and stop.
3. Scope → case files: `all` = every `testcases/*.md` except INDEX.md; `feature:<slug>` = that one file (missing → list INDEX's features, ask). Collect absolute paths — do not open them.
4. Environment: no `--env` → code-grounded mode (`env: none`). With `--env`: read `config.workspace.environments[{name}]` from `{workspace_root}/{slug}/config.json`; unknown name → list the configured ones and ask (none configured → show the config block from Usage above and offer code-grounded mode instead). If `production: true`: filter to `prod_safe: true` cases via a grep over the selected files (`prod_safe.*true`) — zero prod-safe cases → say so and stop.
5. `purpose`: `smoke` if production env, `uat` if `--scope=feature:*`, else `regression`. Create `{run_dir}` = `{workspace_root}/{slug}/runs/run-regression/{YYYY-MM-DD-HHMMSS}/`.

### Step 2: Browser check (only if a live env + any UI-surface case)

Grep the selected case files for `Surface.*: ui` (orchestrator greps the field line only — not a content read). If none match, or mode is code-grounded: set `browser_available: false` and skip ahead.

Otherwise mirror `/assess` Step 4.5's MCP contract: `node {plugin_dir}/scripts/ensure-mcp.js status --name=chrome-devtools`.
- `present+connected` → `browser_available: true`.
- missing → tell the user UI cases need it and offer the install (`node {plugin_dir}/scripts/ensure-mcp.js install --name=chrome-devtools --cmd="npx -y chrome-devtools-mcp@latest" --scope=local`); a fresh install needs a Claude Code restart to load — let them choose: install + restart + re-run, or continue now with UI cases downgraded to code-grounded (`consistent` cap). Do not install silently.
- `cli_available:false` → `browser_available: false` with a one-line note.

### Step 3: Confirmation gate

Always show the run plan; production additionally requires the explicit yes (CRITICAL RULE 1):

```
Run regression — {slug}
  Env:     {name + base_url | code-grounded (no live environment)}
  Purpose: {regression | uat | smoke}
  Scope:   {N} case files ({M} cases{, K prod-safe-only} ) — {feature list or "full suite"}
  Browser: {available | unavailable → ui cases downgraded | n/a}
  {if env needs auth: Credentials: provide a token/test-account for this run, or say "unauthenticated" — auth-needing cases will come back unverifiable}

Proceed? (yes / no)
```

### Step 4: Dispatch the runner

**Tool**: `Agent` · **subagent_type**: `pipecrew:regression-runner` · **description**: `"Run {purpose} — {slug} ({env name | code-grounded})"`

```
workspace_root: {workspace_root}
slug: {slug}
case_files: {absolute paths}
env: {none | {name, production, base_url, services, notes}}
browser_available: {true|false}
repo_roster: {key → {path, type, role} from config.json}
run_dir: {run_dir}
purpose: {purpose}
{credentials the user supplied for this run, if any}
```

### Step 5: Relay + sync offer

Relay the runner's gate verdict verbatim (`GO | NO-GO`), the per-verdict counts, failures with their evidence, the report path, and any mistagged-prod_safe flags (those should go back through `/design-tests` to fix the tag). For `purpose: uat`, point at the report's human sign-off sheet — the agent verified behavior; a human accepts intent.

The run updated `last_verified` in the attempted case files + INDEX. If `config.workspace.memory.enabled`, offer (don't auto-run):
```
Sync the verification timestamps to the team memory repo? (yes / no)
yes → node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} --message "run-regression: {env|code-grounded} {GO|NO-GO}" --checkpoint=run-regression
no  → they ride the next sync automatically
```

## Notes
- **Pairing**: `/design-tests` authors the suite (test-designer agent); `/run-regression` executes it (regression-runner agent). Same author/run split as implementer/reviewer.
- **Honest verdicts**: `pass` needs runtime evidence from this run; code-grounded agreement is `consistent`, never pass. `unverifiable` is a to-do list for making the suite runnable, not noise — recurring ones usually mean a missing environment entry or missing credentials.
- **Release ritual fit**: full suite against staging/UAT = the gate; after deploying, `--env=production` = the prod_safe smoke layer. Mutating cases run in production only if a workspace builds synthetic-tenant support (future `env` field on cases — see `docs/design/test-cases.md`).
- **Pipelines untouched.** `/deliver` and `/discover` do not invoke this; integration is a recorded follow-up in the design doc.
