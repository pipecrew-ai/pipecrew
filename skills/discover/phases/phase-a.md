## Phase A: Repo Discovery

Scan the provided parent directories for repos. A directory is a repo if it contains a `.git/` folder.

### Step 0: Greenfield check

If the `--greenfield` flag was passed, skip to `phases/phase-greenfield.md` — do not scan.

Otherwise, if Step 1 finds **zero repos**, stop and load `phases/phase-greenfield.md` to prompt the user. If the user declines greenfield, ask for a different parent_dir and re-run Step 1.

If the greenfield phase ran and scaffolded repos, skip Step 1 — the scratchpad's `## Discovered Repos` table already has the paths. Jump to Step 2.

### Step 1: Scan for repos

For each parent directory, run:

```bash
find {parent_dir} -maxdepth 2 -name ".git" -type d | sed 's|/.git$||'
```

This finds repos up to 2 levels deep. Collect the list.

### Step 2: Detect tech stack per repo

For each discovered repo, detect the tech stack by checking for sentinel files:

| Sentinel file(s) | Detected `type` |
|-------------------|----------------|
| `pom.xml` + `src/main/java/` | `spring-boot` |
| `package.json` + `next.config.*` | `nextjs` |
| `package.json` + `nest-cli.json` OR `src/main.ts` with `@nestjs` | `nestjs` |
| `package.json` + `src/App.tsx` OR `vite.config.*` OR `react-scripts` in deps | `react` |
| `requirements.txt` OR `pyproject.toml` + `fastapi` in deps | `fastapi` |
| `package.json` + `cdk.json` | `cdk` |
| `package.json` + files matching `**/server.js` with `express` | `node-mock` |
| None of the above | `other` |

Run these checks with `Bash` (test file existence) or `Grep` (search for patterns in package.json/pom.xml). Do them in parallel across repos (multiple Bash calls in one message).

### Step 3: Detect role per repo

Infer the architectural role from the tech stack and directory name:

| Heuristic | Detected `role` |
|-----------|----------------|
| `type` is `spring-boot` or `nestjs` or `fastapi` AND has an OpenAPI spec file | `api-service` |
| `type` is `react` or `nextjs` | `frontend` |
| `type` is `node-mock` OR directory name contains `mock` | `mock-server` |
| `type` is `cdk` OR directory name contains `infra` or `ops` or `platform` | `infrastructure` |
| None of the above | `other` |

For api-services, also search for OpenAPI spec files. Use a broad pattern that covers the common conventions (`openapi.yaml`, `specs.yaml`, files under an `openapi/` directory, and the `*-api-specs.yaml` convention seen in many API-first Spring Boot / FastAPI repos):

```bash
find {repo_path} -maxdepth 5 \
  \( -name "openapi*.yaml" -o -name "openapi*.yml" \
     -o -name "specs.yaml" -o -name "specs.yml" \
     -o -name "*-api-specs.yaml" -o -name "*-api-specs.yml" \
     -o -path "*/openapi/*.yaml" -o -path "*/openapi/*.yml" \) \
  -not -path "*/target/*" -not -path "*/node_modules/*" \
  -not -path "*/build/*" -not -path "*/dist/*" \
  -not -path "*/cdk.out/*" -not -path "*/.git/*" \
  | head -10
```

If more than one spec is returned for the same repo, pick the first as `spec_file` and record the rest as `additional_specs` — common when one backend service hosts multiple bounded-context APIs (e.g., ABVI backoffice-service hosting backoffice + contract + publisher specs).

### Step 4: Check for existing CLAUDE.md

For each repo, check if `{repo_path}/CLAUDE.md` or `{repo_path}/.claude/CLAUDE.md` exists. Record the result.

### Step 5: Check for existing agent-context

For each repo, check if `{repo_path}/agent-context/` or `{repo_path}/agent-context-v2/` exists. Record the result.

### Step 6: Present discovery summary to user

Show a table and ask for confirmation:

```
## Discovered Repos

| # | Repo | Type | Role | Spec | CLAUDE.md | Agent-Context |
|---|------|------|------|------|-----------|---------------|
| 1 | abvi-publisher-service | spring-boot | api-service | openapi/specs.yaml | exists | — |
| 2 | abvi-pms-frontend | react | frontend | — | missing | exists (v2) |
| 3 | abvi-backends-mock | node-mock | mock-server | — | missing | — |
| 4 | abvi-ops-platform | cdk | infrastructure | — | missing | — |

Corrections? You can:
- Change type/role for any repo (e.g., "repo 3 is actually nestjs, role api-service")
- Exclude a repo (e.g., "exclude repo 4")
- Add a repo not in this list (e.g., "add /path/to/another-repo as spring-boot api-service")

Confirm to proceed to domain questions.
```

Wait for user confirmation. Apply any corrections.

**Update scratchpad**: write the confirmed repo list to the `## Discovered Repos` table in `scratchpad.md`. Set Phase A status to COMPLETED. Set Current Phase to "B1. Domain Questions".

---
