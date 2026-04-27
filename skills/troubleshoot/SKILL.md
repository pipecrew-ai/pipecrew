---
name: troubleshoot
description: "Cross-repo incident triage. Takes a one-line symptom + optional flags, runs a hypothesis-driven investigation against the workspace's logs and recent diffs (using the OBSERVABILITY routing table from platform.md), and writes a structured report. READ-ONLY by hard rule — the troubleshooter agent's system prompt forbids mutating commands, and an optional `PreToolUse` hook backed by `scripts/troubleshooter-bash-guard.js` enforces the same allowlist at tool-dispatch time."
---

## Read-only guarantee — the hard rule

The troubleshooter agent operates strictly **read-only**. Three layers, all on by default once the plugin is installed:

1. **Agent system prompt** — `templates/agents/troubleshooter.md.template` opens with a HARD RULES block (R1: Bash allowlist, R2: blocklist, R3: pre-flight self-check, R4: escape valve for would-be mutations, R5: bash-guard awareness, R6: `report.md` is the only permitted write). The agent reads these on every invocation. Always on.
2. **Bash guard script** — `scripts/troubleshooter-bash-guard.js` is a deny-by-pattern classifier (111 unit tests). Catches AWS / kubectl / docker / git / filesystem / package-manager / HTTP / DB mutations, shell-access escapes (`kubectl exec`, `aws ssm start-session`), evasion (`$(...)`, backticks, standalone `eval`/`exec`, `nohup`, base64-pipe-bash, output redirects, backgrounding), and long-running flags (`-f`, `--watch`). Unknown commands are denied conservatively — the allowlist is what the troubleshooter actually needs, nothing more.
3. **Plugin-shipped `PreToolUse` hook** — `.claude-plugin/hooks/hooks.json` installs the guard as a Bash `PreToolUse` intercept the moment the plugin is installed. The agent literally cannot execute a mutation: Claude Code blocks the Bash call before it runs.

### How the hook stays scoped to /troubleshoot only

Claude Code's hook matcher syntax has no `agentMatcher` — a `PreToolUse` hook on `Bash` fires for **every** Bash dispatch from **every** agent in the user's environment. We work around this with a marker file:

```
~/.claude/.pipecrew-troubleshooter-active
```

