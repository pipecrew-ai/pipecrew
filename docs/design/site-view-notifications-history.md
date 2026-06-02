# Site-view notifications — implementation history

Chronological log of polish rounds that built up the site-view notification subsystem. Originally part of `rules/site-view-notifications.md`; split off when the file's two purposes were separated AND the rules half was relocated to `docs/` (no skill or agent actually loads it at runtime — it's documentation, not a rule). The **current architecture** lives in [`../site-view-notifications.md`](../site-view-notifications.md).

Each "Polish round N" section below is a self-contained record of what changed, why, and the files touched. Newest at the bottom; read top-to-bottom to retrace how the UI evolved.

---

## Polish round 2

Second-pass UI polish covering five asks from the user. All changes are pure vanilla JS/CSS — zero new dependencies.

### Ask 1 — tokens + duration on finished character cards

Finished agents now show a compact `52k · 1:38` line under their name.

**Data resolution chain (first hit wins)**:

1. **Scratchpad Agent Dispatch Log → per-normalized-name aggregation.** The parser indexes `agentMetrics[normalizeAgentName(row[2])]`. Normalisation strips parenthesised round descriptors so `"dal-product-owner (Q&A round)"` and `"dal-product-owner (final doc)"` both collapse to `dal-product-owner`. See `server.js:parseScratchpad()` — dispatch-log loop around line 370.
2. **Scratchpad Agent Dispatch Log → per-role aggregation.** When the character's bare agent name (e.g. `product-owner` from `DEFAULT_AGENT_NAME`) doesn't match a dispatch-log row (which carries the workspace-prefixed variant `dal-product-owner`), we fall back to summing all rows whose agent maps to the same role via `agentToRole()`.
3. **Checkpoints `agent_end` events.** If the scratchpad has no dispatch-log entry at all, we use `total_tokens` + `duration_ms` from matched `agent_start` → `agent_end` pairs. `duration_ms` missing? We compute it from timestamp delta. See `server.js:readCheckpoints()` — the new `agentMetrics` return field.

**Why scratchpad is preferred**: one-line code comment at the character-metric resolution loop in `server.js` around line 420 — "Prefer scratchpad (orchestrator's canonical summary with round-descriptor granularity). Fall back to role-level scratchpad aggregation for name-mismatches, then finally to checkpoints agent_end events."

**Formatting**: `formatMetrics(tokens, duration)` in `public/index.html` composes the compact string. Ordering is `{tokens} · {duration}` — tokens first (more important signal), either may be empty so a working-but-not-yet-finished agent shows nothing. Rendered in `.char-label .metrics .combined` with `opacity: 1` on `.card.done` / `.card.failed` and `opacity: 0.6` on `.card.working`.

**Known limitation (pre-existing, not introduced by this round)**: when a role has multiple parallel tasks (e.g., two `bruno` / `spring-boot-api-implementer` cards for two backend repos), the role-level aggregation sums tokens across both tasks so each card shows the combined total instead of its own. Fixing this needs task-ID carry-through from Implementation Tasks → Dispatch Log matching — out of scope for polish round 2.

### Ask 2 — mute toggle that auto-unmutes on next gate

Speaker icon in the header `meta` row. States:

- 🔔 (default): sounds play when a gate is open.
- 🔕 with red strike-through overlay: sounds suppressed. Banner still pulses, tab title still flashes.

**Auto-unmute triggers** (reconcile runs on every `applyState`):

1. **Gate closes** (composite `since` becomes null) → `setMuted(false)`.
2. **New gate opens** (composite `since` differs from `muteActiveSince` captured at mute-time) → `setMuted(false)`, play the chirp immediately.

**State location**: pure in-memory (`let muted`, `let muteActiveSince`). Intentionally NOT localStorage-backed — we want a page reload to un-mute so stale silence doesn't persist. See `public/index.html` lines around `setMuted()` and `reconcileMuteAgainst()`.

**Accessibility**: `aria-label` swaps between "mute notifications" / "unmute notifications" based on current state; `title` explains auto-unmute behaviour.

### Ask 3 — surface hook failures

**Hook side** (`scripts/notify-hook.js`):

- Main handler wrapped in try/catch. Failure → `recordHookError(err, context)`.
- `recordHookError()` writes to **one of two places**:
  - When `activeRunDirs()` returns ≥1 dir: `{run_dir}/hook_error.json`, shape `{ errors: [ {ts, error, context}, ... ] }`, rotated to last 3 entries. Previous file is read, new entry appended, trimmed, rewritten.
  - When no active runs: `~/.claude/logs/pipeline-view-hook-errors.log`, one JSON object per line, rotated to last 3 lines.
- Specific failure modes covered: malformed JSON on stdin (stage `stdin-parse`), `fs.writeFileSync` failure for the flag file (stage `flag-write`), unhandled exception in main (top-level catch with `{action: ACTION}` context).

**Server side** (`skills/site-view/server.js`):

- New `readHookErrors()` reads both the per-run file and the global log, merges them, tags each entry with `source: 'run' | 'global'`, returns last N combined.
- Exposed on `state.hookErrors` (null when no errors).
- New `GET /hook-errors` endpoint returns `{ errors: [...] }` for direct polling / debugging.
- `fs.watch` + `fs.watchFile` now also track `hook_error.json` so changes broadcast via SSE; global log is also polled when present.

**UI side** (`public/index.html`):

- `.hook-error` pill in the header `meta` row (hidden by default, `.visible` shown). Red dot + "hook error" text + hover tooltip listing all entries with `{time} ({source}) — {error} [{context}]` per line.
- `renderHookErrors(errors)` runs on every `applyState`. Counts >1 show `hook error ×N`.

### Ask 4 — building vs finished zones

**DOM partition** is in `public/index.html`:

- `.grid` container now holds two zone headers and a divider:
  - `.zone-header.building` (top, `Currently building` + count)
  - `.zone-divider` (horizontal line at y=346)
  - `.zone-header.finished` (bottom, `Completed` + count)
- Cards are absolutely positioned inside `.grid`; `layout(characters)` partitions by status:

**CSS class hierarchy for zone placement**:

