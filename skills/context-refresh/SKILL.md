---
name: context-refresh
description: "Audit or refresh agent-context docs in a repo. Checks for stale references, missing coverage, and optionally updates the docs to match current code reality."
---

## Usage
```
/context-refresh <repo-key-or-path> [--mode=audit|refresh] [--workspace=<slug>]
```

### Arguments
- `repo-key-or-path`: a key from the workspace config's `repos` block, or an absolute repo path

### Flags
| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `audit` | `audit` = report-only (no file changes). `refresh` = update stale docs. |
| `--workspace` | auto-detect | Workspace slug for config lookup |

### Examples
```
/context-refresh publisher-service
/context-refresh publisher-service --mode=refresh
/context-refresh /path/to/repo --mode=audit
```

## Instructions

### Step 1: Resolve repo

Same resolution logic as `/review` — key from config or raw path.

Verify `{repo_path}/agent-context/` exists. If not:
- `audit` mode: report "No agent-context directory found. Run `/discover` first or generate with `/context-refresh --mode=refresh`."
- `refresh` mode: ask "No agent-context exists. Generate from scratch? (yes / no)". If yes, dispatch context-manager in `full` mode (which writes agent-context AND rewrites CLAUDE.md as an index). If the repo is claude-only by design, keep it that way and stop.

### Step 2: Dispatch context-manager

**Tool**: `Agent`
**subagent_type**: `context-manager`
**description**: `"Context {mode} — {repo-name}"`
**prompt**:

```
Mode: {mode}
Repo: {repo_path}
Repo type: {type}
Repo role: {role}

{if mode == "audit":}
Read the agent-context docs at {repo_path}/agent-context/.
Scan the codebase for stale references, missing coverage, and contradictions.
Produce the staleness report. Do NOT modify any files.

{if mode == "refresh":}
Read the agent-context docs at {repo_path}/agent-context/.
Compare against current code reality. Update any stale references.
Add coverage for new modules, endpoints, or features that aren't documented.

If any agent-context/common/ topic files were added or removed, update CLAUDE.md's `## Deep context` table to match, then run:
  node {plugin_dir}/scripts/validate-claude-md.js {repo_path}/CLAUDE.md
Fix any validator errors before finishing. Do not touch CLAUDE.md's stable sections.

Report what you changed.
```

### Step 3: Present results

For `audit` mode: show the staleness report.
For `refresh` mode: show the list of files modified with a summary of changes.