The `/troubleshoot` skill writes this file (with the orchestrator's pid + run_id) before dispatching the troubleshooter agent and removes it on completion. The guard checks the marker on every hook invocation:

- **Marker absent** (no /troubleshoot run active) → guard exits 0 immediately. Other agents — implementers, reviewers, the user's own `git push` / `npm install` / `terraform apply` — are completely unaffected.
- **Marker present but pid is dead** (orchestrator crashed, marker left behind) → guard auto-cleans the stale marker and exits 0. Self-healing.
- **Marker present + pid alive** → guard runs the full allowlist/blocklist classifier. Mutations are rejected; the agent receives the deny reason on stderr and (per HARD RULE R4) writes the would-be mutation into `report.md` for a human.

Net effect: the hook is a no-op except during a live `/troubleshoot` run, and during that run it is a hard intercept on the troubleshooter agent's Bash calls. No `agentMatcher` needed; no impact on the rest of the user's agents.

### Disabling the hook (if needed)

If for any reason you want to disable the hook (e.g., debugging a false-positive in the guard), uninstall it via:

```bash
# Disable plugin hooks user-wide
claude config set plugins.pipecrew.hooks.enabled false
```

…or simply remove the marker file's create step from the `/troubleshoot` skill (Step 3 below) — without the marker, the hook never enforces. Layers 1 + 2 still hold: the agent's HARD RULES still apply, and the guard script remains callable manually for testing.

---


## Usage

```
/troubleshoot <symptom> [flags]
```

### Required

A free-form symptom description (one line is fine):

```
/troubleshoot bulk upload returns 500 for files larger than 10MB
```

### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--since` | no | `1h` | Log time window (`30m`, `2h`, `2026-04-28T10:00`). |
| `--repo` | no | auto | Narrow to one repo by name (skip cross-repo trace). |
| `--trace-id` | no | — | Trace / request ID — agent jumps straight to that path across services. |
| `--user-id` | no | — | User / tenant ID — for filtering logs and reproducing locally. |
| `--evidence` | no | — | Path to a local file with stack trace / HAR / log paste. Agent reads it instead of re-asking for it. |
| `--env` | no | `prod` | Env to investigate (`prod` / `staging` / `dev` / `local` — or whatever the workspace defines). |
| `--auto` | no | off | Skip the hypothesis-approval gate; agent picks the top candidate and investigates. Use for routine triage; leave off when prod is on fire. |
| `--workspace` | no | auto-detect | Workspace slug (reads config for repo list and which troubleshooter agent to dispatch). |
| `--learn` | no | off | At end of run, propose a runbook / platform.md update from what was learned. User approves before write. |

### Examples

```
/troubleshoot bulk upload 500s on files >10MB --since=2h --env=prod
/troubleshoot login redirect loop --user-id=a8f2 --evidence=./session.har
/troubleshoot worker DLQ growing --auto --since=30m
/troubleshoot 502 from gateway --trace-id=abc123 --learn
```

## Instructions

### Step 1: Read workspace config

Read `{workspace_root}/{workspace}/config.json`. Get the list of all repos and the `workspace.slug` value (used to dispatch the troubleshooter agent by name: `{slug}-troubleshooter`).

If `--workspace` was not provided, auto-detect by checking the current working directory against each `workspace_root/*/config.json`. If multiple match, ask the user to disambiguate.

### Step 2: Pre-flight — verify OBSERVABILITY block

Before dispatching the agent, confirm the platform.md OBSERVABILITY block is populated and valid:

```bash
node {plugin_dir}/scripts/validate-observability.js {workspace_root}/{slug}/context/platform.md
```

If the validator exits non-zero with "0 log destinations":
```
The OBSERVABILITY routing table in platform.md is empty — the troubleshooter
won't be able to query logs by service+env.

Options:
  1. Run /discover --refresh now to populate it.
  2. Continue anyway (agent will work from the symptom + recent diffs only,
     and will ask you to paste any logs it needs).

(1 / 2)?
```

If the validator exits non-zero with structural errors, surface them and stop — don't dispatch the agent against a malformed table.

### Step 3: Initialize run dir + arm the bash-guard hook

```bash
mkdir -p {workspace_root}/{slug}/runs/troubleshoot/{timestamp}-{slug-of-symptom}
```

Where `{slug-of-symptom}` is the first 6-8 words of the symptom kebab-cased and truncated to 40 chars.

Write a `scratchpad.md` with the initial inputs (symptom, flags, env, user/trace IDs).

**Arm the marker file.** This is what activates the plugin's `PreToolUse` bash guard for the upcoming troubleshooter dispatch. Without the marker the hook is a no-op (so other agents in the user's session keep working normally); with it, every Bash call from the troubleshooter agent is vetted against the read-only allowlist.

```bash
mkdir -p ~/.claude
cat > ~/.claude/.pipecrew-troubleshooter-active <<EOF
pid=$$
run_id={timestamp}-{slug-of-symptom}
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
```

The `pid=$$` value MUST be the orchestrator's pid (the shell process running this skill), not the troubleshooter agent's pid — the guard's stale-detection logic kills the marker if THIS pid is dead. The troubleshooter is a child agent; if it crashes, the orchestrator still runs and the marker stays armed correctly until cleanup.

**Critical**: the marker MUST be removed in Step 6 (the wrap-up step) regardless of whether the run succeeds or fails. Treat Step 6 as a `finally` block.

### Step 4: Dispatch the troubleshooter agent

**Tool**: `Agent`
**subagent_type**: `{slug}-troubleshooter` (published by `/discover` Phase C)
**description**: `"Troubleshoot — {symptom-truncated}"`
**prompt**:

