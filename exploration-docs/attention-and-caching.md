# Attention and caching in PipeCrew

**Date**: 2026-04-26
**Companions**: [`context-engineering.md`](./context-engineering.md) (the broader signal-vs-noise principle), [`karpathy-assessment-v3.md`](./karpathy-assessment-v3.md) (the trim pass that started here), [`extractor-enhancement.md`](./extractor-enhancement.md) (a precision-via-extraction win that compounds with attention quality).

---

## The bottom line

**Goal: the model does not forget any instruction.** Attention quality is the primary design constraint for PipeCrew prompts. Prefix caching is a useful side effect that may or may not fall out — it is never the goal.

This framing matters because the two optimizations sometimes pull in opposite directions. When they conflict, **attention wins**. The cost of a forgotten instruction (broken pipeline, missed requirement, blocked gate) is far higher than the cost of a cache miss (a few cents and a few hundred milliseconds).

---

## Why attention dominates

### The U-shape of attention (primacy + recency)

Models attend most strongly to the **start** and **end** of context, weakest to the **middle**. Replicated across every modern LLM. This is the single biggest design constraint when you're worried about forgotten instructions.

The implication: **critical instructions belong at the top *and* the bottom of a prompt.** Not one or the other — both. Putting a "MUST" rule once at position 2K of a 20K-token prompt is the worst possible placement.

### Length is the enemy of attention

Every token added to context dilutes the attention budget every other token competes for. A critical rule in a 5K-token prompt gets more attention than the same rule in a 50K-token prompt, regardless of position. **Trimming is more powerful than repositioning.**

### Restatement is cheap insurance

Telling the model the same thing twice — once in framing at the top, once as a reminder at the bottom — costs 50–200 tokens and dramatically increases the chance the rule actually fires during execution. Models don't tire of repetition; they reward it.

### Concrete anchors beat abstract references

`templates/blocks/affected-services.example.json` is an attention anchor. "the documented schema" is not. Specific paths, IDs, file names give the model a token sequence it can latch onto; vague references force it to maintain context across the whole prompt to figure out what they mean.

### System prompt vs. user message are different attention tiers

Models treat system prompts as authoritative background; user messages as the active task. Putting the active ask deep in the system prompt buries it; putting framing in the user message dilutes the task. **Stable rules → agent system prompt; per-call task → dispatch user message.** Mixing the tiers is an attention bug.

### Structure aids navigation

Headers, numbered lists, tables, code fences create visual anchors the model uses to "find" content. Walls of prose force linear scanning. For long prompts, structure isn't cosmetic — it's a navigation aid attention actually uses.

---

## What prefix caching is, briefly (and why it falls out of good attention design)

Prefix caching persists the model's internal state (KV pairs) computed for the start of a prompt, so subsequent requests with the same byte-prefix can skip prefilling those tokens. The cache key is **byte-exact from position 0** — any difference at any earlier position invalidates everything after it.

The relevant TTLs:
- Anthropic ephemeral (default): **5 minutes** of inactivity, resets on every hit
- Anthropic extended: **1 hour**, costs 2× normal input on writes
- TTL resets on use — dense agent loops keep caches warm indefinitely

**Why it lines up with attention design:** the cache-friendly rule ("stable content first, dynamic content last") happens to put the active task at the end — exactly where attention is strongest (the recency half of the U-shape). So *most* of what makes a prompt cache-friendly also makes it attention-friendly.

**Where they diverge:** restating critical rules at the end of a dispatch (the highest-impact anti-forgetting technique) creates byte-divergent suffixes across calls. This is mildly cache-unfriendly but worth it. **Attention wins.**

---

## Is prefix caching automatic for plugin calls?

Partial answer, with limited visibility:

- **Anthropic's API does not auto-cache.** It requires explicit `cache_control` markers in the request body.
- **Claude Code (the CLI) almost certainly sets cache markers on its own infrastructure** — its system prompt and built-in tool schemas are huge and reused every turn. Operationally insane not to.
- **The plugin layer does not directly set cache markers.** What we control is the *content* — agent system prompts (`agents/*.md`), dispatch prompts (`prompt:` arg to `Agent`), CLAUDE.md, common-rules docs.

Practical takeaway: even if cache infrastructure is fully on, **the cache only fires when content is byte-stable across calls**. Plugin design choices (stable agent files, dispatch prompt ordering, what changes between similar dispatches) decide whether real hits happen. Attention discipline produces cache-friendly content as a side effect, in the cases where the two align.

---

## How PipeCrew scores on attention quality today

### Already strong

