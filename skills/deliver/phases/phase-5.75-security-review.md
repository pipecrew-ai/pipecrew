### Phase 5.75: Security Code Review (conditional)

**Trigger logic** — this phase runs if ANY of these are true:
1. `--force-security-review` flag was passed (force on)
2. The feature description or architect output contains security-sensitive keywords:
   `login`, `password`, `token`, `2fa`, `permission`, `role`, `session`, `auth`,
   `payment`, `card`, `stripe`, `billing`, `ssn`, `personal`, `email`,
   `upload`, `file`, `form`, `input`, `webhook`,
   `database migration`, `schema change`, `cache`

**Skip if**: `--no-security` flag was passed (force off).

**If not triggered by keywords or flag**: ask once at the Phase 2 approval gate:
> "Does this feature touch security-sensitive areas? (y/n)"
- yes → run Phase 5.75
- no → skip

---

### Step 1: Dispatch security-consultant in code review mode

Dispatch against EACH worktree that has implementation changes (same repos as Phase 5.5 code review, plus infra if it was modified).

**Tool**: `Agent`
**subagent_type**: `security-consultant`
**description**: `"Security review — {repo-name} — {feature-slug}"`
**prompt**:

```
Mode: Code Review

Review the implementation diffs in the repo at {worktree_path} (branch: feature/{feature-slug}).

Get the diff:
  cd {worktree_path} && git diff {base}...feature/{feature-slug}

Feature: {feature_summary}

Scan for:
- Injection risks (SQL, command, path traversal, XSS, SSRF)
- Credential and secret leaks (hardcoded keys, secrets in logs)
- PII in logs (emails, names, phone numbers at INFO level)
- Auth implementation gaps (missing guards, wrong ownership checks)
- Insecure patterns (disabled CORS, verify=False, weak hashing)

Produce the security findings report in the Output Format from your system prompt.
```

Dispatch all repos in parallel (one Agent call per repo in a single message).

### Step 2: Present findings

Compile a summary:

```
## Security Review Results

| Repo | Critical | High | Medium | Low | Recommendation |
|------|----------|------|--------|-----|----------------|
| publisher-service | 1 | 0 | 2 | 1 | FIX FIRST |
| pms-frontend | 0 | 1 | 0 | 0 | PROCEED |

Total: {N} critical, {N} high findings.
```

**If any critical findings**: block the pipeline. Ask the user:
> "{N} critical security findings. These must be fixed before merge. Dispatch fix round? (yes / no / show details)"

**If high but no critical**: warn but allow proceeding:
> "{N} high-severity security findings. Recommend fixing before merge but not blocking."

### Step 3: Fix dispatch (if approved)

Re-dispatch the original implementer agents with the security fix list, same pattern as Phase 5.5 Step 3.

**Update scratchpad**: Set Phase 5.75 status to COMPLETED. Record findings count and fix round status.

---