```
Investigate the following symptom on the {{WORKSPACE_NAME}} platform.

SYMPTOM: {symptom}

FLAGS:
  since: {since}
  env: {env}
  repo: {repo or "any"}
  trace_id: {trace-id or "none"}
  user_id: {user-id or "none"}
  evidence_file: {evidence or "none"}
  auto: {true if --auto else false}

WORKSPACE CONTEXT:
- Platform context: ~/.claude/{slug}-context/platform.md (read this first)
- Workspace config: {workspace_root}/{slug}/config.json
- Run directory: {run_dir} (write your report.md here)

REPOS:
{for each repo in workspace config:}
- {repo.name} ({repo.type}, {repo.role}) at {repo.path}

INPUT MATERIAL:
{if evidence file provided:}
- Pre-supplied evidence: {evidence-path} (read it via the Read tool before
  forming hypotheses)

Follow your system prompt's investigation process:
  Step 0: Read platform.md, extract the OBSERVABILITY block.
  Step 1: Triage (≤3 questions, only if input is genuinely ambiguous).
  Step 2: Hypotheses ranked. {if --auto: "skip the user-approval gate."}
  Step 3: Investigate the top hypothesis using the OBSERVABILITY routing
          table to pick log destinations. Cross-repo trace where evidence
          points across a service boundary.
  Step 4: Cross-repo follow-through.
  Step 5: Write report.md to {run_dir}.

Report your final report.md path back to the orchestrator.
```

If `--auto` was passed, the agent runs end-to-end without prompting. Otherwise, the agent will pause at the hypotheses gate and surface the ranked list — you (the orchestrator) relay it to the user, capture their answer, and forward back to the agent.

### Step 5: Present the report

Read the agent's `report.md` and surface it to the user. Highlight:
- Root cause section (whether Found / Localized / Not yet).
- Suggested next action.
- Any "Runbook update candidate" the agent proposed.

If `--learn` was passed AND the agent proposed a runbook update:

```
The agent proposed adding this to the runbook / platform.md:

  > {proposed-entry}

Apply it? (yes / edit / no)
```

On `yes`: append to `docs/runbooks/{filename}.md` (create the runbooks dir if it doesn't exist) OR add to platform.md's `## Open Questions / Evolving Decisions` section if the entry is more about platform knowledge than incident response.

On `edit`: open an edit loop with the user to refine the entry before writing.

On `no`: skip — but keep the entry in the run's `report.md` for future reference.

### Step 6: Wrap up — ALWAYS runs (success, failure, or interruption)

This step is the `finally` block: it must execute even if Steps 4 or 5 errored, the user cancelled, or the agent returned an error report. Do NOT skip it.

**Disarm the marker file** so the bash-guard hook stops vetting Bash calls (other agents in the user's session would otherwise see false-positive denials on legitimate mutations):

```bash
rm -f ~/.claude/.pipecrew-troubleshooter-active
```

If the marker was already cleaned by a stale-marker auto-recovery, `rm -f` no-ops. Either way, after this command the guard is back to fast-allow mode.

**Print a one-liner:**

```
Troubleshoot run complete: {workspace_root}/{slug}/runs/troubleshoot/{run-id}/report.md
Root cause: {Found / Localized / Not yet}
Next action: {one-line summary}
```

If the user wants to act on the suggested fix:
- For a code fix in a single repo: they can run that repo's implementer agent directly with the fix-list from the report.
- For a cross-repo fix: they can run `/deliver` with the fix scope as the feature description.
- For an infra/config change: they edit and re-deploy manually — the troubleshooter is read-only on infra by design.

### Error / interruption handling

If anything between Step 3 and Step 5 fails (the troubleshooter agent errors, the user cancels, the platform.md file is unreadable), the orchestrator MUST still execute the marker cleanup from Step 6 before surfacing the error to the user. Treat the marker cleanup as the first action in any error path.

If the orchestrator process itself dies before cleanup (the user kills the session entirely), the guard's stale-pid detection handles it — on the next Bash dispatch from any agent, the guard sees the dead pid in the marker, removes the marker, and exits 0. The next session starts clean.
