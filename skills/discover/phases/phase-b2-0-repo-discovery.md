## Phase B2.0: Per-repo Discovery (parallel, Sonnet)

Phase B2.0 runs BEFORE B2's architect dispatch. It walks each repo in parallel via the `repo-discoverer` agent (Sonnet) and emits a structured `REPO_PROFILE` JSON per repo. The architect (Opus) then consumes the JSON profiles in B2 to synthesize platform.md — drastically cutting the architect's token load (each profile is ~3 KB; the architect reads ~30 KB total instead of all repos' source code).

**Pre-step — create the output directory:**

```bash
mkdir -p {workspace_root}/{slug}/runs/discover/{run_id}/outputs/repo-profiles/
```

**Cache plan — decide reuse vs rescan per repo (Win #6, head_sha-keyed):**

Before dispatching any `repo-discoverer`, ask the cache which repos still match their last-scanned `HEAD` SHA + branch + REPO_PROFILE `schema_version`. Reused profiles are copied from the prior run's outputs into this run's outputs/repo-profiles/ — no Sonnet dispatch, no token spend.

```bash
node {plugin_dir}/scripts/discover-cache.js plan \
  {workspace_root}/{slug}/runs/discover/state.json \
  {plugin_dir}/templates/blocks/repo-profile.example.json \
  '[{"repo_key":"<key>","repo_path":"<abs path>"}, ...]'
```

The script outputs JSON like:

```json
{
  "schema_version_expected": 1,
  "decisions": [
    {"repo_key": "publisher-service", "action": "reuse", "profile_path": "/abs/.../prev-run/outputs/repo-profiles/publisher-service.json", "current_head": "7066b30", "current_branch": "main", "reason": "HEAD 7066b30 unchanged since 2026-05-30T..."},
    {"repo_key": "search-svc",       "action": "rescan", "current_head": "a1b2c3d", "current_branch": "main", "cached_head": "f4e5d6c", "reason": "HEAD moved (f4e5d6c → a1b2c3d)"},
    {"repo_key": "admin-portal",     "action": "rescan", "current_head": "abc1234", "current_branch": "main", "reason": "no cache entry"}
  ],
  "stats": {"reused": 1, "rescanned": 2}
}
```

For each `action: "reuse"` decision: copy the file into this run's outputs directory and emit a one-line log so the user sees what was skipped:

```bash
cp {decision.profile_path} {run_dir}/outputs/repo-profiles/{decision.repo_key}.json
```
```
↻ Reused cached profile for {repo_key} ({reason})
```

For each `action: "rescan"` decision: dispatch `repo-discoverer` as usual (the dispatch shape below). Skip the dispatch entirely for reused repos.

**Bypass options:**
- `--refresh-cache` flag was passed to `/discover` → treat every decision as `rescan` (use the script's output but ignore the `reuse` actions). The cache is still written afterwards as usual, so the next run benefits from the fresh profiles.
- The state file is missing or corrupt → the script returns every decision as `rescan` defensively (no error, no crash).
- A reused profile's file goes missing or fails JSON parse → the script detects it and returns `rescan` for that repo.

If `stats.reused === decisions.length` (the rare case of every repo being stable), skip the entire dispatch step and proceed straight to validate. The cache is now load-bearing for `/discover --resume` on unchanged workspaces — that path should be nearly free.

**Dispatch — one `Agent` tool call per repo (only for repos with `action: "rescan"`), all in a single orchestrator message** so they run concurrently. The dispatch shape per repo:

**Tool**: `Agent`
**subagent_type**: `repo-discoverer`
**description**: `"Profile — {repo.name} ({repo.type})"`
**prompt** (substitute per repo):

```
You are profiling ONE repo for the {workspace.name} workspace. Phase B2.0 of /discover.

INPUTS:
- repo_key:         {repo.name}
- repo_path:        {repo.path}
- repo_type:        {repo.type}
- repo_role:        {repo.role}
- spec_file:        {repo.spec_file or "(none)"}
- run_dir:          {run_dir}
- workspace_slug:   {slug}

Read your system prompt's process. Walk the repo, populate the REPO_PROFILE JSON
shape (see {plugin_dir}/templates/blocks/repo-profile.example.json), and write it to:

  {run_dir}/outputs/repo-profiles/{repo.name}.json

Schema reference: {plugin_dir}/templates/blocks/block-schemas.md § REPO_PROFILE.

Keep the file under ~3 KB. Sample representative endpoints/entities — don't enumerate exhaustively. Trust your role-specific guidance in the system prompt about which fields apply (frontend_signals for frontend repos, infra_signals for cdk/terraform repos, entities + endpoints for api-services + workers).
```

Per critical rule #13: parse each agent's `<usage>` block, append a Dispatch Log row with phase `B2.0`, agent `repo-discoverer`, tokens + duration. Capture each agent's status line for the phase-done emit.

**Wait for ALL profiles to land** before advancing to B2. If any agent fails:
- Apply the standard transient-failure retry policy (`rules/transient-failures.md`).
- If a repo's profile is still missing after retry, emit a `⚠ Deferred` line and proceed to B2 with the available profiles. The architect will note the missing profile and recommend `/discover --resume` to re-attempt.

**Validate the profiles (deterministic gate — runs BEFORE the B2 architect dispatch):**

```bash
node {plugin_dir}/scripts/validate-repo-profile.js {run_dir}/outputs/repo-profiles/
```

This is the cheap catch for a Sonnet writer that truncated its JSON, wrapped it in a markdown fence, or omitted a contract key (`integrations` sub-arrays, `specs`, role-non-applicable fields that must be `null`/`[]`). Exit 0 → every profile is well-formed; proceed to B2. Exit 1 → the validator names each bad file and the specific errors:

- Re-dispatch `repo-discoverer` for ONLY the failed repo(s) as a fix round, passing the validator's error list verbatim in the prompt so the agent knows exactly what to correct. Re-validate.
- If a profile still fails after one fix round, treat it like an unrecoverable miss: emit a `⚠ Deferred` line for that repo and proceed to B2 with the valid profiles (the architect notes the gap and recommends `/discover --resume`). Do NOT feed a malformed profile into the Opus synthesis pass — a broken `integrations` block silently corrupts the topology diagrams.

Do NOT advance to B2 until the validator returns 0 for every profile that did land.

**Cache commit — record this run's profiles for the next `/discover` to reuse:**

```bash
node {plugin_dir}/scripts/discover-cache.js commit \
  {workspace_root}/{slug}/runs/discover/state.json \
  {plugin_dir}/templates/blocks/repo-profile.example.json \
  '[{"repo_key":"<key>","repo_path":"<abs path>","profile_path":"<abs path to this run's profile>"}, ...]'
```

Pass ONE record per repo whose profile landed valid (both the freshly-scanned ones AND the reused-from-cache ones — recording the reused ones updates their `scanned_at` to today, and a reused profile may still be a fresh `profile_path` if you copied it into this run's outputs). Skip repos with a `⚠ Deferred` line. The script overwrites prior entries by `repo_key` and preserves entries for repos NOT in the records list (e.g., a repo that was removed from `config.repos` this run will still have its stale cache entry — harmless).

**Phase-done emit**:

```
[phase B2.0 ✔] {N} repo profiles ready ({R} reused from cache, {S} freshly scanned), {M} audit findings collected ({duration}, {Xk} tokens — Sonnet, parallel)
```

**Update scratchpad**: Set Phase B2.0 status to COMPLETED. Set Current Phase to "B2. Architect Synthesis". Include the cache stats (`reused / rescanned`) in the phase status row so resumed runs show their cache hit rate at a glance.
