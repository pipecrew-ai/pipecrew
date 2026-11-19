---
name: test-and-fix
description: "Test one feature on one environment and fix what fails, in a closed loop: run the feature's acceptance cases (regression-runner), re-run failures once to drop flaky ones, group the rest, send each group straight to the stack implementer when the runner's evidence already localizes it — or through the read-only troubleshooter first when it doesn't — then re-run only the failed cases, up to 2 fix rounds (max 3). Ends with a full-feature pass, a read-only review of the total diff (with an anti-overfit check), and a per-case report. Production is verify + read-only diagnosis only. One branch per run, commits only with --commit, never pushes. Bounces contract/requirements changes to /deliver and outdated cases to /design-tests. Needs a suite from /design-tests."
---

# /test-and-fix

## Usage
```
/test-and-fix --feature=<slug> [--env=<name>] [--max-iterations=2] [--no-review] [--commit] [--no-worktrees] [--workspace=<slug>]
```

### Flags
| Flag | Default | Effect |
|------|---------|--------|
| `--feature` | required | Feature slug — `{ws}/testcases/{slug}.md` must exist |
| `--env` | none → code-grounded | A key of `config.workspace.environments`. Decides the reach mode (below) |
| `--max-iterations` | `2` | Fix rounds. Clamped to 1..3 |
| `--no-review` | review ON | Skip the final read-only reviewer pass |
| `--commit` | OFF | Commit each touched repo at the end |
| `--no-worktrees` | worktrees ON | Fix in place on each repo's current checkout |
| `--workspace` | auto-detect | Workspace slug, resolved via the registry |

### Environment entries (in `config.json` → `workspace.environments`)
Same entries `/run-regression` uses, plus two optional fields read only by this skill:
```jsonc
"local":   { "base_url": "http://localhost:3000", "production": false,
             "local": true, "serves_from": "web-app" },   // serves_from: repo key the local server runs from
"staging": { "base_url": "https://stg.example.com", "production": false }
```

### Reach modes (how a fix gets onto the environment)
| Mode | When | Re-verify |
|------|------|-----------|
| `a` code-grounded | no `--env` | Runner reads the worktree (`repo_roster` → worktree paths); the repo's own tests are runtime evidence |
| `b` local | env has `local: true` or `serves_from` | User restarts the local server from the worktree, replies `ready` |
| `c` deployed | any other non-production env | Deploy gate per round: user deploys the branch, replies `deployed` (or `skip` → code-grounded, capped at `consistent`) |
| `prod` | env has `production: true` | Verify + optional read-only diagnosis, then hand-off lines. Never fixes |

### Examples
```
/test-and-fix --feature=book-upload                      # code-grounded, fix against current code
/test-and-fix --feature=book-upload --env=staging        # deploy gate each round
/test-and-fix --feature=book-upload --env=local --commit
/test-and-fix --feature=book-upload --env=production     # verify + diagnose only, prints hand-offs
```

## Instructions

### CRITICAL RULES

1. **Production is never fixed.** Reach `prod` → verify (prod_safe cases) + optional read-only diagnosis, then hand-off lines. No branch, worktree, implementer, or re-run against production.
2. **Read-isolation.** The orchestrator reads `testcases/INDEX.md` only. Only the regression-runner gets case file paths. Troubleshooters and implementers get `REGRESSION_FAILURES` entries (excerpts) — never a `testcases/` path or the suite.
3. **The loop never edits cases.** A case that looks outdated goes to `/design-tests`, not to a fix.
4. **Bash-guard marker.** `~/.claude/.pipecrew-troubleshooter-active` is armed only around troubleshooter dispatches and removed (`rm -f`) right after them, before ANY implementer dispatch, and first thing in every error path.
5. **Never push, open a PR, or merge.** Commit only with `--commit`.
6. **Verdicts are the runner's.** Relay them; never round up `consistent` or `unverifiable`.
7. **Shared rules apply.** Checkpoint events per `rules/observability.md` (`skill: "test-and-fix"`; `agent_start`/`agent_end` around every dispatch; per-repo descriptions encode the repo), gates via `scripts/gate.js open/close`, retries per `rules/transient-failures.md`, implementer/reviewer `subagent_type` via the TYPE_TO_AGENT table in `skills/deliver/phases/dispatch-rules.md`.