```
.grid
├── .zone-header.building          (top label)
├── .zone-divider                  (middle rule)
├── .zone-header.finished          (bottom label)
└── .card#card-{id}                (absolute positioned via --qx/--qy)
    ├── .card.working              → layout sets y=160 (top band)
    ├── .card.queued               → layout sets y=160 (top band, right of working)
    ├── .card.done                 → layout sets y=370 (bottom band); --qscale: 0.6
    ├── .card.failed               → y=370; --qscale: 0.85; red stroke + drop-shadow
    └── .card.skipped              → y=370; --qscale: 0.5; opacity: 0.5; .skipped-chip visible
```

Failed agents get `#ef4444` stroke + drop-shadow glow. Skipped agents get grey stroke, reduced opacity, and an inline "SKIPPED" chip rendered as `.skipped-chip` under the repo label. The character-roster logic (`CHARACTER_ROSTER` / `agentToRole()` in server.js) is untouched — partitioning happens purely in the client `layout()` function.

### Ask 5 — drop-and-bob animation

**SVG change**: each of the 10 `body*()` helper functions now wraps its content in `<g class="char-body">…</g>` so the animation has a single transform target.

**CSS keyframe** `dropAndBob` on `.card.working svg.char .char-body`:

- `0%, 100%`: translateY(0)
- `20%`: translateY(4px) — drop
- `30%`: translateY(4px) — pause
- `60%`: translateY(-8px) — rise
- `70%`: translateY(-8px) — pause
- ease: `cubic-bezier(0.36, 0, 0.66, 1)` (stock "ease-in-out" feels too bouncy)
- `animation-iteration-count: infinite`, duration `1.2s`

Applied only on `.card.working` — queued / done / failed cards stay still. The existing `hammerArm` animation on `.arm-r` continues unchanged; arm and body animations compose.

**Reduced-motion fallback** (`@media (prefers-reduced-motion: reduce)`):

```css
.card.working svg.char .char-body {
  animation: workingBreathe 2.4s ease-in-out infinite;
  transform: none !important;
}
.card.working svg.char .arm-r { animation: none; }
@keyframes workingBreathe { 0%,100% { opacity: 0.75; } 50% { opacity: 1; } }
```

Hammer arm is also disabled; bob becomes a gentle opacity pulse (75% → 100%) at half speed (2.4s). The banner-pulse reduced-motion rule (pre-existing) already handles the gate banners.

### Files touched (polish round 2)

- `skills/site-view/server.js` — dispatch-log parser (normalize agent name, role-level aggregation), checkpoints agent_end token/duration extraction, `readHookErrors()`, `/hook-errors` endpoint, hook_error file watching.
- `skills/site-view/public/index.html` — mute button + auto-unmute logic, hook-error pill, building/finished zone DOM + layout, drop-and-bob keyframe + reduced-motion fallback, `.char-body` wrap in all 10 SVG bodies, compact `formatMetrics()` rendering, failed/skipped styling + skipped chip.
- `scripts/notify-hook.js` — `recordHookError()` + rotation to last 3 entries, try/catch wrap around main + stdin-parse + flag-write stages, global fallback log at `~/.claude/logs/pipeline-view-hook-errors.log`. Also fixed a latent JSDoc bug on line 28 where `**/integration/**` in a `@example` comment was closing the JSDoc block early (caused `ReferenceError: integration is not defined` at runtime).

### Gotchas

- **Scratchpad agent-name matching is fuzzy**. Workspace-prefixed names (`dal-product-owner`) and plugin-qualified names (`pipecrew:react-feature-implementer`) differ from the bare names in `DEFAULT_AGENT_NAME`. The normalize-and-role-fallback chain handles this but adds one subtle cost: if two roles share a matching pattern, the first one wins. See `agentToRole()` ordering in `ROLE_PATTERNS`.
- **Hook error rotation** caps at 3 entries. If the user has a genuinely broken setup that's firing errors constantly, the pill will always show `×3` and older errors fall off the list. Acceptable for a debug aid; not a long-term audit log.
- **Mute is per-session**. Deliberate: we don't want the user to open the UI tomorrow and hear nothing because they muted last week. The "auto-unmute on new gate" rule is also deliberately aggressive — the whole point of muting is a one-time convenience (e.g. during a meeting), not a default state.
- **Zone divider height is fixed at y=346**. If the SVG `queue-bg` viewBox changes, this value needs to move with it. Currently `viewBox="0 0 1400 440"` is hardcoded in the HTML so this is stable.

---

## Polish round 3 — empty-zone cleanup

Fixed a "broken placeholder" look that appeared during approval gates: when every active agent had just finished and the next phase had not yet dispatched, the empty build zone left a large dashed rectangle hanging between the `WORK ZONE` label and the `FINISHED CREW` divider.

### Changed (`skills/site-view/public/index.html`)

- **Removed the dashed border lines around the underground/finished area** (previously three `<line stroke-dasharray="2 3">` segments drawing left/right/bottom of a 900x150 box). The underground now keeps only the subtle `rgba(80,60,30,0.18)` fill, wrapped in `<g id="finished-frame">` so the fill itself can be toggled off when no characters have finished.
- **Wrapped the `◆ WORK ZONE ◆` label + queue-direction arrow in `<g id="work-zone-group">`**, and the scaffolding-frame dashed rect in `<g id="scaffolding-frame">`, and gave the `⎯ FINISHED CREW · UNDER BUILDING ⎯` text `id="finished-zone-label"`.
- **Extended `layout(characters)`** to compute `buildingCount = working + queued` and `finishedCount = done + failed + skipped`, then `classList.toggle('hidden', count === 0)` on: `#zone-building`, `#work-zone-group`, `#scaffolding-frame`, `#zone-finished`, `#finished-zone-label`, `#finished-frame`. The horizontal `.zone-divider` is hidden when either zone is empty (a divider over nothing looks orphaned).
- **Added CSS**: `.zone-header.hidden { opacity: 0; visibility: hidden; }`, `.zone-divider.hidden { opacity: 0; }`, and matching `#work-zone-group.hidden / #scaffolding-frame.hidden / #finished-zone-label.hidden / #finished-frame.hidden { opacity: 0; pointer-events: none; }` — all with a 0.25s opacity transition so states flip without a harsh pop.

### Before / after

