### Phase 8: PR Publish + Run Wrap-up

Phase 8 always runs. Within it, **Steps 8.1–8.5 (PR publish)** are conditional on `--with-pr`; **Step 8.6 (feedback offering)** always runs. Phase 8 is the final phase — `run_end` is emitted at its end, not in Phase 7.

---

#### Step 8.1: Decide whether to publish

Skip Steps 8.2–8.5 (jump straight to 8.6) if any of these hold:
- `--with-pr` was NOT passed (publish is opt-in).
- Phase 6 returned blockers AND `--publish-despite-blockers` was NOT passed. Tell the user:
  ```
  ⚠ Phase 6 (assessment) flagged {N} blockers — PR publish skipped.
  Resolve the blockers (see {run_dir}/outputs/phase-6-assess.md), then
  re-run with: /deliver --resume --workspace={slug} --with-pr --publish-despite-blockers
  (only if you've reviewed and accept the assessor's flags)
  ```
- Any Phase 5 task is BLOCKED / FAILED in the scratchpad. The implementation isn't complete; refuse to publish.

If skipped, log to scratchpad: `Phase 8 PR publish: skipped ({reason})`. Continue to Step 8.6.

---

#### Step 8.2: Pre-publish confirmation gate

Compose the per-repo summary from the scratchpad's Implementation Tasks table:

```
Phase 8 — PR Publish
====================
Run:           {run_id}
Workspace:     {slug}
Phase 6:       {PASSED | NOT_RUN | BLOCKERS_OVERRIDDEN}

Repos to publish ({N}):
  - {repo1}/branch-{feature-slug}: {N} files changed, +{N} / -{N}
  - {repo2}/branch-{feature-slug}: {N} files changed, +{N} / -{N}
  - ...

Will:
  1. Push each branch to its remote (git push -u origin <branch>)
  2. Open ONE draft PR per repo via `gh pr create --draft`
  3. After all PRs created, run a second pass to inject sibling PR URLs
     into each PR body's "Related PRs" section
  4. Append "## Pull Requests" section to {run_dir}/report.md

PRs are DRAFT by default — reviewers will not be auto-pinged.

Proceed? (yes / no / yes-with-feedback)
  yes               → publish PRs, then offer feedback at Step 8.6
  yes-with-feedback → publish PRs, then automatically run /learn --run={run_id}
  no                → skip publish; still offer feedback at Step 8.6
```

Capture the user's choice. If `no`, jump to Step 8.6.

