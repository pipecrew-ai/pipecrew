# PipeCrew eval harness

A layered eval suite for the PipeCrew plugin. Catches regressions in the structural contracts (templates, script references, file formats) and — at the top layer — the actual quality of LLM output the pipeline produces.

This complements the `scripts/*.test.js` unit tests (which cover individual scripts in isolation) by adding **cross-cutting** and **pipeline-level** evals: things that span multiple files, multiple agents, or the full `/deliver` run.

See [`../context-engineering.md`](../context-engineering.md) for the principle this exists to defend.

---

## Run it

```bash
node eval/run.js              # all layers that can run without API keys
node eval/run.js --layer=1    # static checks only
node eval/run.js --layer=2    # script behavior only
```

Exit code is `0` if every test passed, non-zero otherwise. CI-friendly.

---

## Layers

| Layer | What it tests | LLM calls? | Cost | Speed |
|-------|--------------|-----------|------|-------|
| **1. Static** | Templates parse; cross-references resolve; format invariants hold | None | Free | Sub-second |
| **2. Script behavior** | `extract-block.js`, `validate-claude-md.js`, `validate-checkpoints.js` work correctly across happy + error paths | None | Free | Seconds |
| **3. Pipeline integration** | Phase scripts produce expected artifacts when given fixed inputs | None (uses frozen fixtures) | Free | Seconds |
| **4. LLM-judge faithfulness** | Given a fixed feature brief, does the pipeline output satisfy the spec? | **Yes** | $$ | Minutes per case |

Layers 1 and 2 run by default and on every contributor's machine. Layer 3 is scaffolded with one example and meant to grow as new structural contracts ship. **Layer 4 is documented in `llm-judge/README.md` but not run by default** — it requires an API key, a judge-model choice, and a deliberate cost budget.

---

## Layout

```
eval/
├── README.md                      this file
├── run.js                         layer-aware aggregating runner
├── tests/                         one *.js file per cross-cutting eval
│   ├── 01-templates-parse.js      (Layer 1) all templates/blocks/*.example.json parse
│   ├── 02-script-refs-resolve.js  (Layer 1) {plugin_dir}/scripts/X.js refs point to real files
│   ├── 03-template-refs-resolve.js (Layer 1) templates/blocks/X.example.json refs are real
│   └── 04-co-located-tests.js     (Layer 2) aggregates scripts/*.test.js
└── llm-judge/                     Layer 4 scaffold (not yet wired)
    └── README.md                  what it would do, how to add cases when ready
```

---

## Add a new test

Pick the layer it belongs to:

- **Layer 1** if it's a static structural check (no script execution, no fixtures beyond literals): drop a `NN-name.js` file in `tests/` whose top has a `LAYER = 1` constant. The runner reads it.
- **Layer 2** if it exercises a script's behavior with synthesized fixtures: prefer co-locating with the script as `scripts/X.test.js` (matches existing convention). The runner aggregates these via `04-co-located-tests.js`.
- **Layer 3** if it produces or validates a pipeline artifact: drop in `tests/`, set `LAYER = 3`, document the fixture provenance in a comment.
- **Layer 4** if it requires a judge LLM call: add to `llm-judge/cases/` once that layer is built.

### Test file contract

Every file under `tests/` must:

1. Be a standalone Node script (zero deps; consistent with `scripts/`).
2. Declare its layer at the top: `const LAYER = 1;` (the runner uses this for `--layer=N` filtering).
3. Print one line per check: `  ok  {description}` or `  FAIL {description}\n       {detail}`.
4. End with a summary line: `\n{N} passed, {M} failed`.
5. Exit `0` on all-pass, non-zero on any failure.

(Same protocol as `scripts/*.test.js` — copy one of those if in doubt.)

---

## What this *isn't*

- **Not a benchmark suite.** No timing assertions, no token-cost budgets enforced. Those belong in CI dashboards, not in the eval gate.
- **Not a replacement for human review.** A green eval run means the structural contracts hold; it does not mean the pipeline produced *good* code. Layer 4 is the closest we can get to that automatically, and even then it's a sanity check, not a verdict.
- **Not a substitute for the in-pipeline reviewer agents.** The `/deliver` run already has `*-code-reviewer` agents that flag issues per-feature. This eval guards the **plugin itself** — does the plugin still work as designed?

---

## Why no test framework?

Same reason `scripts/` has no `package.json`: this plugin runs anywhere Node is installed, with zero install step. A test framework would force `npm install` on contributors and CI. The 4-line `test()` / `assert()` pattern is enough for what we need; if a test starts wanting fixtures, snapshots, or parallelism, that's a signal to extract a helper into `eval/lib/`, not to take on a dependency.