| Mechanism | Why it helps attention |
|-----------|----------------------|
| Subagents | Each agent gets a bounded context focused on one job. Smaller context = sharper attention. |
| Karpathy trim of common-rules R0/R3 | Direct attention quality improvement — less always-loaded content, more budget for the actual task. |
| Structured-block extractor | Replaces 5K of prose with 0.2K of JSON in the consumer's context. Consumer attends to the task, not to finding fields in narrative. |
| CLAUDE.md as shallow index | Always-loaded content stays small. Deep content loads only when needed. |
| TYPE_TO_AGENT routing | Loads only the relevant implementer's system prompt. The model isn't carrying 11 implementer prompts of background. |
| Specific path/file references in agent prompts | Concrete attention anchors throughout. |

### Real attention risks today

#### A. Phase 5.5 reviewer dispatch — interleaved concerns

The dispatch mixes precondition check, auto-fix-mechanical instructions, loop logic, classification rules, and the actual reviewer ask. Critical rules sit in the middle. **High forgetting risk.**

**Fix:** lead with the actual ask, framing in the middle, restate the critical "MUST do / MUST NOT do" rules at the bottom. Auto-fix-mechanical rules are exactly the kind of thing forgotten when buried mid-prompt.

#### B. Solution-architect dispatch — feature requirement risks burial

The architect prompt is long. The actual feature requirement (the thing the architect must design for) often appears once, mid-prompt, surrounded by framing about output blocks and format. If the architect "forgets" any constraint, the entire downstream pipeline implements the wrong thing.

**Fix:** feature summary at the top *and* restated at the bottom right before the imperative. Output format / framing rules in the middle — those are reference material, not the active task.

#### C. Implementer system prompts are heavy (200–600 lines)

Each implementer carries spec_policy switching, common-rules, framework conventions, output format, coverage block emission, scope-drift handling. That's a lot to "keep in mind" while writing code. Karpathy trimmed common-rules; the implementer prompts themselves are still heavy.

**Empirical evidence this matters:** Coverage block emission has historically been forgotten by implementers. R9 became a HARD RULE precisely because mid-system-prompt rules don't fire reliably.

**Fix:** for rules that have empirically been forgotten (R9 coverage, scope-drift check, mechanical/architectural classification), restate them in the **dispatch prompt** at point-of-use, not just in the system prompt. The dispatch prompt is the user message — closer to the active task in the model's attention.

#### D. Long FR/EC lists embedded in dispatch prompts

A feature with FR-1 through FR-12 plus EC-1 through EC-8 = 1–2K tokens of embedded list. Middle items get the weakest attention. Implementers occasionally miss requirements that sit in the middle of long lists.

**Fix options:**
- Reference a separate task file rather than re-embedding the list. Implementer reads the file as one structured artifact.
- For dispatches that must embed: end with a count + integrity check ("There are 12 FRs and 8 ECs above. Your COVERAGE block must contain all 20."). Forces enumeration.

#### E. Architect output prose buries the actionable for downstream consumers

`outputs/phase-2-architecture.md` is dense narrative for human review. Implementers need the actionable parts (what to build, where, with what constraints), not the rationale (why this design, what alternatives ruled out).

The structured-block extractor partially solves this: `AFFECTED_SERVICES` is JSON. But `API_DESIGN`, `DATA_MODEL`, etc. are still prose, mixed with rationale that's noise from the implementer's perspective.

**Fix:** continue the structured-block migration. Each block an implementer reads should have a JSON "contract" portion the implementer extracts and a prose "why" portion humans review.

---

## Recommendations, ranked by anti-forgetting impact

### 1. Restate critical rules at the bottom of long dispatch prompts (highest leverage)

For every dispatch over ~3K tokens, end with a "Critical:" block:

```
Critical for this dispatch:
- Emit the COVERAGE JSON block — every FR-X and EC-X above must appear.
- Run the scope-drift check before submitting.
- Classify every Critical finding as `mechanical` or `architectural`.

Now: {the imperative — what to produce, where to write it}.
```

100–300 tokens. Addresses the highest-impact failure mode (model forgetting a procedural rule that lives mid-system-prompt). Apply to: Phase 5b implementer dispatch, Phase 5.5 reviewer dispatch, Phase 2 architect dispatch.

### 2. Move the active task to start *and* end of every dispatch

Every dispatch should answer "what is this call producing?" in the **first sentence** and again in the **last sentence**. Framing, instructions, conventions in the middle. Structural rule, not a content rule — costs nothing to apply.

### 3. Trim what doesn't justify its attention budget

Continue the Karpathy pass. For each section of each dispatch prompt: "if the model didn't see this section, would the output be measurably worse?" If no, remove. If yes but rarely, move to a referenced doc (load on demand) rather than always-loaded.