- **During a gate (empty build zone)**: previously showed a large empty dashed rectangle + `WORK ZONE` label + empty scaffolding + a `COMPLETED` label over a dashed underground box. Now: scaffolding + work-zone label + queue arrow all fade out; only the `COMPLETED` header, the underground fill, and the finished characters remain.
- **Mid-phase (agents building)**: both zone headers + SVG labels + scaffolding + divider are visible; drop-and-bob animation unaffected.
- **End of run (everything done)**: only the `COMPLETED` header + `FINISHED CREW` SVG label + underground fill + the done characters are shown; the build zone is fully absent.
- **Start of run (nothing finished yet)**: `COMPLETED` header / `FINISHED CREW` label / underground fill all hidden — no orphaned divider.

### Edge cases confirmed

- **Empty run** (no characters at all) — both zones hidden; screen is the empty scene + header only.
- **All-skipped** — skipped count into `finishedCount`, so the finished zone still shows its header (`Completed N`) + skipped chips; build zone is hidden.
- **All-failed** — same: failed cards land in the finished zone, red stroke + glow preserved; build zone is hidden.
- **Single working agent, nothing finished** — build zone visible with agent bobbing, finished zone + divider hidden.
- **Zone-count updates** run every `applyState` so SSE-driven transitions fade in/out within the 0.25s window without layout jumps.

### Files touched (polish round 3)

- `skills/site-view/public/index.html` — removed dashed zone-border lines, wrapped SVG zone decorations in toggleable groups with stable IDs, extended CSS with `.hidden` rules for both DOM headers and SVG groups, added empty-zone toggle logic to `layout()`.

### Follow-up — build-elements-group

User still saw a visible orange-fill rectangle in the top half on an empty build zone. Root cause: the 10 `.build-element` shapes (`build-1`..`build-9` rects + `build-10` triangle path, all `fill="rgba(245,166,35,0.18)"` at `index.html:693-702`) sit in a wrapper `<g>` with no ID, so they weren't part of the round-3 toggle set. Worse, `updateBuildingProgress()` marks them `.visible` whenever a char is `working` OR `done`, so when all chars finished every block stayed visible, stacking into a ~220×140 orange box inside the (now unbordered) scaffolding area. Fix: gave the wrapper `id="build-elements-group"` (`index.html:692`), added it to the CSS transition + `.hidden` rule list (`index.html:149,156`), and added `toggleHidden('build-elements-group', buildingCount === 0)` in `layout()` (`index.html:1163`). No other visible-fill scene elements needed changing — the `#finished-frame` rect and `#work-zone-group`/`#scaffolding-frame` groups already collapse, and the remaining scene fills are either `none` or tiny text/arrow glyphs already inside toggled groups.

---

## Polish round 5 — missing characters

User reported that several dispatched agents never appeared in the pipeline-view scene. Audit traced the gaps to two root causes: (1) the `ROLE_PATTERNS` table in `server.js` had no entry for `security-consultant`, `reporter`, or `context-manager`, so `agentToRole()` returned `null` and `parseScratchpad()` silently dropped the row; (2) the `bruno` and `mira` SVG bodies were generic humanoid silhouettes that the user couldn't distinguish from `pip`/`archie` at a glance, contributing to the "implementers / UX missing" perception.

### Agents that were unmapped before this round

| Agent name (as written in the dispatch log) | Phase | Was rendered as | Now rendered as |
|---|---|---|---|
| `security-consultant` | 5.75 | (dropped silently) | `shield` — figure with heater shield + keyhole lock |
| `reporter` | 7 | (dropped silently) | `scribe` — figure with notepad + quill |
| `context-manager` | 7 | (dropped silently) | `sage` — hooded figure with unrolled scroll |

### Visual distinctness pass on existing characters

`bruno` (backend implementer) was a featureless head + box — easy to confuse with `archie` and `pip` once they were on the same row. Reworked to a hard-hat construction worker silhouette: dome + brim + crest line on the head, overall straps on the torso, and a small hammer on the right arm so the working-state hammer animation reads as actual hammering.

`mira` (UX consultant) was a generic dress silhouette. Reworked to an artist with a painter's palette in the left hand (oval + thumb hole + three filled colour dots) and a brush in the right — the palette is the at-a-glance identifier the user asked for.

### Files touched (polish round 5)

- **`skills/site-view/server.js`**
  - `ROLE_PATTERNS` extended with three new entries: `shield` (lines 200), `scribe` (210), `sage` (211). `shield` and `mira` are now ordered before the implementers so `*-consultant` suffixes win over fuzzier matches.
  - `DEFAULT_AGENT_NAME` extended with the three new roles (lines 240, 244-245).
- **`skills/site-view/public/index.html`**
  - `bodyBruno()` rewritten with hard-hat silhouette (lines 814-840).
  - `bodyMira()` rewritten with palette + brush (lines 858-887).
  - `bodyShield()` added — security-consultant character (lines 935-955).
  - `bodyScribe()` added — reporter character (lines 957-983).
  - `bodySage()` added — context-manager character (lines 985-1009).
  - `BODIES` registry updated to map `shield`, `scribe`, `sage` to their new factories (lines 1018-1020).
- **`docs/site-view.md`** — character roster table extended with the three new rows + a note about pattern ordering.
- **`scripts/simulate-run.js`**
  - Added Phase 5.75 to `phaseStatus` so the security-consultant gets a row.
  - Added two `security-consultant` dispatches in Phase 5.75 + `reporter` and `context-manager` dispatches in Phase 7 so `/simulate-run --launch-ui` exercises every character now in the roster.

### Verification

- `node -c server.js` — passes.
- Inline JS extraction from `index.html` parses with `new Function(...)` — passes.
- `agentToRole()` spot-checked against 22 known agent names (every dispatched name in `phases/*.md`, both bare and `dal-`-prefixed forms) — 22/22 routed to the expected role.
- `node simulate-run.js --step-ms=50 --cleanup-on-exit` — full timeline runs cleanly with the new phases / dispatches; no parser errors in the headless run.

### Why no Pip/Archie/Yara/Echo/Stratos rework

