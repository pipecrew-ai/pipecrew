---
name: explain
description: "Explain anything about a workspace — a domain concept, entity, user flow, service, repo, or piece of code — grounded in the curated PipeCrew context (platform docs, ADRs, repo AGENTS.md / agent-context) and the source when needed. Two perspectives: product (what / who / why, plain language) and technical (how, architect depth, cross-repo, file:line). Quick by default (code only where the docs fall short); --deep verifies every claim in code. Caveman-dense sections with a concrete example and inline citations. Answers are cached: a repeat question returns instantly while the files it was built from are unchanged, and is refreshed from only the changed files when they're not; --fresh forces a rerun. Context gaps get a ready-to-run /learn hand-off. READ-ONLY — dispatches the `explainer` agent, whose tool list has no write or shell access."
---

# /explain

Ask a question, get an answer grounded in what PipeCrew already knows about your platform. It dispatches the read-only `explainer` agent at one of **two perspectives**:

- **Product** (`--product`) — *what it is, why it matters (value, revenue, key customers), who uses and owns it, how it differs from related offerings*. Business language from the workspace docs only — no system, file, or framework names, and no source code read. A "how" question gets the business journey, plus a pointer to `--technical` for the mechanism. For PMs, newcomers, stakeholders.
- **Technical** (`--technical`) — *how it works*. Which repos/services are involved, how they connect, the data and status lifecycle, the decisions behind it, and `file:line` references. For engineers and architects.

The agent reads the cheapest, most curated context first (platform docs → topology / decisions / ADRs → repo `AGENTS.md` + `agent-context/` → source) and stops when it has enough. By default it opens source code only where the docs fall short; `--deep` verifies every load-bearing claim in code instead. Answers come as caveman-dense labeled sections — What, Trigger, Flow, External deps, Output (with a concrete example), Config / deploy, Errors, Hazards — with inline citations.

**Answers are cached.** Each answer records a fingerprint of every file it was built from — context docs and code. Ask again and, if none of those files changed, you get the saved answer instantly; if some changed, the agent refreshes only the affected lines from only the changed files. Time alone never invalidates an answer; changed sources do (plus a 7-day safety ceiling). `--fresh` always reruns.

When the curated context can't answer — or the code contradicts it — that's reported as a **context gap**, and the skill offers to hand it to `/learn` so the next answer doesn't have to dig.

This skill only **explains**. It does not diagnose incidents (`/troubleshoot`), change code (`/deliver`, `/patch`), refresh context (`/context-refresh`), or draw full diagrams (`/draw-diagram`).

## Usage

```
/explain <question>
/explain --product <question>
/explain --technical <question> [--deep] [--repo=<name>]
/explain <question> [--fresh] [--workspace=<slug>]
```

### Flags

| Flag | Effect |
|------|--------|
| `--product` | Product perspective — what / why it matters / who, in business language; reads workspace docs only. |
| `--technical` | Technical perspective — how, architect depth, cross-repo, `file:line`. |
| `--deep` | Verify every load-bearing claim in source code. Slower and costlier (often 2–3× the tokens), but surfaces doc-vs-code drift and earns `high` confidence. Default is quick: answer from the curated docs and open code only where they fall short. |
| `--fresh` | Ignore the cache: rerun from scratch and replace the saved answer (the previous version is kept in history). Also triggered by "refresh", "redo", or "ignore the cache" in the question. |
| `--repo=<name>` | Narrow the answer to one repo (a `config.json` repo key). The agent still notes cross-repo hops but doesn't trace them. |
| `--workspace=<slug>` | Target a specific onboarded workspace. Required when more than one exists (otherwise the skill asks). |

### Examples

```
/explain what is a contract and who owns it?
/explain --product how does a publisher go live?
/explain --technical how does a contract change reach the billing service?
/explain --technical what happens when a payment-status event arrives? --repo=billing-service
/explain --technical --deep how does the upload listener work end-to-end?
/explain --fresh how does the upload listener work end-to-end?
```

## Instructions

### Step 1: Resolve the source mode — workspace or repo-only

