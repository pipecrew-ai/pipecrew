## Phase A: Repo Discovery

Scan the provided parent directories for repos. A directory is a repo if it contains a `.git/` folder.

### Step 0: Greenfield check

If the `--greenfield` flag was passed, skip to `phases/phase-greenfield-brainstorm.md` — do not scan.

Otherwise, if Step 1 finds **zero repos**, stop and load `phases/phase-greenfield-brainstorm.md` to prompt the user. If the user declines greenfield, ask for a different parent_dir and re-run Step 1.

If the greenfield phase ran and scaffolded repos, skip Step 1 — the scratchpad's `## Discovered Repos` table already has the paths. Jump to Step 2.

### Step 1: Scan for repos

For each parent directory, run:

```bash
find {parent_dir} -maxdepth 2 -name ".git" -type d | sed 's|/.git$||'
```

This finds repos up to 2 levels deep. Collect the list.

### Step 1.5: Detect an existing workspace → choose full vs incremental

Before detecting tech stacks, check whether this directory belongs to an
**already-onboarded** workspace and, if so, whether repos have been added since.
Apply the shared rules at `{plugin_dir}/rules/incremental-discovery.md` § "Phase A
— Step 1.5":

- If `{workspace_root}/{slug}/config.json` does **not** exist → `discover_mode =
  full`; continue Phase A normally over every scanned repo.
- If it exists → diff the scan against `config.repos[*].path`, compute
  `new_repos` / `known` / `missing`, and present the auto-detect gate. The user's
  choice sets `discover_mode` (`incremental` is the default when there are new
  repos). `--full` forces `full` and skips the gate.

Record `Discover mode` (and, in incremental mode, the `## Incremental` block) in
the scratchpad per the rules file. **In `incremental` mode the confirmed repo
list for the rest of Phase A — and for B2.0 / B3 / C — is `new_repos` only**;
Steps 2–6 below run over that set. In `full` mode, Steps 2–6 run over every
scanned repo as before.

### Step 2: Detect tech stack per repo

For each discovered repo, detect the tech stack by checking for sentinel files:

| Sentinel file(s) | Detected `type` |
|-------------------|----------------|
| `pom.xml` + `src/main/java/` | `spring-boot` |
| `package.json` + `next.config.*` | `nextjs` |
| `package.json` + `nest-cli.json` OR `src/main.ts` with `@nestjs` | `nestjs` |
| `package.json` + `src/App.tsx` OR `vite.config.*` OR `react-scripts` in deps | `react` |
| `requirements.txt` OR `pyproject.toml` + `fastapi` in deps | `fastapi` |
| `requirements.txt` OR `pyproject.toml` + `flask` in deps | `flask` |
| `manage.py` at root, OR `django` in deps | `django` |
| `package.json` + `cdk.json` | `cdk` |
| `package.json` + files matching `**/server.js` with `express` | `node-mock` |
| `template.yaml`/`template.yml` (SAM), `serverless.yml`, `lambda_function.py`, `handler.py` with Python, OR Python + `celery`/`boto3` SQS/SNS consumer patterns and no web framework | `python-worker` |
| `.tf` files at repo root or in a top-level module directory | `terraform` |
| `.avsc` (Avro), `.proto` (Protobuf), or top-level `*.schema.json` / `schemas/` directory with JSON Schema and no service code | `schemas` |
| `*.postman_collection.json`, Insomnia export, or directory named `collections/`/`postman/` with no service code | `api-collections` |
| None of the above | `other` |

Run these checks with `Bash` (test file existence) or `Grep` (search for patterns in `package.json`, `pom.xml`, `requirements.txt`, `pyproject.toml`). Do them in parallel across repos (multiple Bash calls in one message).

**Ordering note**: when multiple sentinels match (e.g., a Spring Boot repo also contains a Terraform subfolder), pick the more specific runtime type (`spring-boot`) over infra (`terraform`). Python framework detection (`fastapi` > `flask` > `django` > `python-worker`) follows the order in the table — `python-worker` is the fallback for "Python with no web framework". Schema/collections repos are only classified as such when there is **no** runtime service code in the same repo.

