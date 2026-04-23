---
name: assess
description: "Standalone cross-repo assessment. Checks a feature branch across all repos for cross-repo integration: wire-shape agreement, requirement enforcement symmetry, event/infra wiring. Use for verifying manually-implemented features or pre-merge validation."
---

## Usage
```
/assess --branch=<branch> [--workspace=<slug>]
```

### Flags
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--branch` | yes | — | Feature branch to assess (must exist in at least 2 repos) |
| `--workspace` | no | auto-detect | Workspace slug — reads config for repo list |
| `--requirements` | no | — | Path to a requirements doc (if not from a pipeline run) |

### Examples
```
/assess --branch=feature/contract-types
/assess --branch=feature/upload --workspace=my-platform --requirements=./requirements.md
```

## Instructions

### Step 1: Read workspace config

Read `{workspace_root}/{workspace}/config.json`. Get the list of all repos.

### Step 2: Find repos with the branch

For each repo in the config, check if the branch exists:

```bash
cd {repo.path} && git rev-parse --verify {branch} 2>/dev/null && echo "HAS_BRANCH" || echo "NO_BRANCH"
```

Collect the repos that have the branch. If fewer than 2 repos have it, warn:
```
Only {N} repo(s) have branch '{branch}'. Cross-repo assessment needs at least 2.
Assess anyway? (yes / no)
```

### Step 3: Gather context

**If `--requirements` is provided**: read the file.
**If a pipeline scratchpad exists** (`{pipeline_dir}/active.md`): read requirements and architecture from the outputs directory.
**Otherwise**: the assessor will work from the spec and code only (less coverage but still useful).

### Step 4: Dispatch the assessor

**Tool**: `Agent`
**subagent_type**: `dal-assessor` (or `{workspace}-assessor` if a workspace-specific one exists at `{workspace_root}/{slug}/agents/assessor.md`)
**description**: `"Cross-repo assessment — {branch}"`
**prompt**:

```
Assess the feature on branch '{branch}' across these repos:

{for each repo with the branch:}
- {repo.name} ({repo.type}, {repo.role}) at {repo.path}
  Spec: {repo.spec_file or "none"}

{if requirements provided:}
REQUIREMENTS FILE: {path}
Read it via the Read tool.
{else:}
No explicit requirements doc. Assess spec compliance and cross-repo integration
from the code diff and OpenAPI specs only.

Platform context: {workspace_root}/{slug}/context/platform.md
Read it for domain and architecture context.

For each repo, get the diff:
  cd {repo.path} && git diff main...{branch}

Focus on CROSS-REPO integration:
1. Wire-shape agreement (backend DTOs ↔ frontend types ↔ mock responses)
2. Requirement enforcement symmetry (same rule enforced on both sides)
3. Event/infra wiring (queue names match, S3 ARNs align)
4. End-to-end requirement coverage (trace each FR through the full stack)

Produce your assessment report with an overall score (PASS / PARTIAL / FAIL)
and fix assignments per repo.
```

### Step 5: Present the report

Show the full assessment report. If the score is PARTIAL or FAIL, list the fix assignments clearly:

```
## Assessment: {PASS / PARTIAL / FAIL}

{N} cross-repo issues found:
- {summary per issue}

Fix assignments:
- {repo}: {what to fix}
```

If the user wants to fix: they can either run `/deliver` with a fix round or fix manually and re-run `/assess`.