**Hard guardrails before any push**:
- For each repo, run `git status --short` — if there are uncommitted changes in the worktree, refuse to publish that repo and surface the path. The user must commit or stash first.
- Verify no branch is `main` / `master` / `dev` (whatever the workspace's protected branches are per `config.json`). If a feature branch happens to be named one of those, refuse and abort.

---

#### Step 8.3: Push branches + open draft PRs (parallel)

Per repo (max 5 concurrent):

1. **Push the branch**:
   ```bash
   cd {repo_worktree_path}
   git push -u origin <branch-name>
   ```
   Never `git push --force`. If the remote branch diverged, fail this repo with a clear message: `"branch diverged on origin — please rebase locally and re-run /deliver --resume --with-pr"`. Continue with other repos.

2. **Compose the PR body** (template at the bottom of this file). Source artifacts:
   - Feature summary + FR/EC: `{run_dir}/outputs/phase-1-requirements.md`
   - Spec diff (this repo's spec only): `{run_dir}/outputs/phase-3-diffs.md` filtered to this service
   - Implementation summary: scratchpad Implementation Tasks row for this repo
   - Test results: from the task file's Work Log
   - Cross-repo assessment excerpt: `{run_dir}/outputs/phase-6-assess.md` filtered to this repo (omit if Phase 6 was skipped)
   - Related PRs: leave the section empty for now — Step 8.4 fills it.

3. **Sanitize the body** before posting. Reject and redact:
   - AWS access keys: `AKIA[0-9A-Z]{16}` → replace with `[REDACTED-AWS-KEY]`
   - GitHub PATs: `ghp_[A-Za-z0-9]{36,}` → replace with `[REDACTED-GITHUB-PAT]`
   - Generic JWT-shaped tokens: `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}` → replace with `[REDACTED-JWT]`
   - Slack webhook URLs: `https://hooks.slack.com/services/[A-Z0-9/]+` → replace with `[REDACTED-WEBHOOK]`
   - Any path under the user's home dir: `~/` or `/Users/.+` or `/home/.+` or `C:/Users/.+` → replace with `<user-home>/...`
   - 12-digit numbers near the word "account" (case-insensitive) → replace with `<account-id>`
   - If any redaction fired, note it in scratchpad: `PR body sanitized for {repo}: N redactions applied`.

4. **Respect repo PR template** (if present): if `{repo_path}/.github/PULL_REQUEST_TEMPLATE.md` exists, merge the generated body into the template (preserve template sections, populate template placeholders where matched, append our sections that the template doesn't cover). Do not replace the template wholesale.

5. **Open the draft PR**:
   ```bash
   gh pr create \
     --draft \
     --title "feat({repo-short}): {feature-name}" \
     --body-file <(cat {tmp_body_file}) \
     --base {target_branch}
   ```
   `{target_branch}` from workspace config (`publish.target_branch`, defaults to `dev` if set, otherwise `main`). `{repo-short}` is the repo's short tag from `config.json` (e.g. `publisher`, `pms-fe`).

6. **Capture the PR URL** from `gh pr create` stdout. Record `(repo-name → pr-url, pr-number)` in scratchpad.

**`gh` CLI not installed or unauthenticated**: Don't half-publish. Halt Step 8.3, print the exact `gh pr create` commands the user can copy-paste, plus the body content for each repo, and continue to Step 8.6 (feedback). Note in scratchpad: `Phase 8 PR publish: gh-cli-unavailable, manual steps printed`.

**Per-repo failure** (e.g., gh API error, branch not pushable): log the error against that repo, continue with the rest. Don't abort the whole phase for a single failure.

---

#### Step 8.4: Cross-repo linking pass

After all PRs are created, edit each PR's body to inject the "Related PRs" section with sibling URLs:

For each repo's PR:
```bash
gh pr edit {pr-number} --body-file <(cat {updated_body_file})
```

The updated body has the same content as Step 8.3 plus a populated section:

```markdown
## Related PRs
- {sibling-repo-1}: {url}
- {sibling-repo-2}: {url}
- ...
```

If a single repo was published (no siblings), skip Step 8.4 — there's nothing to link.

---

#### Step 8.5: Append PR URLs to report.md + write structured JSON

**Step 8.5a — Append markdown table to report.md** for human-readable rendering:

```markdown

---

## Pull Requests

| Repo | PR | Branch | Status |
|------|-----|--------|--------|
| {repo1} | [#{N}]({url}) | `feature/{slug}` | DRAFT |
| {repo2} | [#{N}]({url}) | `feature/{slug}` | DRAFT |
| ... |

Created via `/deliver --with-pr` on {timestamp}. Cross-repo linking applied.
```

If any repo failed Step 8.3, list it under a separate `### Failed publishes` subsection with the error.

**Step 8.5b — Write `{run_dir}/pr_urls.json`** with the same data in machine-readable form. Tools (e.g., site-view, downstream automation) read this instead of regex-parsing the markdown table — the table format may evolve, the JSON contract should not.

```json
{
  "created_at": "2026-04-25T10:30:00Z",
  "run_id": "{run_id}",
  "feature_slug": "{feature-slug}",
  "publish_command": "/deliver --with-pr",
  "prs": [
    {
      "repo": "publisher-service",
      "branch": "feature/bulk-upload",
      "pr_number": 142,
      "url": "https://github.com/.../pull/142",
      "status": "draft",
      "target_branch": "dev"
    }
  ],
  "failed": [
    {
      "repo": "auth-service",
      "branch": "feature/bulk-upload",
      "error": "branch diverged on origin"
    }
  ]
}
```

Both files MUST be written even if some repos failed. The JSON file's `failed[]` array is the canonical source of failures; consumers may surface a banner if it's non-empty.

---

#### Step 8.6: Feedback offering (always runs)

**First, read `{run_dir}/run-notes.md`** if it exists. It holds the durable observations the product-owner / solution-architect flagged during this run (appended by the `## Notes for /learn` capture rule in `dispatch-rules.md`). If it has any bullets, include them verbatim in the offering below under a `Pending learning notes from this run:` header — the agents already surfaced candidate learnings, so lean the recommendation toward `yes`. An empty or absent file just means nothing was flagged — show the normal offering. Either way, `/learn --run={run_id}` reads this file as part of the run signal, so a `yes` curates these notes (plus the run's corrections) into the workspace docs.

Show the wrap-up summary. Two variants depending on whether Steps 8.2–8.5 ran:

**If PRs were published**:

```
[phase 8 ✔] {N} draft PRs raised — feature ready for review

Pull Requests:
  - {repo1}: {url1}
  - {repo2}: {url2}
  - ...

📌 IMPORTANT — when reviewers comment on these PRs (or post-merge fix
   commits land), you can capture the feedback automatically:

     /learn --pr={url}

   The feedback skill scans review comments + post-plugin fix commits and
   proposes tier-classified updates to your workspace docs (platform.md,
   repo CLAUDE.md / agent-context). You approve each finding before
   anything is applied. Run it once per PR after meaningful review activity.

Want feedback captured into your workspace docs?

  yes   → run /learn --run={run_id} now — captures THIS pipeline run
          (corrections you made at gates, decisions you pushed back on,
          the notes the agents flagged this run)
  later → if you'll keep tweaking the code in this session, that's often the
          BETTER moment to learn: finish your fixes, then run
          /learn --branch=feature/{feature-slug}  (add --note="why" for intent
          a diff can't show). It diffs the whole branch against base, so it
          learns from your follow-up hand-edits too — not just what the
          pipeline produced. Or /learn --pr=<url> once the PR has review activity.
  no    → permanently skip for this run

Choice?
```

**If PR publish was skipped or never requested**:

```
[phase 8 ✔] Run wrap-up — PR publish skipped ({reason: --with-pr not passed | blockers | user declined})

📌 You can publish PRs later with:
     /deliver --resume --workspace={slug} --with-pr

Want feedback captured into your workspace docs?

  yes   → run /learn --run={run_id} now — captures THIS pipeline run
          (corrections at gates, decisions you pushed back on, agent notes)
  later → if you'll keep tweaking the code in this session, that's often the
          BETTER moment to learn: finish your fixes, then run
          /learn --branch=feature/{feature-slug}  (add --note="why" for intent
          a diff can't show). It diffs the whole branch against base, so it
          learns from your follow-up hand-edits too — not just the pipeline output.
  no    → permanently skip for this run

Choice?
```

**Handle the user's choice**:

- **`yes`** (or `yes-with-feedback` was selected at Step 8.2): before invoking the feedback skill, prompt for an optional free-form note:

  ```
  Anything specific to capture? (free-form text — your observations,
  decisions you pushed back on, patterns the agents kept getting wrong, …)
  Press Enter to skip and let the analyzer work from the run alone.

  >
  ```

  - If the user types text: invoke `Skill` with skill="pipecrew:learn" and args=`--run={run_id} --workspace={slug} --note="{user-text-escaped}"`. The note is added as an extra signal alongside the structured run analysis (scratchpad, corrections, phase outputs) — the feedback-learner sees both.
  - If the user hits Enter (empty): invoke `Skill` with skill="pipecrew:learn" and args=`--run={run_id} --workspace={slug}` — analyze the run only, no extra annotation.

  **Before invoking the Skill**, append a feedback-learner row to this run's `## Agent Dispatch Log` table in `{run_dir}/scratchpad.md` so the site-view's `loop` character flips queued → working immediately:

  ```
  | {next_n} | 8 | feedback-learner | — | — | — | in_progress |
  ```

  `/learn` will update this same row to `success — N findings (...)` when it finishes (see `/learn` Step "Finalize: update parent /deliver dispatch log"). When that row hits `success`, the site-view promotes Loop to `done` and closes the pyramid.

  The feedback skill takes over the conversation.

- **`later`**: log to scratchpad `Feedback offered: deferred`. Move to Step 8.7.
- **`no`**: log to scratchpad `Feedback offered: declined`. Move to Step 8.7.

**No pestering.** If the user picks `later` or `no`, do not re-prompt. The skill is always available for explicit invocation.

**Note shape**. The user's free-form text is treated as a signal source by the feedback-learner — not a directive. The learner still runs the same tier-classification + evidence-quoting process; the user's note becomes additional context the learner considers when partitioning observations. The user does NOT bypass the per-finding approval UX by writing a note.

---

#### Step 8.65: Sync workspace memory to GitHub (only if `config.workspace.memory.enabled` AND this run changed workspace-level context)

If the workspace opted into GitHub-backed memory and this `/deliver` run wrote any **workspace-level** durable doc under `{workspace_root}/{slug}/context/` — most commonly a new ADR from the Phase 2 ADR gate (`context/adrs/`), or an audit-findings update — persist it:

```bash
node {plugin_dir}/scripts/sync-memory.js {workspace_root}/{slug} --message "deliver: {feature-slug} (context updates)" --checkpoint=deliver
```

Skip when `memory.enabled` is absent/false, or when this run touched no `context/` doc (a pure code-change feature with no ADR). The script rebases onto the team's latest then publishes per `config.workspace.memory.sync_mode` — note a **new ADR is structural**, so under `hybrid`/`pr` this sync opens a `memory/*` PR (the durable decision gets a reviewer) rather than committing to `main`; an audit-findings-only update commits directly. **Do not double-sync:** if Step 8.6 dispatched `/learn` and it already synced (its Step 7.4), and no further `context/` change happened after, this is a no-op — `sync-memory.js` commits nothing when the tree is clean, so it's safe to call regardless. Feature *code* changes live in the code repos' own git (Steps 8.1–8.5), not the memory repo. See `docs/design/github-memory.md`.

#### Step 8.7: Final run_end emission + status

Emit the final `run_end` event to `{run_dir}/checkpoints.jsonl`:

```jsonc
{
  "ts": "2026-04-15T17:42:10Z",
  "event": "run_end",
  "skill": "deliver",
  "run_id": "2026-04-15-142744-book-upload",
  "status": "completed",
  "duration_ms": 10766000,
  "phase_8": {
    "prs_published": {N},
    "feedback_choice": "yes" | "later" | "no" | "yes-with-feedback"
  }
}
```

Set scratchpad Status to COMPLETED. Phase 8 is done.

**If `--auto-approve` was on for this run**, turn the marker off now so no later session inherits it:
```bash
node {plugin_dir}/scripts/autoapprove-marker.js off
```
(Harmless if it was never on — the helper is a no-op when the marker is absent. The marker also self-expires ~6h after the run goes idle, but turning it off here is the clean path.)

---

### PR body template

The orchestrator composes this per repo by filtering the source artifacts. Sections are static; bullets come from the artifacts.

```markdown
## Summary
{feature_summary from phase-1-requirements.md, one paragraph}

## Requirements addressed
{FR/EC list extracted from phase-1-requirements.md, scoped to what this repo enforces}

## Spec changes (this repo)
{phase-3-diffs.md section for this service's spec file}

## Implementation
{from scratchpad Implementation Tasks row for this repo: files modified, key changes}

## Test results
{from this repo's task file Work Log: tests added/modified, all passing summary}

## Cross-repo assessment
{phase-6-assess.md excerpt scoped to this repo — wire-shape verdict, gating verdict}
{omit this section entirely if Phase 6 was skipped}

## Related PRs
{populated by Step 8.4 — left empty during initial Step 8.3 create}

---

🤖 Generated via PipeCrew /deliver pipeline
Run: {run_id} | Workspace: {slug}
```

---

### INTERRUPTION HANDLING

- **User cancels at Step 8.2 gate** → log "user declined PR publish at gate", continue to Step 8.6 (feedback still offered).
- **`gh` CLI unavailable** → halt Step 8.3, print copy-pasteable commands, continue to Step 8.6.
- **Single-repo PR creation fails** → log against that repo, continue others, surface in Step 8.5 report append + Step 8.6 summary.
- **Cross-repo linking pass fails on one PR** → log, continue. The PR exists; linking is best-effort.
- **report.md missing or unwritable** → log warning, skip Step 8.5 (PR URLs still in scratchpad + Step 8.6 summary). Don't abort.

---

### FLAGS

| Flag | Effect |
|------|--------|
| `--with-pr` | Triggers Steps 8.1–8.5 (PR publish). Without it, only Step 8.6 (feedback offering) runs. |
| `--publish-despite-blockers` | Override Phase 6 blocker gate. Use only after manually reviewing the assessor's flags. |
| `--no-feedback-prompt` | Skip Step 8.6 entirely. Useful in CI where there's no user to answer. Default: prompt. |

---

### What this phase does NOT do

- Does not auto-merge PRs. Drafts are always drafts; reviewers convert them.
- Does not approve / request review. Reviewer assignment happens manually or via repo `CODEOWNERS`.
- Does not push to protected branches. `target_branch` defaults to `dev` if the workspace defines one; otherwise `main`. Either way, the PR opens AGAINST that branch — it does not push to it.
- Does not run `/learn --pr=<url>` automatically — feedback is always user-initiated.
