# Layer 4 — LLM-judge faithfulness eval (scaffold)

**Status**: not yet implemented. Decisions deferred until the first real need.

This directory is a placeholder so the structure is visible and the design conversation is captured. Layers 1–3 of the eval harness (under `eval/tests/`) cover **structural correctness** — templates parse, references resolve, scripts behave. They do not cover **task faithfulness**: does the pipeline, given a real feature brief, actually produce code that satisfies the spec?

That's what Layer 4 is for.

---

## What it would test

For a small fixed set of **golden cases**, each containing:

- An input feature brief (e.g., the kind of thing `/discover` would produce in Phase 1)
- An expected outcome description (which services should be touched, which FRs/ECs should be covered, what the implementer's `COVERAGE` block should at minimum include)

The harness would either:

1. **Run the relevant pipeline subset** (e.g., just dispatch the architect agent and inspect its `AFFECTED_SERVICES` block), or
2. **Use a frozen actual output** committed to `cases/{name}/actual.md` — re-judged whenever judge prompts or judge models change

A judge LLM scores the actual output against the expected criteria with a structured rubric. Pass/fail per case + reasoning.

---

## Why it's not built yet

Three decisions need to be made before this layer is useful, and none of them have an obvious answer today:

1. **Judge model.** Cheaper judge (e.g. Haiku) is fast and consistent on simple checks but biased on nuanced ones. Stronger judge (Opus) is expensive enough that running 50 cases takes real money. **Recommendation when wired**: use the same model throughout (whichever) so scores stay comparable run-to-run; rotating judges invalidates trend lines.
2. **Run-pipeline vs. frozen-output.** Running the pipeline catches regressions in the agents; freezing outputs catches regressions in the judge prompts and downstream consumers. Probably want both modes via a flag.
3. **Cost budget.** A single `/deliver` run can be 50K–500K tokens. Even 10 cases at the low end is $5–10/run. CI on every PR is not feasible; pre-release-only is. Need to decide cadence before wiring CI.

Until these are answered, building the runner is premature.

---

## Recommended layout when implementing

```
eval/llm-judge/
├── README.md              this file
├── run.js                 the runner
├── judge-prompt.md        the rubric template (one judge prompt per case type)
└── cases/
    └── {case-name}/
        ├── input.md       feature brief / requirements
        ├── expected.md    outcome criteria the judge scores against
        └── actual.md      (frozen mode only) the output to judge
```

### Runner contract

`run.js` should:

1. Discover `cases/*/`.
2. For each case: load `input.md`, `expected.md`, optionally `actual.md`.
3. If no `actual.md`: dispatch the relevant pipeline subset (specify in case manifest) and capture the output.
4. Send `(judge-prompt, expected, actual)` to the judge model.
5. Parse the judge's verdict (structured JSON: `{pass: bool, reasoning: string, criteria_met: [...], criteria_missed: [...]}`).
6. Aggregate. Exit 0 if every case passed, else non-zero.

Output should be human-readable per case + a CSV summary for tracking pass rates over time.

---

## What this layer is *not*

- **Not a quality benchmark vs. other tools.** It measures whether *this* pipeline does what *it* claims to do, not whether it's better than hand-coding.
- **Not a replacement for in-pipeline reviewers.** The `*-code-reviewer` agents catch issues per-feature during a run. Layer 4 catches regressions in the plugin itself across releases.
- **Not a substitute for human review of the cases.** The expected criteria are written by humans and need to be re-validated when the pipeline's behavior intentionally changes (new phase, new structured block, etc.).

---

## See also

- [`../README.md`](../README.md) — eval harness overview, layers 1–3
- [`../../context-engineering.md`](../../context-engineering.md) — why this layer matters; the principle it defends
