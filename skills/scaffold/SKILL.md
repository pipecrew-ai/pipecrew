---
name: scaffold
description: "Scaffold new repos from scratch or from an example. Two modes: --from-scratch uses a PROJECT_BRIEF to create repo skeletons with git init + baseline CLAUDE.md; --from-example clones structure from a reference repo. Standalone skill — can be called directly or by /discover --greenfield."
---

## Description

Creates repo directories, initializes git, and writes a baseline CLAUDE.md per repo. Does NOT run framework init commands (`create-next-app`, `spring init`, etc.) — those are the user's choice to run inside the scaffolded dir, or the first feature's implementer will add them.

## Usage

```
/scaffold --from-scratch --brief=<path> --parent=<dir>
/scaffold --from-example --source=<repo-path-or-url> --target=<dir>
```

### Flags

| Flag | Effect |
|------|--------|
| `--from-scratch` | Create repos from a PROJECT_BRIEF |
| `--from-example` | Clone structure from an existing repo |
| `--brief=<path>` | Path to PROJECT_BRIEF.md (from-scratch mode) |
| `--parent=<dir>` | Where to create repos (default: current working directory) |
| `--source=<path\|url>` | Reference repo (from-example mode) — local path or git URL |
| `--target=<dir>` | Where to put the new repo (from-example mode) |
| `--name=<name>` | Override name for the new repo (from-example) |
| `--no-git` | Skip `git init` |

### Examples

```
/scaffold --from-scratch --brief={workspace_root}/habit-tracker/brief.md --parent=~/projects/habit-tracker
/scaffold --from-example --source=~/projects/some-nextjs-app --target=~/projects/new-app --name=dashboard
```

## Instructions

### CRITICAL RULES

1. **Never overwrite an existing non-empty directory.** If the target exists and has content, abort and report.
2. **Never run framework scaffolders** (`create-next-app`, `nest new`, etc.) — those introduce dependencies the user may not want. Create a minimal skeleton instead and let the first feature's implementer add framework files.
3. **Always `git init`** unless `--no-git` is passed. Set the initial branch to `main`.
4. **Every scaffolded repo gets a baseline CLAUDE.md** that names the tech stack, the role, and a one-line project summary. The `/discover` flow (or the user) can enrich it later.
5. **Report the created structure** so the caller can feed paths back into `/discover`.

### MODE 1: `--from-scratch`

1. Read the brief at `--brief=<path>`. Extract the `<!-- BEGIN PROJECT_BRIEF -->` section.
2. Parse the **Recommended repo topology** section — each repo is `name — role — tech stack`.
3. For each repo:
   - Create `{parent}/{name}/` (abort if it exists with content)
   - Create skeleton subdirs based on tech stack (see skeletons below)
   - Write baseline `CLAUDE.md` (see template below)
   - Write `.gitignore` appropriate to the stack
   - Run `git init -b main` + initial empty commit
4. Report created paths.

#### Skeleton per tech stack

Keep minimal. The architect/implementer adds framework files.

| Stack | Dirs created |
|-------|--------------|
| `spring-boot` | `src/main/java/`, `src/main/resources/`, `src/test/java/`, `openapi/` |
| `nestjs` | `src/`, `test/`, `openapi/` |
| `fastapi` | `app/`, `tests/`, `openapi/` |
| `nextjs` | `src/app/`, `src/components/`, `public/` |
| `react` | `src/`, `public/` |
| `cdk` | `lib/`, `bin/`, `test/` |
| `node-mock` | `src/`, `specs/` |
| `other` | `src/` |

#### Baseline CLAUDE.md template

```markdown
# {repo name}

{one-line project summary from brief}

## Stack
- **Type**: {tech stack}
- **Role**: {role}

## Status
Greenfield — scaffolded {date}. No code yet.

## How to work on this repo
See the workspace-level platform.md and this repo's `agent-context/` (once created) for conventions. Until the first feature ships, there are no conventions — the first implementer establishes them.
```

### MODE 2: `--from-example`

1. If `--source` is a git URL, clone it to a temp dir. If it's a local path, read it in place.
2. Walk the source repo and identify the **structural skeleton** — dirs, config files, conventions docs. Skip:
   - `node_modules/`, `target/`, `dist/`, `.git/`, build outputs
   - Secrets: `.env*`, `*.pem`, anything matching the source's `.gitignore`
   - Feature code — keep only top-level placeholders
3. Create `{target}/` and copy:
   - Directory structure (empty dirs)
   - Config files (`package.json`, `pom.xml`, `tsconfig.json`, etc.) — adjust the project `name` field to `{name}` or target dir name
   - Conventions docs (`CLAUDE.md`, `agent-context/`, `README.md`) — with a note at the top that this was derived from `{source}`
   - `.gitignore`, `.editorconfig`, lint configs
4. Do NOT copy:
   - `src/` contents (only the empty `src/` dir)
   - Tests (only the empty `tests/` dir)
   - Lockfiles (`package-lock.json`, `yarn.lock`) — let the user regenerate
5. Rewrite CLAUDE.md's "Status" section to say "Scaffolded from {source} on {date}".
6. Run `git init -b main`.
7. Report created paths + what was skipped.

### Output

Report in this format so `/discover` can parse it:

```
<!-- BEGIN SCAFFOLDED_REPOS -->
| Path | Type | Role | Git initialized |
|------|------|------|-----------------|
| /abs/path/to/repo-1 | nextjs | frontend | yes |
| /abs/path/to/repo-2 | nestjs | api-service | yes |
<!-- END SCAFFOLDED_REPOS -->
```

## You are not done until

- Every repo in the topology has its directory created
- Every repo has a CLAUDE.md
- Every repo has git initialized (unless `--no-git`)
- The SCAFFOLDED_REPOS block is printed so `/discover` can continue into Phase A with the new paths