Specific candidates today:
- `SKILL.md` "Inventory of utility scripts" (~250 tokens always loaded) — most phases need only one of those scripts. Could be a per-phase reference.
- Verbose framing in architect dispatch about output format — model can read the format spec from a referenced file when emitting; doesn't need to "hold" the whole spec while reasoning.

### 4. Replace inlined long lists with file references

Long FR/EC lists, long endpoint lists, long file-target lists: write to a file the agent reads, rather than embedding. The `Read` tool gives the agent a structured artifact to focus on, separate from framing prose. Keeps dispatch prompts short (better attention on framing) and gives the agent a navigable artifact (better attention on the list).

### 5. Continue structured-block migration for what implementers consume

`AFFECTED_SERVICES` extractor proved this works. Apply to `API_DESIGN` (high-leverage — every implementer reads it), `DATA_MODEL`, `INFRASTRUCTURE_IMPACT`. Each migration cuts attention noise for downstream consumers.

### 6. Add integrity checks to long enumerable lists

When a dispatch must embed N items the model has to act on (FR/EC, files, endpoints), add a count and force enumeration: *"There are 12 FRs and 8 ECs listed. Your COVERAGE block must contain at least 20 entries."* Catches the lost-in-the-middle failure mode for enumerable inputs.

### 7. Prefer agent-system-prompt for stable rules, dispatch-prompt for per-call task

Audit each dispatch prompt for content that doesn't change across dispatches of the same agent. If it's stable, it belongs in the agent's system prompt (loaded once per session, treated as authoritative background). If it varies per call, it belongs in the dispatch user message (treated as active task).

Keeping these tiers clean improves attention and as a side effect produces a cleaner cacheable prefix.

---

## The cache-trade-off table — for honesty

| Recommendation | Cache effect | Worth it? |
|---------------|--------------|-----------|
| 1. Restate critical rules at bottom | Mildly cache-unfriendly (suffix bytes vary slightly) | Yes — restated content is small; attention win is large |
| 2. Active task at start *and* end | Cache-neutral (both positions hold dynamic content already) | Yes — pure win |
| 3. Trim what doesn't earn its place | Cache-positive (less prompt, more stable) | Yes — pure win |
| 4. File references over inlined lists | Cache-positive (shorter, more stable dispatch prompts) | Yes — pure win |
| 5. Structured-block migration | Cache-neutral (consumer reads via extract-block.js, not as prompt content) | Yes — pure win |
| 6. Integrity checks for long lists | Cache-neutral (small fixed addition) | Yes — pure win |
| 7. Stable rules → system prompt, task → dispatch | Cache-positive (system prompts are higher-cache-locality content) | Yes — pure win |

Six of seven are pure wins on both axes. The one trade-off (#1) sacrifices a small amount of cache locality for a large attention gain. **Worth it.**

---

## What NOT to do — the trap

Once you're aware that prefix caching exists, there's a temptation: *"caching makes the prefix free, so I might as well include everything in there!"* This is wrong on two fronts:

1. **Cache hits make prefill cheaper, not free.** Cached tokens still cost ~10% of normal input pricing. A 100K-token cached prefix still costs 10K-tokens-worth per call.
2. **More importantly: the model still attends to every token in the cached prefix.** Cache is a *prefill* optimization, not an *attention* optimization. Attention dilution is unaffected by caching. A 100K-token cached prefix dilutes attention exactly as much as a 100K-token uncached prefix would.

So if cache friendliness becomes an excuse to bloat prefixes ("might as well include every example, every schema, every convention since it's all cached"), the run-specific task at the end ends up competing with a wall of background for attention — and loses.

**The discipline that protects against this:**

> **Cache friendliness is rearrangement, not addition.** If you want to put something into the cacheable region, you must delete something equivalent first. The total prompt budget never grows in service of caching.

This discipline keeps the optimization aligned with the goal: the model doesn't forget instructions because there are fewer instructions competing for its attention, well-placed within it.

---

## TL;DR

- **Attention quality is the goal.** Prefix caching is a side effect that may or may not fall out.
- **Where they align**, both win: trim, structure, reference don't-inline, dynamic-at-end.
- **Where they conflict** (restating critical rules at the end), **attention wins.**
- **The trap to avoid:** never grow a prompt to make it more cacheable. Rearrangement-only.
- **The seven recommendations**, ranked above, address the real forgetting risks the plugin has today. #1 is the highest leverage and the lowest risk to start with.

If a future contributor reads this doc and only takes one thing away, it should be: **the model forgetting an instruction is a disaster; a cache miss is a rounding error. Optimize accordingly.**
