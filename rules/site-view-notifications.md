# Site-view notifications — unmissable "waiting" states

This document describes how every "paused, waiting for user" state — whether from the pipeline's own gates or Claude Code's own tool-approval prompt — is surfaced in the site-view UI with a distinct banner, a persistent audible peep, and a flashing tab title.

> **Scope of this file**: the current architecture (banners, hook config, permissions, gotchas). The iterative polish-round log that built up to this state is in [`docs/design/site-view-notifications-history.md`](../docs/design/site-view-notifications-history.md).

## Scope

Two independent "paused" sources are now surfaced the same way:

| Source                        | Flag file                            | Banner        | Who writes it                   |
|-------------------------------|--------------------------------------|---------------|---------------------------------|
| Pipeline gate (approval/clarify/fix-round) | `{run_dir}/awaiting_input.json`      | **Yellow**    | `scripts/gate.js open/close` (orchestrator) |
| Claude Code tool-approval prompt           | `{run_dir}/awaiting_claude_approval.json` | **Orange**    | `scripts/notify-hook.js` via Claude Code hook |

Both banners share: persistent 4-second beep via Web Audio, stronger pulsing glow, flashing `⏸` tab-title prefix.

## Files changed

### New

- **`scripts/notify-hook.js`** — Claude Code hook invoked on `Notification`, `UserPromptSubmit`, and `PostToolUse`. Writes / clears `awaiting_claude_approval.json` in every active run dir (any run under `{workspace_root}/*/runs/deliver/*/` whose `scratchpad.md` was modified within the last hour). Always exits 0 so hook errors never break Claude Code's normal flow.

### Modified

- **`skills/site-view/server.js`**
  - New `awaitingClaudeApprovalPath()` + `readClaudeApproval()` helpers (mirror of the existing `awaitingInputPath` / `readAwaitingInput` pair).
  - `getState()` now also returns `claudeApproval` alongside `awaitingInput`.
  - `fs.watch` + `fs.watchFile` now also track `awaiting_claude_approval.json`.
  - `noScratchpadYet` fallback state includes both flags so the banner surfaces even before a scratchpad is created.

- **`skills/site-view/public/index.html`**
  - New `.claude-approval` banner (orange palette) mirroring `.awaiting-input`.
  - Pulse animation upgraded from border-only to border + box-shadow glow + brightness (`awaiting-pulse-strong`, `claude-pulse-strong`).
  - `@media (prefers-reduced-motion: reduce)` disables pulse but keeps a static glow — audio is still the primary cross-monitor signal.
  - New `.sound-enable` pill inside both banners — one click unlocks the AudioContext and persists the consent in `localStorage`.
  - New `playBeep()` / `startBeeping()` / `stopBeeping()` using Web Audio API — synthesizes a 880→660 Hz chirp every 4 s (`BEEP_INTERVAL_MS`). No external audio asset.
  - New `setPausedState(paused)` fed by `isPaused = !!(waiting || claudeApproval)` — drives both audio and tab-title flashing from a single flag so overlapping banners don't cause double-peeps.
  - Tab title now flashes between `⏸ {base}` and `{base}` every 2 s (`startTitleFlash` / `stopTitleFlash`).
  - Ticker now updates both `#ai-since` and `#ca-since` every second so the "waiting Xs" counters keep climbing even without SSE updates.

### User settings

- **`~/.claude/settings.json`** — added:
  - `permissions.allow` entries to auto-approve `gate.js` without a prompt (see below).
  - `hooks.Notification`, `hooks.UserPromptSubmit`, `hooks.PostToolUse` pointing at `notify-hook.js`.

## `permissions.allow` entries added

```jsonc
"permissions": {
  "allow": [
    "Bash(node */pipecrew/scripts/gate.js *)",
    "Bash(node **/pipecrew/scripts/gate.js *)",
    "Bash(node * feature-pipeline/scripts/gate.js *)",
    "Bash(node */scripts/gate.js open *)",
    "Bash(node */scripts/gate.js close *)"
  ]
}
```

**Why multiple variants?** Claude Code's `Bash(...)` matcher compares against the full command string. Orchestrator agents invoke `gate.js` from a variety of working directories using either absolute Windows paths, forward-slash POSIX paths, or quoted paths. The five variants cover:

1. `node <abs-path>/pipecrew/scripts/gate.js open …` — standard absolute invocation (matches with single `*` before path).
2. Same with deeper prefix (`**` glob tolerates more path segments).
3. Quoted / whitespace-bracketed form (`node "…" feature-pipeline/scripts/gate.js`).
4. Narrower fallback scoped to any `scripts/gate.js open …` (in case plugin ever lives under a non-feature-pipeline path).
5. Same as 4 for `close`.

The pattern intentionally requires `feature-pipeline/scripts/gate.js` in the path so arbitrary other `gate.js` files on disk are NOT auto-approved. Placing the rule in the **user-level** `~/.claude/settings.json` means it applies to every project without repetition and survives plugin upgrades as long as the plugin directory still contains `feature-pipeline/scripts/gate.js`.

## Hook config added