Resolve the workspace from the registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json` (add `--workspace=<slug>` if passed). It applies the same session-scoped precedence every skill uses (`--workspace` → `$PIPECREW_WORKSPACE` → current directory → default → the only registered one).

- **Exit 0** → `{slug, path, root}`; set `{slug}` = `.slug` and `{workspace_root}` = `.root`. Verify `{workspace_root}/{slug}/config.json` and `context/platform.md` exist; if not, report and stop. If the current directory is a git repo whose top level is **not** one of the config's `repos[*].path` (the workspace was picked by default, not by location), ask once: `Explain using workspace {slug}, or just this repo ({repo-name})? (w / r)` — `r` switches to repo-only mode.
- **Exit 3 with several candidates** → list the slugs and ask which one.
- **Exit 3 with none registered** → **repo-only mode** if the current directory is a git repo (`git rev-parse --show-toplevel` → `{repo_path}`). Tell the user once: `No onboarded workspace — answering from this repo only (no cross-repo map). Run /discover for platform-wide answers.` If the current directory isn't a git repo, stop and point at `/discover`.

`--repo=<name>` must match a `config.json` repo key in workspace mode; if it doesn't, list the valid keys and stop. In repo-only mode it is ignored.

Set the cache directory:
- workspace mode → `{cache_dir}` = `{workspace_root}/{slug}/runs/explain/cache` (local only — `/memory-sync` never publishes `runs/`)
- repo-only mode → `{cache_dir}` = `{dirname of node {plugin_dir}/scripts/workspace-root.js --config-path}/explain-cache/{repo-name}` (never inside the repo)

### Step 2: Resolve the perspective

| Situation | Perspective |
|-----------|-------------|
| `--product` or `--technical` passed | that one |
| Question is about **meaning, users, ownership, business purpose, what the user sees** ("what is…", "who uses…", "why do customers…") | `product` |
| Question is about **mechanism, services, APIs, events, data, code, architecture decisions** ("how does… work", "what calls…", "where is…", "why is it built…") | `technical` |
| Genuinely unclear | **ask once (below)** |

```
I can explain this two ways:

  [p]roduct   — what it is, who uses it, why it matters (plain language)
  [t]echnical — how it works across services and code (architect depth)

(p / t)
```

Ask at most this one question to disambiguate perspective.

**Route away before dispatching** when the question isn't an explanation:
- It describes a live malfunction ("X is failing", "why does Y return 500 today") → suggest `/troubleshoot <symptom>` and ask whether to explain how X is *meant* to work instead.
- It asks for a change ("add…", "make X do Y") → suggest `/deliver` or `/patch`; offer to explain the current behavior first.

### Step 3: Check the cache

Strip any refresh wording ("refresh", "redo", "ignore the cache") from the question and treat it as `--fresh`. Then:

```bash
node {plugin_dir}/scripts/explain-cache.js lookup --cache-dir={cache_dir} \
  --question="{question}" --perspective={perspective} --depth={deep|quick} \
  [--repo={repo}] [--fresh]
```

In every `explain-cache.js` call, `{question}` is the question with `"`, `$`, `` ` `` and `\` removed (the cache ignores punctuation anyway), and the command stays exactly this shape — no `&&`, pipes, or redirects. In Claude Code, PipeCrew's hook then approves these calls without a prompt; anything else falls back to the normal prompt.

Act on `.decision`:

| Decision | Do |
|----------|----|
| `skip` | Read `.answer_file` and present it (Step 5) with status `cached · {updated_at, local time} · sources unchanged · --fresh to rerun`. If `.new_commits` is non-empty, add one line per repo: `{repo-name} has {count} new commits since this answer — --fresh to recheck`. **No agent dispatch.** |
| `fast` | Dispatch in update mode (Step 4) with `.answer_file` and `.changed_files`. Status: `updated · {now} · {n} sources changed ({basenames})`. |
| `full` | Dispatch normally (Step 4). Status: `fresh · {now}` (append `· {reason}` when the reason is age, depth, or --fresh). |
| `confirm` | Similar questions were answered before. Compare `.candidates[].question` with the user's question yourself: if one clearly asks the same thing (same subject, same aspect — "how X works" ≠ "how X fails"), rerun `lookup` with `--key={that key}` and act on the new decision. If unsure, ask once: `Answered something similar {age} ago: "{candidate question}". Reuse it? (y / n)`. If none match, treat as `full`. |

### Step 4: Dispatch the explainer

**subagent_type**: `pipecrew:explainer`
**description**: `"Explain — {perspective} — {question, truncated to ~40 chars}"`

**Workspace-mode prompt:**

```
PERSPECTIVE: {product | technical}
DEPTH: {deep if --deep, else quick}

Answer this question about the {workspace.name} platform, following your
tiered context loading and output format. Read-only. Cite every claim.
End with the EXPLAIN_SOURCES block listing every file you read.

question: {the user's question, verbatim}
workspace_root: {workspace_root}
slug: {slug}
config.json: {workspace_root}/{slug}/config.json
context dir: {workspace_root}/{slug}/context
repo: {--repo value, or "any"}
```

**Repo-only-mode prompt:**

```
PERSPECTIVE: {product | technical}
DEPTH: {deep if --deep, else quick}

Answer this question about the repo below, in repo-only mode (no onboarded
workspace — no cross-repo map). Follow your tiered context loading and output
format. Read-only. Cite every claim. End with the EXPLAIN_SOURCES block
listing every file you read.

question: {the user's question, verbatim}
repo_path: {repo_path}
```

