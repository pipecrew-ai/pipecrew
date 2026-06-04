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

### Step 3: Dispatch the reviewer

**Tool**: `Agent`
**subagent_type**: `{reviewer-agent}`
**description**: `"Review — {repo-name} — {branch}"`
**prompt**:

```
You are reviewing code in the repo at {repo_path}, branch {branch}.
Diff base: {base_branch}.

Read {repo_path}/CLAUDE.md first for conventions.

Get the diff:
  cd {repo_path} && git diff {base_branch}...{branch}

Review the diff against the repo's conventions and any OpenAPI spec
at {spec_file} (if applicable).

Produce your full report in the Output Format from your system prompt.
```

### Step 4: Present the report

Show the reviewer's full report to the user. Highlight critical findings count.

If critical findings exist:
```
{N} critical findings. Run /deliver with a fix round, or fix manually.
```