```jsonc
"hooks": {
  "Notification": [
    { "matcher": "*", "hooks": [{ "type": "command",
      "command": "node \"…\\feature-pipeline\\scripts\\notify-hook.js\" on-notification" }] }
  ],
  "UserPromptSubmit": [
    { "matcher": "*", "hooks": [{ "type": "command",
      "command": "node \"…\\feature-pipeline\\scripts\\notify-hook.js\" clear" }] }
  ],
  "PostToolUse": [
    { "matcher": "*", "hooks": [{ "type": "command",
      "command": "node \"…\\feature-pipeline\\scripts\\notify-hook.js\" clear" }] }
  ]
}
```

**Event coverage**:

- **`Notification`** — Claude Code fires this when it sends a user notification. The hook script filters payload text for "permission", "approval", "waiting", "needs your" to avoid false-positives on non-approval notifications. If the message text is empty or ambiguous, the flag is still written (better a false banner the user clears in one second than a silent miss).
- **`UserPromptSubmit`** — user answered (or typed anything); clear the flag.
- **`PostToolUse`** — a tool successfully ran; if permission was the blocker, it's granted now, clear the flag.

### Caveat about the hook API

Claude Code's official hook API (as of writing) **does not** expose a dedicated "waiting for approval" event. The `Notification` event is the closest available signal and is officially documented to fire "when Claude sends notifications". In practice, tool-permission prompts *are* notifications on Claude Code's side, but if Anthropic changes that behaviour the hook may miss some events — in that case, a future iteration could fall back to the `PreToolUse` event with the `permissionDecision: "ask"` output-pattern (see `hook-development/SKILL.md`).

The `notify-hook.js` script reads stdin permissively (JSON or raw string) and never fails the hook even if parsing fails — this keeps Claude Code's main conversation flow unaffected by any bug in the hook.

## Testing each behaviour in isolation

### 1. `gate.js` auto-approval

With a live Claude Code session open:

```bash
# In any project, from Claude's bash tool:
node ~/.claude/plugins/marketplaces/local/pipecrew/scripts/gate.js \
  open --run-dir={workspace_root}/{slug}/runs/deliver/<run-id> \
       --phase=3 --gate=approval \
       --question="Test gate — auto-approved?"
```

Expected: **no** "approve this Bash command?" prompt from Claude Code on first run of the session. The flag file appears in the run dir immediately. `gate.js close --run-dir=<same>` also runs silently.

### 2. Claude-approval banner

Run the existing simulator and manually create the flag:

```bash
# Launch site-view pointed at a fake run dir (see simulate-run.js)
node ~/.claude/plugins/marketplaces/local/pipecrew/scripts/simulate-run.js

# In a second shell, write the claude-approval flag manually
cat > /path/to/run_dir/awaiting_claude_approval.json <<'JSON'
{
  "since": "2026-04-16T18:00:00Z",
  "tool": "Bash",
  "command_preview": "rm -rf /tmp/scratch",
  "message": "Claude Code is waiting for your approval"
}
JSON
```

Expected: orange banner appears within ~1 s (SSE update from fs.watch). Delete the file → banner disappears.

**End-to-end test of the hook**: trigger a genuine Claude-Code permission prompt in the active session (e.g., run any un-allowed Bash command). The orange banner should appear on every active site-view UI. Approve → banner clears within ~1 s of the approval.

### 3. Audio + pulse

With either banner visible:

1. First visit: banner shows a **"🔔 Click to enable sound"** pill. Click it — one initial beep plays, localStorage key `pipelineview.sound-enabled=1` is set, and the pill hides on both banners.
2. Subsequent beeps fire every 4 seconds until the banner is removed.
3. Reload the page — sound is still enabled (localStorage persists), first peep fires immediately on banner visibility.
4. Confirm tab-title flashes between `⏸ …` and `…` every 2 s (visible in the browser tab list).
5. Toggle OS-level "reduce motion": pulse animation stops but banner remains boldly highlighted; audio still peeps.

## Gotchas

- **Browser autoplay policy**: Chromium and Firefox both block `AudioContext` creation until the page has received a user gesture. The pill resolves this — there's no way to auto-play sound without a click. The pill is cheap to dismiss (one click per origin, ever).
- **Settings precedence**: Project-level `.claude/settings.local.json` entries take precedence over user-level `~/.claude/settings.json` for permissions, but the allow-list is **additive** — a narrower user-level rule can't be overridden by the project level. So the gate.js allow rules work regardless.
- **Hook cold-start**: Claude Code loads hooks on session start. Changes to `~/.claude/settings.json` require a **`claude` restart** to take effect. Confirm loaded hooks via `/hooks`.
- **Hook cost**: the `PostToolUse` hook fires on **every** tool call. The script is a single `fs.readdirSync` + optional `unlink` of ~50 bytes — well under 50 ms. No blocking I/O, no network calls.
- **Multiple active runs**: the hook writes the flag to *every* active run dir simultaneously. If you have two `/deliver` runs in different workspaces both open in separate browser tabs, both will light up when Claude Code asks for permission. This is intentional — there's no reliable way from inside the hook to know which run's session triggered the prompt.
- **Windows path quoting**: the hook command in `settings.json` uses double-backslash-escaped Windows paths. On macOS/Linux, the corresponding entry should use forward-slash paths and POSIX-style quoting.

