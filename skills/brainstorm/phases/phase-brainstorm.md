## Phase Brainstorm: Dispatch + Present

Runs after the SKILL.md resolved `{workspace_root}`, the `MODE` (`greenfield` | `feature`), and — in feature mode — the target `{slug}`.

### Step 1: Gather the seed

- **greenfield**: if the user gave no idea, ask once:

  ```
  What do you want to build? Give me a rough idea — I'll ask follow-ups.
  ```

- **feature**: if the user gave no theme, ask once:

  ```
  What area or goal do you want to explore features around in {slug}?
  ```

Don't over-interrogate here — the agent does the real questioning. One prompt at most.

### Step 2: Dispatch the product-brainstormer

Dispatch the base `product-brainstormer` agent via the Agent tool. **The first line of the prompt is the `MODE:` line** — this is what selects the agent's path.

**subagent_type**: `pipecrew:product-brainstormer`
**description**: `"Brainstorm — {mode} — {slug-or-'new'}"`

**Greenfield prompt:**

```
MODE: greenfield

Turn this idea into a PROJECT_BRIEF. Ask clarifying questions in rounds
(one round at a time), propose a stack and repo topology, and produce the
brief using the delimited <!-- BEGIN PROJECT_BRIEF --> format. Iterate
until I approve.

Idea: {user's one-liner}
Workspace name: {name if the user gave one, else omit}
```

**Feature prompt:**

```
MODE: feature

An onboarded workspace exists. Diverge into a ranked set of DISTINCT feature
options grounded in the platform, recommend 1-2, and hand off to the
product-owner. Do NOT write FR/EC, API design, or UX — options only.

workspace_root: {workspace_root}
slug: {slug}
platform.md: {workspace_root}/{slug}/context/platform.md
theme: {user's theme, if any}

Read {workspace_root}/{slug}/context/platform.md (and
{workspace_root}/{slug}/context/audit-findings.md + platform.md § Open
Questions if present) first. Produce the delimited
<!-- BEGIN FEATURE_BRIEF --> block.
```

The agent asks questions — relay them to the user and pass answers back with **SendMessage to continue the SAME agent** (do NOT spawn a new brainstormer per round).

### Step 3: Present the brief

When the agent returns an approved brief:

- **greenfield** — show the `<!-- BEGIN PROJECT_BRIEF -->` content. Point the user at the next step:

  ```
  Brief ready. To turn this into real repos + an onboarded workspace:
    /scaffold --from-scratch --brief=<save-path>   # create repo skeletons
    /discover <parent-dir>                          # onboard them
  ```

  Offer to save the brief to `{workspace_root}/{slug}/brief.md` if a slug/name is known (mirrors `/discover`'s greenfield Step 3), otherwise print it for the user to save.

- **feature** — show the ranked options and the recommendation prose, then surface the `<!-- BEGIN FEATURE_BRIEF -->` recommendation. Point the user at the hand-off:

  ```
  Recommended: {OPT-N titles}. To turn a chosen option into requirements and ship it:
    /deliver <the feature you picked>

  (/deliver's product-owner writes the FR/EC — the brainstormer stopped at options.)
  ```

Do not scaffold, onboard, or write requirements from this skill — presenting the brief and naming the next step is where `/brainstorm` ends.
