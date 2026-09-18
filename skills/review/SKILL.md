---
name: review
description: "Standalone code review. Diffs a feature branch against main in one repo, dispatches the appropriate tech-stack reviewer agent, and returns a structured report with findings. Use for PR review or reviewing code not produced by the /deliver pipeline."
---

## Usage
```
/review <repo-key> --branch=<branch> [--workspace=<slug>]
/review <repo-path> --branch=<branch> --type=<tech-stack>
```

### Arguments
- `repo-key`: a key from the workspace config's `repos` block (e.g., `publisher-service`)
- OR `repo-path`: absolute path to a repo (if not using workspace config)

### Flags
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--branch` | yes | — | Feature branch to review (e.g., `feature/contract-types`) |
| `--workspace` | no | auto-detect | Workspace slug — used to find config for repo type |
| `--type` | no | from config | Override tech stack type (spring-boot, react, nextjs, nestjs, fastapi) |
| `--base` | no | `main` | Base branch to diff against |

### Examples
```
/review publisher-service --branch=feature/contract-types
/review publisher-service --branch=feature/contract-types --workspace=my-platform
/review /path/to/repo --branch=feature/upload --type=spring-boot --base=develop
```

## Instructions

### Step 1: Resolve repo info

**If `repo-key` is provided** (no `/` in the argument):
1. Read `{workspace_root}/{workspace}/config.json`
2. Look up `repos[repo-key]` → get `path`, `type`
3. If not found, report error and stop

**If `repo-path` is provided** (contains `/`):
1. Use the path directly
2. `--type` flag is required (no config to look it up from)

### Step 2: Resolve reviewer agent

Use the TYPE_TO_AGENT mapping:

| `type` | Reviewer agent |
|--------|---------------|
| `spring-boot` | `spring-boot-reviewer` |
| `react` | `react-reviewer` |
| `nextjs` | `nextjs-reviewer` |
| `nestjs` | `nestjs-reviewer` |
| `node-mock` | *(skip — mock not reviewed)* |
| `cdk` | *(skip — CDK verified by synth)* |
| `fastapi` | *(no dedicated reviewer yet — report this and skip)* |

If the type has no reviewer, report "No reviewer agent for type '{type}'. Skipping." and exit cleanly.

### Step 3: Pre-compute the diff (reviewers have no `Bash`)

Reviewer agents are granted `Read, Glob, Grep, Write` — no `Bash` — so they cannot run `git diff` themselves (`Write` exists solely for persisting a report file in the `/deliver` pipeline; their read-only-on-code rule plus the Step 5 backstop keeps the repo untouched). Pre-compute the diff to a file first; the helper prints only a byte-count, so the diff body never enters your context:

```bash
node {plugin_dir}/scripts/write-review-diff.js --worktree={repo_path} --base={base_branch} --out={diff_out}
```

`{diff_out}` = `{workspace_root}/{workspace}/runs/review/{run_id}/{repo}.diff` when a workspace is known, otherwise an OS temp path (e.g. `{tmpdir}/pipecrew-review-{repo}-{branch-slug}.diff`). The branch under review must be checked out in `{repo_path}` (or pass `--base` such that `{base_branch}...HEAD` is the intended comparison).

### Step 4: Dispatch the reviewer

**Tool**: `Agent`
**subagent_type**: `{reviewer-agent}`
**description**: `"Review — {repo-name} — {branch}"`
**prompt**:

```
You are reviewing code in the repo at {repo_path}, branch {branch}.
Diff base: {base_branch}.

Read {repo_path}/CLAUDE.md first for conventions.

Read the diff: it is pre-computed at {diff_out} (DIFF FILE) — Read that file;
it is the complete set of changes to review. You have no Bash and never run
git yourself; use Read/Glob/Grep over the repo for any surrounding context.

Review the diff against the repo's conventions and any OpenAPI spec
at {spec_file} (if applicable).

Produce your full report in the Output Format from your system prompt.
```

### Step 5: Backstop + present the report

**Read-only backstop:** after the reviewer returns, run `git -C {repo_path} status --porcelain`. If non-empty, the reviewer mutated the repo (a read-only-on-code violation — its `Write` grant is for report files only, never the repo). Revert (`git -C {repo_path} checkout -- . && git -C {repo_path} clean -fd`, or `git stash`), and warn the user that a reviewer mutated the tree and a `claude` restart / plugin reinstall may be needed. The findings are still valid.

Show the reviewer's full report to the user (this standalone skill passes no `REPORT FILE`, so the reviewer returns the full report per its Report delivery rule). Highlight critical findings count.

If critical findings exist:
```
{N} critical findings. Run /deliver with a fix round, or fix manually.
```