### Step 0: Preflight

1. Registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json` (+ `--workspace=<slug>`) → `{slug}`, `{workspace_root}`; `{ws}` = `{workspace_root}/{slug}`. Validate: `node {plugin_dir}/scripts/validate-config.js {ws}/config.json` — stop on failure.
2. Read `{ws}/testcases/INDEX.md`. Missing → `No test suite yet — run /design-tests first.` and stop. `{ws}/testcases/{feature}.md` missing → list INDEX's features and ask.
3. Env: no `--env` → reach `a`, `env: none`. With `--env`: read `config.workspace.environments[{name}]` (unknown → list configured names and ask). `production: true` → reach `prod`; grep the feature file for `prod_safe.*true` — none → say so and stop. `local: true` or `serves_from` → reach `b`. Else → reach `c`.
4. `{run_dir}` = `{ws}/runs/test-and-fix/{YYYY-MM-DD-HHMMSS}-{feature}/` with `tasks/` and `rounds/`. Emit `run_start`. `{branch}` = `fix/{feature}-{env name | local}-{YYYY-MM-DD}`. `{troubleshooter}` = `{slug}-troubleshooter` (absent from the session's agent list → note it; diagnose groups will be parked).
5. Browser check — `/run-regression` Step 2, only for reach `b`/`c`/`prod` with `Surface: ui` cases → `{browser_available}`.
6. Run-plan gate (`gate.js open --phase=verify --gate=approval`). Reach `prod` requires an explicit `yes`:
   ```
   Test and fix — {slug} · {feature}
     Env:      {name + base_url | code-grounded}
     Reach:    {a code-grounded | b local (serve {serves_from} from the worktree) | c deployed (deploy gate each round) | prod (verify + diagnose only)}
     Cases:    {M}{, prod_safe only}
     Rounds:   up to {max-iterations} · Review: {on | off} · Commit: {on | off} · Worktrees: {on | off}
     Browser:  {available | unavailable → ui cases code-grounded | n/a}
     {if auth needed: Credentials: provide for this run, or "unauthenticated"}
   Proceed? (yes / no)
   ```

Then load `phases/phase-verify.md`.

## PHASE FILES

| Phase | File |
|-------|------|
| Verify + flaky confirm | `phases/phase-verify.md` |
| Fix loop (plan → gate → diagnose → apply → re-verify) | `phases/phase-fix-loop.md` |
| Final pass, review, report, commit | `phases/phase-review-report.md` |

## Bounce rules (a group leaves the loop)

| Condition | Output |
|-----------|--------|
| Fix needs an OpenAPI spec, shared schema, or contract change; a new cross-repo wire shape; touches more than 2 repos; or is a redesign, not a correction | `This needs design — run: /deliver "<restated change>"` |
| The failing Then conflicts with the requirements, or requirements are unclear | `Product decision needed — run: /deliver "<restated change>"` |
| The case itself is outdated (spec drift) | `Case looks outdated — run: /design-tests --run=<run_id>` (or baseline) |
| Root cause `Localized` / `Not yet`, or no troubleshooter | Parked for a human, with the troubleshooter report path |

## See also
- `/run-regression` — the same runner as a pure release gate (`--only` re-runs single cases)
- `/troubleshoot --from-regression` — the diagnose step on its own
- `/patch --from-troubleshoot` — apply one diagnosed fix without the loop
- `templates/test-and-fix-task.md.template`, `scripts/plan-fix-groups.js`, `templates/blocks/block-schemas.md` § REGRESSION_FAILURES
