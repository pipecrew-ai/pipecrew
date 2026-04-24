## Phase Greenfield: Brainstorm + Scaffold

This phase runs **before Phase A** when either:
- The user passed `--greenfield`, OR
- Phase A's repo scan found zero repos AND the user confirmed they want to start from scratch

It produces a PROJECT_BRIEF and (optionally) scaffolds repos, so the rest of onboarding has something to work with.

### Step 1: Confirm greenfield mode

If triggered by empty scan (not explicit flag), ask:

```
No repos found in {parent_dirs}.

Start a greenfield project? I can:
1. Brainstorm the idea with you
2. Scaffold repo skeletons based on what we decide
3. Continue with the normal onboarding flow

[y]es / [n]o / provide different parent_dir
```

If no, stop onboarding and suggest `/discover <correct-dir>`.

### Step 2: Dispatch product-brainstormer

Ask the user for their one-liner:

```
What do you want to build? Give me a rough idea — I'll ask follow-ups.
```

Dispatch `product-brainstormer` via the Agent tool:

```
Use the product-brainstormer agent to turn this idea into a PROJECT_BRIEF.

Idea: {user's one-liner}
Workspace name: {workspace name from pre-phase 0}

Ask clarifying questions in rounds. Produce the brief using the delimited format. Iterate until I approve.
```

The agent will ask questions — relay them to the user, pass answers back with SendMessage to continue the existing agent. Do NOT spawn a new brainstormer per round.

### Step 3: Save the brief

When the brainstormer returns an approved brief, extract the `<!-- BEGIN PROJECT_BRIEF -->` section and save to:

```
{workspace_root}/{slug}/brief.md
```

**Update scratchpad**: add a "Greenfield" row to Phase Status with COMPLETED. Note the brief path.

### Step 4: Offer to scaffold

Show the brief's **Recommended repo topology** and ask:

```
The brief proposes {N} repos:
{list from topology}

Options:
1. Scaffold from scratch (creates empty repo skeletons + git init + baseline CLAUDE.md)
2. Scaffold from an example repo (clone structure from an existing project you like)
3. Skip scaffolding — I'll create the repos myself and re-run /discover later
```

### Step 5a: Scaffold from scratch

If option 1, invoke the `scaffold` skill:

```
/scaffold --from-scratch --brief={workspace_root}/{slug}/brief.md --parent={parent_dir}
```

Parse the `<!-- BEGIN SCAFFOLDED_REPOS -->` block from the output. Those paths feed into Phase A's repo list — skip Phase A's directory scan and use these paths directly.

### Step 5b: Scaffold from example

If option 2, ask for source:

```
Path or git URL of the repo to use as a template?
(e.g., ~/projects/my-existing-nextjs-app or https://github.com/user/repo)
```

For each repo in the brief's topology, invoke:

```
/scaffold --from-example --source={source} --target={parent_dir}/{repo-name} --name={repo-name}
```

Parse outputs. Feed paths into Phase A.

### Step 5c: Skip

If option 3, stop onboarding and tell the user:

```
Saved the brief to {workspace_root}/{slug}/brief.md

When your repos are ready, run:
  /discover {parent_dir}

The brief will be picked up automatically if the workspace slug matches.
```

### Step 6: Continue to Phase A

Set scratchpad Current Phase to "A. Repo Discovery" with a note "repos pre-populated from greenfield scaffolding". Phase A's Step 1 (scan) is skipped — jump to Step 2 (detect tech stack) using the scaffolded paths.

---

## Hand-off to Phase A

The SCAFFOLDED_REPOS block gives you:
- absolute path per repo
- tech stack (already detected, since scaffold wrote it)
- role

Write these into the scratchpad's `## Discovered Repos` table. Phase A Step 6 (present and confirm) still runs — the user can still correct type/role before onboarding continues.