**Update mode** (cache decision `fast`) — the same prompt for the active mode, with these lines inserted after `DEPTH:`:

```
UPDATE: refresh a cached answer — read the previous answer and only the changed files
previous_answer: {answer_file}
changed_files: {changed_files as a JSON array}
```

If the agent comes back with a clarifying question, relay it to the user and pass the answer back with **SendMessage to continue the SAME agent** — do not spawn a new one.

### Step 5: Store, present, hand off gaps

1. **Store** (after a `fast` or `full` dispatch): pipe the agent's full answer to the script on stdin — one shell call, no temp file, no file-write prompt:

   ```bash
   node {plugin_dir}/scripts/explain-cache.js store --cache-dir={cache_dir} \
     --question="{question}" --perspective={perspective} --depth={deep|quick} \
     --answer-file=- [--repo={repo}] [--key={confirmed key}] <<'PIPECREW_EXPLAIN_EOF'
   {the agent's full answer, verbatim}
   PIPECREW_EXPLAIN_EOF
   ```

   Pass `--key` when the answer refreshed a confirmed similar entry, so it's updated in place instead of duplicated. If the result says `stored: false` (the agent omitted the sources block), present the answer anyway and note `not cached — answer listed no sources`. If the user declines the store call, present the answer anyway and note `not cached`; in Cursor (no PipeCrew hooks yet) add once: `To skip this prompt, approve explain-cache.js runs in Settings › Agents › Approvals & Execution.`

2. **Present**: the status line first, then the answer **without** the `EXPLAIN_SOURCES` block (it's for the cache, not the reader).

3. **Gaps**:
   - **Unverified gaps only** (a quick-depth answer whose gaps are all "not verified") → suggest re-running with `--deep` instead of `/learn` — there's nothing confirmed to teach yet.
   - **Confirmed context gaps** (missing or code-contradicted docs, workspace mode) → offer the hand-off for those gaps only:

     ```
     The curated context couldn't fully answer this. To teach the crew:

       /learn "{one-paragraph summary of the gaps, naming the doc each belongs in}" --workspace={slug}

     Run it now? (y / n)
     ```

     On `y`, invoke `/learn` with exactly that free-form text — `/learn` does its own tier-classification and per-finding approval, so nothing is written without the user's sign-off. Once `/learn` edits a doc the answer read, the next lookup sees the change and refreshes the answer. On `n`, stop. In repo-only mode, suggest `/discover` instead (there's no workspace context to update).
   - A `skip` (cached) answer repeats its gaps but doesn't re-offer `/learn` if nothing changed since it was offered.

Nothing else is written — the cache entry is the only write. Presenting the answer and naming the next step is where `/explain` ends.

## Edge cases

- **EC-1 — no question given** → ask once: `What do you want explained? A concept, a flow, a service, or a piece of code.`
- **EC-2 — multiple onboarded workspaces** → the registry infers from the current directory / default; if still ambiguous, ask (Step 1).
- **EC-3 — no onboarded workspace** → repo-only mode, clearly labeled; the agent's Confidence line says `repo-only mode`. Cached outside the repo. No `/learn` hand-off.
- **EC-4 — ambiguous perspective** → the single `p / t` question (Step 2).
- **EC-5 — incident or change request** → route to `/troubleshoot` / `/deliver` / `/patch` before dispatching (Step 2).
- **EC-6 — context contradicts code** → the agent trusts the code, says so, and lists the stale doc under Context gaps, which feeds the `/learn` hand-off.
- **EC-7 — new code the cached answer never read** (e.g. a new handler) → can't be fingerprinted; the `new_commits` notice on a cached answer is the prompt to `--fresh`.
- **EC-8 — unreadable cache entry** → treated as no entry → `full` ("when in doubt, full").

## See also

- [`agents/explainer.md`](../../agents/explainer.md) — the read-only agent this skill dispatches (perspectives, depth, tiered context loading, output format, update mode)
- [`scripts/explain-cache.js`](../../scripts/explain-cache.js) — the answer cache (fingerprints, skip / fast / full / confirm decision)
- [`skills/brainstorm/SKILL.md`](../brainstorm/SKILL.md) — same workspace + perspective resolution, for *what to build* instead of *how it works*
- [`skills/learn/SKILL.md`](../learn/SKILL.md) — where context gaps go to become durable docs
- [`skills/troubleshoot/SKILL.md`](../troubleshoot/SKILL.md) — read-only incident triage (symptom → root cause)
- [`scripts/workspace-registry.js`](../../scripts/workspace-registry.js) — the shared workspace resolver used in Step 1
