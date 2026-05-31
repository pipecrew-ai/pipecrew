# Transient-failure handling

Shared rules that every skill in the plugin applies when an `Agent` or `Bash` tool call fails for reasons that are not the request's fault and not a permanent outage. Retrying **once** under the right conditions is the difference between "pipeline dies halfway" and "pipeline finishes with a blip".

## The rules

When any `Agent` tool call returns one of the following:

| HTTP status / error code | Meaning | Action |
|---|---|---|
| `529` `overloaded_error` | Anthropic-side capacity pressure — **not** a quota issue, not request-specific | Wait **30 s**, retry once. A 30 s gap is enough for the pool to rebalance. |
| `503` `service_unavailable` | Temporary service outage / deploy | Wait **30 s**, retry once. Same handling as 529. |
| `429` `rate_limit_error` | **Your quota** was exceeded (RPM / TPM / ITPM / OTPM) | If response includes a `retry-after` header, wait that long; else wait **60 s**. Retry once. If the retry also returns 429, **halt the current phase** and report the quota dimension to the user — no point retrying a third time within the same window. |
| Any other 4xx (except 429) | Request is malformed or rejected by a hook | **Do not retry.** Surface the error to the user immediately. |
| Network / timeout | Transport-layer hiccup | Wait **15 s**, retry once. |

On retry success, log the retry in `checkpoints.jsonl` (see observability spec) and continue normally.

On retry failure, **continue with the rest of the batch** (do not block the whole phase on a single failed call), then report at the end which agents failed so the user can `/discover --resume` or `/deliver --resume` later to fill the gap.

## Event emission during retries

Every retry produces the following sequence in `checkpoints.jsonl` (see `rules/observability.md` for the full schema):

1. `agent_end` with `status: "failed"` and whatever usage was returned (often none).
2. `retry` with `retry_reason` = the HTTP status code or transport error string.
3. After waiting the required delay, re-dispatch the agent.
4. A fresh `agent_end` with `status: "ok"` on success, `status: "deferred"` if the retry also failed.

The reporter reads this sequence to compute retry counts and attribute the correct tokens to the successful attempt (first attempt's tokens, if any, are still counted — they're real spend).

## Parallel dispatch + transient failure

When multiple agents are dispatched in one assistant message (parallel):

- A single 529 in a parallel batch is expected under load.
- Do NOT stop the whole batch — retry ONLY the failed agent.
- Let the successful agents' results come back and process normally.
- If the retry of the failed agent also fails, mark it `deferred` and continue. The scratchpad records which agents deferred; the user resumes them later.

## When to halt the phase (not just a single agent)

Halt only on these conditions:

- **Second consecutive `429` on the same agent** after a full `retry-after` or 60 s wait. Your quota is genuinely exhausted.
- **Third `529` / `503`** within 10 minutes. Anthropic has a real incident.
- **Any 4xx other than 429** — malformed request or hook rejection. Not transient.

In all other cases, retry once per the table and continue.

## What NOT to do

- **Do not retry on non-4xx errors silently.** The user should see a `retry` event surfaced in the execution summary, not a silent re-run.
- **Do not retry more than once** per failure. If you burn the retry budget, defer and let `--resume` handle it.
- **Do not skip the wait** listed in the table. Retrying immediately after a 529 almost always fails again.
- **Do not retry `Write` or `Edit` tool failures as if they were transient.** Those are usually "file not read first" or permission errors — surface them.

## Skill-specific additions

Each skill may add extra handling on top of these rules, but may not soften them:

- **`/discover`** Phase C batch: retry counts toward the same batch, not a fresh batch. Deferred repos surface in the Phase D execution summary.
- **`/deliver`** Phase 5 parallel dispatch: deferred agents block the pipeline from advancing to Phase 5.5 until the user either resumes or approves continuing without them.