### Step 3: Detect role per repo

Infer the architectural role from the tech stack and directory name:

| Heuristic | Detected `role` |
|-----------|----------------|
| `type` is `spring-boot`, `nestjs`, `fastapi`, `flask`, or `django` | `api-service` |
| `type` is `react` or `nextjs` | `frontend` |
| `type` is `node-mock` OR directory name contains `mock` | `mock-server` |
| `type` is `cdk` or `terraform` OR directory name contains `infra` or `ops` or `platform` | `infrastructure` |
| `type` is `python-worker` | `worker` |
| `type` is `schemas` or `api-collections` | `contract` |
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

### Step 3.5: Infer `spec_policy` per service

For every repo classified as a **service** (roles `api-service` or `worker`), pick a `spec_policy` value. This drives whether `/deliver` Phase 3 edits an OpenAPI spec for this service, asks the architect to inline the endpoint contract, or skips the spec step entirely.

| Condition | `spec_policy` |
|-----------|---------------|
| `role` is `api-service` AND an OpenAPI spec file was found in Step 3 | `api-first` |
| `role` is `api-service` AND no spec file was found | `code-first` |
| `role` is `worker` (python-worker or other non-HTTP runtime) | `no-api` |

Repos with `role` other than `api-service` / `worker` (`frontend`, `mock-server`, `infrastructure`, `contract`, `other`) do **not** get a `spec_policy` — the field is omitted for them.

Surface the inferred value in the Step 6 table so the user can correct it (e.g., "repo 13 is code-first, not api-first").

### Step 4: Check for existing CLAUDE.md

For each repo, check if `{repo_path}/CLAUDE.md` or `{repo_path}/.claude/CLAUDE.md` exists. Record the result.

### Step 5: Check for existing agent-context

For each repo, check if `{repo_path}/agent-context/` or `{repo_path}/agent-context-v2/` exists. Record the result.

### Step 6: Present discovery summary to user

**Incremental mode**: the table shows only the `new_repos` being onboarded; prefix
it with a one-line reminder — `Incremental onboarding of {N} new repo(s); {K}
existing repo(s) kept as-is.` — and otherwise behave identically (corrections
apply to the new repos).

Show a table and ask for confirmation:

```
## Discovered Repos

| # | Repo | Type | Role | Spec | Policy | CLAUDE.md | Agent-Context |
|---|------|------|------|------|--------|-----------|---------------|
| 1 | abvi-publisher-service | spring-boot | api-service | openapi/specs.yaml | api-first | exists | — |
| 2 | abvi-pms-frontend | react | frontend | — | — | missing | exists (v2) |
| 3 | abvi-backends-mock | node-mock | mock-server | — | — | missing | — |
| 4 | abvi-ops-platform | cdk | infrastructure | — | — | missing | — |
| 5 | abvi-admin-service | spring-boot | api-service | — | code-first | missing | — |
| 6 | abvi-event-worker | python-worker | worker | — | no-api | missing | — |
| 7 | abvi-shared-schemas | schemas | contract | — | — | missing | — |

Legend for the `Policy` column:
- `api-first` — OpenAPI spec exists; /deliver will edit it before implementation.
- `code-first` — service has HTTP endpoints but no spec; architect inlines the endpoint contract, /deliver skips the spec-edit step.
- `no-api` — worker with no HTTP endpoints; /deliver skips the spec-edit step, contract comes from schema repos.
- `—` — not applicable (not a service).

Corrections? You can:
- Change type/role for any repo (e.g., "repo 3 is actually nestjs, role api-service")
- Change `spec_policy` (e.g., "repo 5 is api-first — spec is at specs/admin.yaml, I missed it")
- Exclude a repo (e.g., "exclude repo 4")
- Add a repo not in this list (e.g., "add /path/to/another-repo as spring-boot api-service")

Confirm to proceed to domain questions.
```

Wait for user confirmation. Apply any corrections.

**Update scratchpad**: write the confirmed repo list to the `## Discovered Repos` table in `scratchpad.md`. Set Phase A status to COMPLETED. Set Current Phase to "B1. Domain Questions".

---