Those characters are already visually distinct (Pip's beret, Archie's blueprint torso, Yara's flowing scarf, Echo's stacked ovals, Stratos's lightning bolt + cloud). Only `bruno` and `mira` were generic enough to confuse with the orchestrator-phase characters when they shared a row, and only those two were called out in the user report.

### Intentionally not given a character

- `general-purpose` (the fallback in phase-1 / phase-6 when the workspace-published agent isn't found) — this is an emergency fallback path, and an unrecognised agent already routes to `bodyPip` via the `(BODIES[c.role] || bodyPip)()` default in `ensureCard()`. Adding a dedicated "fallback" silhouette would advertise the failure mode rather than the work being done. The orchestrator already logs a warning when this fallback fires; surfacing it again in the UI would be noise.

---

## Polish round 6 — queue pre-seeding

User reported that at Phase 1, the **queue** section of the pipeline view showed only Crit and Judge — every stage-specific agent (Shield, Mira, Pixel, per-service Brunos, Echo, Stratos, Scribe, Sage) was absent until it actually dispatched. Implementers added in rounds 2 + 5 appeared in `working` / `done` but never in `queued`, making the crew look incomplete early in a run.

### Root cause

`skills/site-view/server.js:parseScratchpad()` synthesised characters from two sources:

1. **Phase Status** table (`## Phase Status`) — but only roles listed in `PHASE_TO_ROLE` (pip, archie, yara, crit, judge). Phase 5.75 (shield) and Phase 7 (scribe/sage) had no entry. Per-service implementers had no phase mapping at all — they lived only in Implementation Tasks.
2. **Implementation Tasks** table — but that table is empty until Phase 2 (architect) populates it. At Phase 1 there are zero rows.

Result: at Phase 1 the roster was `pip(working), archie(queued), yara(queued), crit(queued), judge(queued)` — five characters, no implementers, no consultants, no Phase-7 agents. Exactly what the user saw.

### Fix — pre-seed from Architecture Flags

Added a new pre-seed pass that reads the `## Architecture Flags` section (which the orchestrator writes at Phase 1) and injects a queued character for every role the architect's plan implies:

| Flag | Seeds |
|------|-------|
| `Affected Services: publisher, backoffice` | one `bruno` per backend service (`bruno`, `bruno-2`, …) |
| `Frontend Required: Yes` (or "likely Yes") | `pixel` + `mira` |
| `Mock Required: Yes` (or "likely Yes") | `echo` |
| `Infra Required: Yes` | `stratos` |
| `Security Required: Yes` (or flag absent — default) | `shield` |
| (always) | `scribe`, `sage` — Phase 7 agents run every `/deliver` unless `--no-context-update` |

The `affectedServices` filter uses a heuristic: a service name ending in `-frontend` / `-ui` / `-web` / `-mock` / `-infra` / `-cdk` / `-ops` is **not** counted as a backend (so it doesn't spawn a spurious Bruno). "TBD (architect decides Phase 2)" collapses to zero services and falls back to one default Bruno so the queue at least shows "backend will happen" rather than an empty build side.

Truthy parser for the boolean flags: `yes`, `true`, `required`, and the Phase-1-phrasing `likely yes` all count as YES. `no`, `tbd`, `—`, `none`, `n/a` count as NO. Unknown text (e.g. a hand-written note) falls through to NO — safer than showing a ghost character that won't dispatch.

### Where it hooks in

`server.js:parseScratchpad()` — new section between the Phase Status loop and the Implementation Tasks loop:

1. `parseArchFlags(content)` parses the bullet-list section into `{ affectedServices, frontendRequired, mockRequired, infraRequired, securityRequired }`. The section is delimited by the next `\n## ` header.
2. The preseed list is built per the table above.
3. Each preseeded character is pushed **only if its `id` is not already in `seen`** — so a `pip` already flipped to `working` by Phase Status isn't clobbered.
4. `PHASE_TO_ROLE` extended with `'5.75': 'shield'` so when Phase 5.75 flips to IN_PROGRESS, shield transitions from queued → working via the existing phase-status path.

### Merge with real dispatch entries — no dedup needed

Two merge paths keep the preseed → actual transition duplicate-free:

1. **Implementation Tasks loop** now looks up `characters.findIndex(c => c.id === id)` (previously only checked `seen.has(role) && roleCounts[role] === 1`). A task row for `spring-boot-api-implementer` assigns `id = 'bruno'` (first) / `'bruno-2'` (second). If a preseeded queued `bruno` / `bruno-2` already exists, it's **replaced in-place** (same array index, new repo + status). No duplicate cards, positional stability preserved for the `layout()` function.
2. **Agent Dispatch Log → dispatch-log promotion loop** (new). Tracks per-role dispatch count + outcomes. For each role that has dispatches:
   - If dispatch count exceeds existing character count, new queued slots are appended (e.g. two `security-consultant` dispatches → `shield` + `shield-2`).
   - Rollup outcome: any-failed → failed; any-working → working; all-done → done.
   - For each character of that role that's still `queued`, flip its status to the rollup. Characters already in `working` / `done` / `failed` are **not downgraded** — Phase Status and Implementation Tasks remain authoritative for roles they populated.

The `status !== 'queued'` guard is what makes this safe: a preseed can only be promoted forward, never stomped backward.

### Test at Phase 1 — verified

Added `skills/site-view/_test_preseed.js` — a 25-assertion harness that slices server.js into a requireable module (strips the bootstrap + stubs workspace/runId resolvers) and exercises the parser against 6 scenarios. All 25 pass.

**At Phase 1 (flags: 2 backends + FE + mock, no infra)**, the queue now contains:

| id | role | status |
|----|------|--------|
| pip | pip | working |
| archie | archie | queued |
| yara | yara | queued |
| crit | crit | queued |
| shield | shield | queued |
| judge | judge | queued |
| bruno | bruno | queued |
| bruno-2 | bruno | queued |
| pixel | pixel | queued |
| mira | mira | queued |
| echo | echo | queued |
| scribe | scribe | queued |
| sage | sage | queued |

13 characters (was 5). `stratos` correctly omitted (infra flag is NO). The real DAL scratchpad `2026-04-15-200215-contract-view-and-list/scratchpad.md` — which has `Affected Services: TBD` + `likely Yes` for FE and Mock — produces 12 characters (no `stratos` for "likely No" infra).

### Files touched (polish round 6)

- **`skills/site-view/server.js`**
  - Added `parseArchFlags(content)` (lines ~365–420) — parses `## Architecture Flags` bullet list.
  - Added the preseed pass inside `parseScratchpad()` — runs after Phase Status, before Implementation Tasks.
  - Extended `PHASE_TO_ROLE` with `'5.75': 'shield'`.
  - Rewrote the Implementation Tasks → existing-character merge to use `characters.findIndex(c => c.id === id)` (was `if (seen.has(role) && roleCounts[role] === 1)`), so preseeded `bruno-2`, `pixel`, etc. merge cleanly.
  - Added a dispatch-log → preseed promotion loop at the end of the dispatch-log parsing section; tracks `dispatchByRole = { role: { count, outcomes } }` and flips queued chars up to the rolled outcome.
- **`skills/site-view/_test_preseed.js`** (new) — unit-test harness; run `node _test_preseed.js` from the skill dir.

### Gotchas + follow-ups

- **`parseTable()` stops at the first non-pipe line.** A blank line between rows terminates the table. Orchestrators writing the scratchpad must keep all dispatch rows contiguous under the separator. (Already the case for `scripts/simulate-run.js`.)
- **Backend-service heuristic is name-based.** If a workspace has a backend repo named `abvi-frontend-api` (unlikely, but possible), it would be misclassified as frontend and not get a Bruno. Easy fix when we hit the case: let the architect pass an explicit `Service Kind` column in the future.
- **`scribe` + `sage` are always-on.** If a future `/deliver --no-context-update` flag is added, the preseed should parse it and suppress `sage`. Currently we always queue both; the user sees a queued sage that never dispatches when the flag is set. Minor aesthetic issue, deferred until the flag actually ships.
- **Phase-5.75 + two dispatches** produces `shield` (from PHASE_TO_ROLE) in `working` **plus** `shield-2` (from dispatch promotion) in whatever the rollup dictates. Visually correct — two security consultants means two shield silhouettes — but the first card gets its status from Phase Status and the second from dispatch-log rollup. If the phase is flagged IN_PROGRESS after all dispatches complete, shield stays `working` even when shield-2 is `done`. This reflects a scratchpad inconsistency (orchestrator forgot to flip the phase); the UI faithfully renders whatever the scratchpad says.

---

## Polish round 6 follow-up — ghost duplicates, prose flags, queue overflow

Round 6 shipped, but the user still reported a short queue (well under the 13-character target) on the live `2026-04-16-122519-book-content-upload` run. Re-testing the parser against the real scratchpad surfaced three distinct bugs that each trimmed or garbled the roster.

### Bug 1 — Phase-singleton dispatch retries spawned ghost cards

`mapStatus()` only recognised `COMPLETED / IN_PROGRESS / SKIPPED / FAILED / BLOCKED`. The live dispatch log uses prose outcomes like `success — 27 questions raised`, which fell through to `'queued'`. The dispatch-log promotion loop then rolled those "queued" outcomes up to `'working'` (the mixed/unknown fallback), AND — because `info.count` (2) exceeded the one existing pip character — created a `pip-2` ghost card. Same trap was waiting for any phase with a retry (architect re-plan, spec-editor follow-up, etc.).

**Fix**:
- `server.js:mapStatus()` — recognise `success / ok / complete / fail / error / timeout` as leading keywords (`head = s.split(/[\s…\-:—]/)[0]`) so prose outcomes map correctly.
- `server.js:parseScratchpad()` dispatch-log promotion — added `SINGLETON_ROLES = {pip, archie, yara, crit, judge}`. For those roles we cap the created-character count at `max(existing.length, 1)` so multi-round dispatches within a singleton phase never spawn `pip-2 / archie-2`. `shield` is intentionally NOT in the set — it can legitimately run per-repo (see Round-6 gotcha above).

### Bug 2 — `parseArchFlags()` couldn't read prose service lists

The real orchestrator writes Architecture Flags like:

```
- **Affected Services**: publisher (presign/upload), backoffice (content-team browse/download/review), user-management (new role). Not affected: contract.
```

The old split-on-comma treated `"publisher (presign/upload)"` as a service name. `shortRepo()` then ran `path.basename()` on it, which splits on `/` and produced `"upload)"` as the repo label. Worse, the last segment was `"user-management (new role). Not affected: contract."` — a run-on of two different concepts.

**Fix** (`server.js:parseArchFlags()`):
1. Strip any trailing `Not affected: …` clause before splitting.
2. Drop parenthetical groups from each segment (`/\s*\([^)]*\)/g`).
3. Strip trailing period.
4. Keep only the first whitespace-separated token — the service name.

Result: `["publisher", "backoffice", "user-management"]` instead of three paragraphs.

### Bug 3 — big queue overflowed the 1400px scene

Step of 95px × 11 queued cards = ~1050px, starting at `queueStart ≥ 560`, right edge ≈ 1720. The `.scene-wrap { max-width: 1400px }` plus `body { overflow: hidden }` clipped the last 3-4 cards off-screen — exactly the "missing agents in queue" symptom.

**Fix** (`public/index.html:layout()` around the `queued.forEach`): adaptive `qStep`. Reserve `SCENE_RIGHT = 1370px`, compute `available = SCENE_RIGHT - queueStart - CARD_W`; if the default 95px step overflows, shrink to `Math.max(48, floor(available / (queued.length - 1)))`. 48px minimum keeps cards overlapping gracefully rather than stacking on top of each other. Queue-hint line / label use the same step so the underline tracks the cards.

### Live-run verification

With the three fixes applied, `/state` against `2026-04-16-122519-book-content-upload` (Phase 3, IN_PROGRESS) returns **15 characters**:

| bucket  | count | chars |
|---------|-------|-------|
| done    | 2     | pip, archie |
| working | 1     | yara |
| queued  | 12    | crit, judge, bruno (publisher), bruno-2 (backoffice), bruno-3 (user-management), pixel, mira, echo, stratos, shield, scribe, sage |

All 13 agents from the Round-6 target list are present; bruno-3 and stratos are the extras the architect's flags explicitly called for (3 affected services, infra required).

### Scratchpad flags text (verbatim, for future test fixtures)

```
- **Affected Services**: publisher (presign/upload), backoffice (content-team browse/download/review), user-management (new role). Not affected: contract.
- **Auto-detected phases**: 3 (spec edit — 3 specs), 4 (sync), 5a (publisher + backoffice backends), 5b (frontend), 5c (mock), 5d (infra — abvi-ops-platform + abvi-notifications-service), 5.5 (review), 5.75 (security), 6 (multi-repo assess), 7 (report)
- **Skipped phases**: abvi-infra (no changes needed)
- **Spec Edit Order**: 1) user-management, 2) publisher, 3) backoffice
- **Frontend Required**: Yes — 2 new feature modules
- **Mock Required**: Yes — publisher + backoffice mock endpoints
- **Infra Required**: Yes — full content stack in abvi-ops-platform; SES template in abvi-notifications-service
```

### Tests

`_test_preseed.js` still passes all 25 assertions. The fix is covered implicitly by Test 4 (multi-dispatch product-owner no longer spawns pip-2) and Test 3 (shield + shield-2 still supported because shield is NOT in `SINGLETON_ROLES`). Adding an explicit "dispatch log with `success —` prose outcome" fixture would be a worthwhile future addition.

### Files touched (follow-up)

- `skills/site-view/server.js` — `mapStatus` keyword fallback; `parseArchFlags` prose-tolerant service parser; `SINGLETON_ROLES` cap in dispatch-log promotion loop.
- `skills/site-view/public/index.html` — adaptive `qStep` inside `layout()` so big queues fit within the 1400px scene.

---

## Polish round 8 — phase badge

### Problem

When a Phase 5 implementer finished and was later re-dispatched by a Phase 5.5 fix round, the character (e.g. `bruno`, `pixel`, `stratos`) cycled `done → working → done` on the card with **no visual indication** that the second pass was a *fix round* rather than the original implementation. A user watching the UI couldn't tell whether `bruno` was writing the first cut of the backend or patching a reviewer's nits.

### Solution

Every non-queued character card now renders a small phase chip underneath its repo label. The chip reads the most recent `Phase` cell from `## Agent Dispatch Log` for the character's role and renders a short, category-coloured pill:

| Phase cell (scratchpad)            | Chip label   | Category   | Colour       |
|------------------------------------|--------------|------------|--------------|
| `1`                                | `requirements` | neutral  | muted grey   |
| `2`                                | `arch`       | neutral    | muted grey   |
| `3`                                | `spec`       | neutral    | muted grey   |
| `4`                                | `sync`       | neutral    | muted grey   |
| `4.5`                              | `plan`       | neutral    | muted grey   |
| `5` / `5a` / `5b` / `5c` / `5d`    | `impl`       | impl       | blue         |
| `5.5-fix` / `5.5-fix-r1` / `-r2` … | `fix-r{N}`   | fix        | orange       |
| `5.5`                              | `review`     | review     | purple       |
| `5.75`                             | `security`   | security   | red          |
| `6`                                | `assess`     | assess     | green        |
| `7`                                | `report`     | neutral    | muted grey   |

Queued characters (no dispatch entry yet) get **no chip** so the queue zone stays clean.

### Files touched

- **`skills/site-view/server.js`**
  - New top-level helper `mapPhaseToLabel(phase)` (after `formatDurationMs`, around line 377) — returns `{ label, category }` for any dispatch-log phase cell.
  - Inside `parseScratchpad()` dispatch-log loop: introduced `latestPhaseByRole` (most recent phase per role) and `fixRoundByRole` (tracks `{round, lastWasFix}` so bare `5.5-fix` entries get `fix-r1`, and `fix → review → fix` transitions bump to `fix-r2`).
  - Per-character resolution loop: sets `c.phaseLabel` + `c.phaseCategory` when the char isn't `queued`. Falls back to `c.phase` (character's phase field from Implementation Tasks / Phase Status) when the role never appeared in the dispatch log — so an `echo` with a task-row `COMPLETED` status still shows `impl`.
- **`skills/site-view/public/index.html`**
  - New `.phase-chip` CSS rule with five category modifiers: `.cat-impl` (blue), `.cat-fix` (orange), `.cat-review` (purple), `.cat-security` (red), `.cat-assess` (green). Neutral is the base rule (grey). Chip style matches the existing `.skipped-chip` — 7 px, 1-2 px padding, uppercase.
  - `ensureCard()` innerHTML now includes `<span class="phase-chip" style="display:none"></span>` between `.repo` and `.metrics`.
  - `applyState()` per-character update block: sync `textContent`, swap class list to `phase-chip cat-{category}`, show/hide on `phaseLabel && status !== 'queued'`.

### CSS class hierarchy

```
.card
  .char-label
    .name          (agent name)
    .repo          (short repo)
    .phase-chip    (NEW — one of:)
      .phase-chip.cat-impl       blue
      .phase-chip.cat-fix        orange
      .phase-chip.cat-review     purple
      .phase-chip.cat-security   red
      .phase-chip.cat-assess     green
      .phase-chip                grey (neutral fallback)
    .metrics .combined
    .skipped-chip  (existing)
```

### Sample card (text rendering)

```
┌──────────────────┐
│    [SVG body]    │
│                  │
│ spring-boot-api… │  ← .name
│  publisher       │  ← .repo
│    ┌────────┐    │
│    │ FIX-R1 │    │  ← .phase-chip.cat-fix  (orange)
│    └────────┘    │
│   44k · 3:11     │  ← .metrics (shown on done/working)
└──────────────────┘
```

### Live-run verification

`/state.json` against `2026-04-16-122519-book-content-upload` (the run that prompted this polish round):

| char       | status  | phaseLabel      | category   |
|------------|---------|-----------------|------------|
| pip        | done    | requirements    | neutral    |
| archie     | done    | arch            | neutral    |
| yara       | done    | spec            | neutral    |
| crit       | done    | review          | review     |
| shield     | done    | security        | security   |
| bruno      | done    | fix-r1          | fix        |
| bruno-2    | done    | fix-r1          | fix        |
| bruno-3    | working | fix-r1          | fix        |
| pixel      | done    | fix-r1          | fix        |
| echo       | done    | impl            | impl       |
| stratos    | done    | fix-r1          | fix        |
| stratos-2  | done    | fix-r1          | fix        |
| judge      | queued  | (no chip)       | —          |
| mira       | queued  | (no chip)       | —          |
| scribe     | queued  | (no chip)       | —          |
| sage       | queued  | (no chip)       | —          |

The backoffice-service implementer (`bruno-3`) shows `working + fix-r1` — the exact state the user was previously unable to distinguish from "initial Phase 5 implementation".

### Edge cases

- **No dispatch-log entry yet, non-queued status**: e.g. `echo` had an `Implementation Tasks` `COMPLETED` row but never appeared in the dispatch log. The fallback to `c.phase` (which is `'5'` for task-row characters) maps to `impl` so the chip still appears.
- **Queued preseeded chars**: deliberately suppressed — they're in the queue zone and a chip would just add noise. The chip only appears once the orchestrator has actually dispatched the role.
- **Bare `5.5-fix` with no `-rN` suffix**: falls through to the `fixRoundByRole` counter so the first fix round shows `fix-r1` (not a bare `fix`). `fix → review → fix` round transitions bump to `fix-r2`.
- **Unknown phase strings**: pass through the raw trimmed value with category `neutral` (defensive — never hide a row the orchestrator wrote).
- **Mid-tick category change** (e.g. `impl → fix-r1`): `applyState` overwrites `phase-chip.className` each tick, so the colour transitions with the text.

### Constraint compliance

- Round 6 queue pre-seeding: untouched. Preseeded queued chars still have `phaseLabel === undefined` and render without a chip.
- Round 7 grid layout / polish rounds: `phase-chip` is a static inline-block element inside the existing `.char-label` flow — it doesn't affect card width / queue step / finished-grid packing.
- Existing tokens/duration metrics display: unchanged. Chip sits BETWEEN `.repo` and `.metrics`, so the metrics line still displays under the chip.
- Subtlety: 7 px font, 1-2 px padding, uppercase — same silhouette as the skipped chip so it visually harmonises.

### Tests

- `_test_preseed.js` still passes 25 / 25. Preseed chars (queued state) get no chip as intended.
- Ad-hoc `mapPhaseToLabel` coverage against 15 phase strings (`1` … `7`, `5a-d`, `5.5`, `5.5-fix`, `5.5-fix-r1`, `5.5-fix-r2`, `5.75`) — all match the expected `{label, category}`.
- Parser against the live `2026-04-16-122519-book-content-upload` scratchpad — 16 characters, `phaseLabel` present on all 12 non-queued chars, suppressed on the 4 queued chars.

---

## Polish round 8 follow-up — per-character phase sequence

### Problems

**P1 — character identity mismatch.** Round 8 keyed `latestPhaseByRole[role]` by role only. In the `2026-04-16-122519-book-content-upload` run, `stratos-2` (notifications-service) and `stratos` (ops-platform) both have role `stratos`. `stratos`'s `5.5-fix` dispatch bled through to `stratos-2` — the notifications card showed `fix-r1` even though it never ran a fix round, and it inherited ops-platform's tokens/duration too.

**P2 — latest-only chip hid progression.** An agent that did `impl` then `fix-r1` showed only the most recent chip. The whole point was to see progression over time.

### Fix

1. **Resolve each dispatch-log row to a specific character id (not just a role).** The Agent column's parenthetical carries the repo token: `"cdk-stack-implementer (ops-platform)"`, `"spring-boot-api-implementer (backoffice-service PRIMARY)"`, etc. New helper `extractRepoFromAgent()` grabs the first whitespace-separated token inside the parens; new helper `repoMatches()` does a loose substring match against each character's `shortRepo()`-normalised `repo` field. Fallback order, per dispatch row:
   1. Match `{role + repo}` → exact character (e.g. `ops-platform` → `stratos`, not `stratos-2`).
   2. Match `{role}` only → first character of that role (covers round-descriptor parentheticals like `(Q&A round)` / `(re-review)` that aren't repos).
2. **Replace `latestPhaseByRole` with `phasesByCharId`**, an ordered list of `{label, category}` per character id. Phase-sequence sources (in append order):
   1. Phase Status row creates the char → push the phase's mapped chip (e.g. pip → `requirements`, crit → `review`, shield → `security`).
   2. Implementation Tasks row creates the char → push `{impl, impl}` (task rows are always phase 5).
   3. Dispatch Log row resolves to a char → push mapped phase, dedup consecutive duplicates (so pip's 3 phase-1 rows collapse to one `requirements` chip, not three).
3. **Per-character fix-round counter.** `fixRoundByCharId` replaces the old `fixRoundByRole` so `stratos` and `stratos-2` can each independently reach their own `fix-r1` without bumping each other.
4. **Emit `phases: string[]`, `phaseCategories: string[]`, `activePhaseIndex: number`** on each character. `activePhaseIndex = status === 'working' ? phases.length - 1 : -1` — the in-progress chip is always the rightmost and only highlighted when the char is actively running.

### File:line refs

- **`skills/site-view/server.js`**
  - `extractRepoFromAgent()` + `repoMatches()` helpers — added immediately below `mapPhaseToLabel` (lines ~404–432).
  - `pushPhaseChip(phasesByCharId, charId, label, category)` — dedup-aware append helper (lines ~434–443).
  - `parseScratchpad()` — declares `phasesByCharId` + `fixRoundByCharId` at the top (lines ~538–551).
  - Phase Status loop — pushes the mapped phase label for non-queued rows (lines ~574–577).
  - Implementation Tasks loop — pushes `impl` whether the row replaces a preseed or creates a new char (lines ~684–686, ~700–702).
  - Dispatch Log loop — resolves `targetCharId` by (role, repo) fuzzy match + role-only fallback, then `pushPhaseChip` with per-char bare-fix round counter (lines ~737–772).
  - Per-character resolution — emits `phases` / `phaseCategories` / `activePhaseIndex`; keeps `phaseLabel` / `phaseCategory` populated from the last entry for backward-compat with any snapshot consumers (lines ~862–894).

- **`skills/site-view/public/index.html`**
  - New `.phase-chip-list` container + `.phase-chip.active` modifier CSS (lines ~602–635). `.active` = `outline: 1px solid var(--accent)` + small box-shadow.
  - `ensureCard()` swaps the single `<span class="phase-chip">` for `<span class="phase-chip-list">` (line ~1229).
  - `applyState` per-char block rebuilds the chip children from `c.phases[]` + `c.phaseCategories[]`, tags the `activePhaseIndex` child with `.active` when `status === 'working'`, and caches a signature in `dataset.signature` so the DOM isn't rebuilt on every SSE tick (lines ~1341–1375).

### Repo-extraction regex

```js
function extractRepoFromAgent(agentName) {
  const m = String(agentName || '').match(/\(([^)]+)\)/);
  if (!m) return null;
  const first = m[1].trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}
```

Takes the first whitespace-separated token inside the parens, so:

| Agent column text                                             | Extracted |
|---------------------------------------------------------------|-----------|
| `spring-boot-api-implementer (backoffice-service PRIMARY)`    | `backoffice-service` |
| `cdk-stack-implementer (ops-platform)`                        | `ops-platform` |
| `react-feature-implementer (frontend)`                        | `frontend` |
| `dal-product-owner (Q&A round)`                               | `q&a` (won't match any char repo → falls through to role-only) |
| `solution-architect` (no parens)                              | `null` (role-only fallback) |

`repoMatches()` does loose substring match in both directions, so `frontend` (from dispatch log) matches `pms-frontend` (char repo from Implementation Tasks' `abvi-pms-frontend` after `shortRepo()`).

### Verification output from `/state` (book-content-upload run)

```
pip          | status=done     | repo=-                      | phases=["requirements"]
archie       | status=done     | repo=-                      | phases=["arch"]
yara         | status=done     | repo=-                      | phases=["spec"]
crit         | status=done     | repo=-                      | phases=["review"]
shield       | status=done     | repo=-                      | phases=["security"]
judge        | status=queued   | repo=-                      | phases=[]
bruno        | status=done     | repo=auth-service           | phases=["impl","fix-r1"]
bruno-2      | status=done     | repo=publisher-service      | phases=["impl","fix-r1"]
bruno-3      | status=done     | repo=backoffice-service     | phases=["impl","fix-r1"]
pixel        | status=done     | repo=pms-frontend           | phases=["impl","fix-r1"]
mira         | status=queued   | repo=-                      | phases=[]
echo         | status=done     | repo=backends-mock          | phases=["impl"]
stratos      | status=done     | repo=ops-platform           | phases=["impl","fix-r1"]
stratos-2    | status=done     | repo=notifications-service  | phases=["impl"]
scribe       | status=queued   | repo=-                      | phases=[]
sage         | status=queued   | repo=-                      | phases=[]
```

Every expected outcome from the task spec holds:

- `stratos-2` (notifications-service): `["impl"]` — no phantom `fix-r1` any more.
- `stratos` (ops-platform): `["impl", "fix-r1"]` — impl from task row, fix from dispatch-log `(ops-platform)` match.
- `bruno-3` (backoffice): `["impl", "fix-r1"]` — `(backoffice-service PRIMARY)` extracts as `backoffice-service` and matches only bruno-3. (Current scratchpad has it `done`; when it was `working`, `activePhaseIndex` would have been `1`.)
- `echo` (mock): `["impl"]` — task row only, no dispatch log row.
- `pixel` (frontend): `["impl", "fix-r1"]` — `(frontend)` matches `pms-frontend` via substring.
- `bruno` (auth) + `bruno-2` (publisher): `["impl", "fix-r1"]` — exact `(auth-service)` / `(publisher-service)` matches.

Queued chars (judge, mira, scribe, sage) correctly render an empty `phases[]` (the UI suppresses the list entirely).

### Edge cases

- **Phase Status IN_PROGRESS → working.** Phase Status still seeds the initial chip for non-queued statuses; e.g. a `yara` currently working shows `[spec]` with `.active` highlight.
- **Dispatch rows with round descriptors instead of repos** (e.g. `(Q&A round)` / `(re-review)` / `(final doc)`). `extractRepoFromAgent` returns the first token of the parenthetical; when `repoMatches` doesn't find a char whose repo contains/is contained by that token, we fall through to role-only and assign to the first char of the role. Correct for the canonical single-character roles (pip, archie, yara, crit, judge).
- **Consecutive-duplicate dedup.** `pushPhaseChip` drops a phase whose label equals the list's last entry — so pip's three phase-1 dispatches collapse to one `requirements` chip, not three.
- **Empty `phases` on queued chars.** Guards in both Phase Status push (`status !== 'queued'`) and Implementation Tasks push (`status !== 'queued'`) plus the `c.status !== 'queued'` check in `applyState` ensure queued characters never render the phase-chip-list — the queue zone stays clean.
- **Fallback for dispatch-only chars.** If a char lands with an empty `phasesByCharId[id]` but has a non-queued status and a `c.phase` field, we render a single chip derived from `c.phase` (defensive — covers preseeds promoted purely via dispatch promotion).
- **Backward compatibility.** `c.phaseLabel` / `c.phaseCategory` are still populated from the last phase entry, so any older `/state` consumer still sees the single-chip data (just alongside the new arrays).
- **DOM thrash guard.** `phaseListEl.dataset.signature` caches `label/category/active` for every chip; the DOM is rebuilt only when the signature changes, so a char that's sat at `["impl","fix-r1"]` for several SSE ticks doesn't cause repeated reflows.

### Files touched

- `skills/site-view/server.js` — added helpers (`extractRepoFromAgent`, `repoMatches`, `pushPhaseChip`); replaced `latestPhaseByRole` / `fixRoundByRole` with per-character `phasesByCharId` / `fixRoundByCharId`; rewired dispatch-log loop to resolve target char by repo, push ordered phase chips; emits `phases`, `phaseCategories`, `activePhaseIndex` (and keeps `phaseLabel` / `phaseCategory` for backward compat).
- `skills/site-view/public/index.html` — added `.phase-chip-list` container CSS + `.phase-chip.active` modifier (outline using `var(--accent)` + subtle box-shadow); swapped the single phase chip for a list in `ensureCard`; rewrote `applyState` per-char block to iterate `phases[]`, apply category classes, and highlight the active chip when `status === 'working'`. Signature cache prevents per-tick DOM thrash.
- `docs/design/site-view-notifications-history.md` — this section.
