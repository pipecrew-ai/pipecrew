---
name: brainstorm
description: "Brainstorm what to build — one skill, two modes. `greenfield`: no onboarded workspace yet → ideate a brand-new project and produce a PROJECT_BRIEF (same path as /discover --greenfield). `feature`: an onboarded workspace exists → read its platform.md and diverge into a ranked set of feature options (a FEATURE_BRIEF) to hand to the product-owner. Auto-detects the mode from what's on disk and confirms with the user when ambiguous. Standalone — dispatches the base product-brainstormer agent and presents the result."
---

# /brainstorm

A single entry point for ideation. It resolves the workspace root, auto-detects whether you're starting a **brand-new project** (greenfield) or **ideating features for an already-onboarded workspace** (feature), and dispatches the base `product-brainstormer` agent in the resolved mode.

- **Greenfield** → the agent runs its greenfield path and produces a `PROJECT_BRIEF` (identical to `/discover --greenfield`'s brainstorm step). From here you'd typically run `/scaffold` then `/discover`.
- **Feature** → the agent reads the workspace's `platform.md` and diverges into a ranked set of feature options (a `FEATURE_BRIEF`), recommends 1–2, and hands off to the product-owner (via `/deliver`).

This skill only **brainstorms**. It does not scaffold, onboard, or write requirements — it dispatches the brainstormer and presents its brief.

## Usage

```
/brainstorm [idea or theme]
/brainstorm --greenfield [idea]
/brainstorm --feature [theme] [--workspace=<slug>]
/brainstorm --workspace=<slug> [theme]
```

### Arguments
- free text: for greenfield, a rough one-liner of what to build; for feature, the area/theme to ideate in. Optional — the skill will prompt if absent.

### Flags
| Flag | Effect |
|------|--------|
| `--greenfield` | Force greenfield mode (brand-new project), even if a workspace exists. Skips auto-detect. |
| `--feature` | Force feature mode (ideate on an onboarded workspace). Skips auto-detect. Requires a resolvable workspace. |
| `--workspace=<slug>` | Target a specific onboarded workspace (implies feature mode). Required when more than one workspace exists and mode is `feature`. |

### Examples
```
/brainstorm                                    # auto-detect from what's on disk
/brainstorm a habit tracker for developers     # greenfield if no workspace, else confirms
/brainstorm --greenfield a habit tracker       # force new-project ideation
/brainstorm --feature improve the upload flow   # ideate features on the onboarded workspace
/brainstorm --workspace=my-saas payments        # feature ideation on a named workspace
```

## Instructions

### Step 0: Resolve the workspace root

Run `node {plugin_dir}/scripts/workspace-root.js --get` to get `{workspace_root}` (this reuses the same resolution `/discover` and `/deliver` use — env var → plugin config → default). Do NOT prompt to configure it here; if it's unset the resolver returns the default and no workspaces will be found (→ greenfield).

### Step 1: Enumerate onboarded workspaces

List the immediate subdirectories of `{workspace_root}/`. A directory is an **onboarded workspace** iff it contains `config.json` AND `context/platform.md`. Collect the matching slugs.

### Step 2: Resolve the mode (auto-detect + confirm)

| Situation | Mode |
|-----------|------|
| `--greenfield` passed | `greenfield` (skip the rest of this table) |
| `--feature` or `--workspace=<slug>` passed | `feature` (resolve the workspace per Step 3) |
| No onboarded workspace found | `greenfield` |
| Exactly one onboarded workspace, and the user's text clearly targets it | `feature` |
| One or more onboarded workspaces exist, but the user may mean a brand-new separate project | **ambiguous → confirm (Step 2a)** |

**Step 2a — single confirmation question (only when ambiguous).** When a workspace exists but it's unclear whether the user wants to ideate on it or start something new, ask **exactly one** question, then proceed:

```
Found an onboarded workspace: {slug}.

Do you want to:
  [f]eature  — brainstorm new features for {slug}
  [g]reenfield — brainstorm a brand-new, separate project

(f / g)
```

Do not ask more than this one question to disambiguate mode.

### Step 3: Resolve the workspace (feature mode only)

- `--workspace=<slug>` passed → use it; verify `{workspace_root}/{slug}/config.json` + `context/platform.md` exist, else report and stop.
- Exactly one onboarded workspace → use it.
- **Multiple onboarded workspaces and no `--workspace=`** → ask which one (list the slugs). This is the only other prompt the skill makes.

### Step 4: Dispatch + present

Load `phases/phase-brainstorm.md` and follow it — it dispatches `product-brainstormer` with the resolved `MODE:` and presents the brief.

## PHASE FILES

Each phase lives in its own file. Load only the active phase.

| Phase | File |
|-------|------|
| Brainstorm (dispatch + present) | `phases/phase-brainstorm.md` |

## Edge cases

- **EC-1 — no onboarded workspace, no idea given** → greenfield mode; prompt the user for the one-liner (`What do you want to build? Give me a rough idea — I'll ask follow-ups.`) before dispatching.
- **EC-2 — multiple onboarded workspaces** → ask which workspace, or honor `--workspace=<slug>` (Step 3).
- **EC-3 — ambiguous (workspace exists, user may mean a new project)** → the single confirm prompt in Step 2a (feature / greenfield), then proceed.
- **EC-4 — anti-bleed** is enforced inside the `product-brainstormer` agent itself: `feature` mode grounds every option in `platform.md` and proposes no greenfield rewrites; `greenfield` mode assumes no existing platform. This skill just picks the mode; the agent holds the guardrails.

## See also

- [`agents/product-brainstormer.md`](../../agents/product-brainstormer.md) — the dual-mode agent this skill dispatches
- [`skills/discover/phases/phase-greenfield-brainstorm.md`](../discover/phases/phase-greenfield-brainstorm.md) — the greenfield brainstorm step inside `/discover` (same agent, `MODE: greenfield`)
- [`templates/blocks/block-schemas.md`](../../templates/blocks/block-schemas.md) — schema for the `FEATURE_BRIEF` block emitted in feature mode
- [`scripts/workspace-root.js`](../../scripts/workspace-root.js) — the shared workspace-root resolver used in Step 0
