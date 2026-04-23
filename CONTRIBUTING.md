# Contributing to feature-pipeline

## Adding a new tech stack

The plugin supports any tech stack by adding an implementer agent (and optionally a reviewer agent).

### Step 1: Create the implementer agent

Create `agents/{stack}-implementer.md`. Follow this structure:

```markdown
---
name: {stack}-implementer
description: "Implements features in a {Stack} / {Language} project..."
tools: Read, Write, Edit, Glob, Grep, Bash
model: sonnet
---

You are a {Stack} implementer...

## How you are launched
(task-file-first instruction)

## Invariants
1. Read CLAUDE.md first
2. Spec is the contract
3. Work in the worktree
4. Every endpoint needs a test

## Process
1. Orient — read repo, spec, existing code
2. Plan — list files to create/modify
3. Types/Models — match the spec
4. Data layer — migrations, ORM
5. Service layer — business logic
6. Controller/Router — endpoints
7. Tests — unit + integration
8. Report

## Things that will bite you
(4-6 stack-specific gotchas)

## You are not done until
(checklist)
```

Key requirements:
- Must start with "Read CLAUDE.md" — this is how the agent learns repo-specific conventions
- Must enforce spec-first typing — field names match the OpenAPI spec exactly
- Must include a "Things that will bite you" section with real failure modes
- Must include a "You are not done until" checklist

### Step 2: Create the reviewer agent (optional)

Create `agents/{stack}-reviewer.md`. Must include the machine-readable findings block:

```markdown
## Machine-readable findings list

<!-- BEGIN FINDINGS -->
critical | {title} | {file}:{line} | {problem}
<!-- END FINDINGS -->
```

This block is parsed by the orchestrator to create task files for fix rounds.

### Step 3: Register in SKILL.md

Add your stack to the TYPE_TO_AGENT mapping in `skills/deliver/SKILL.md` rule #9:

```
| `{stack}` | `{stack}-implementer` | `{stack}-reviewer` |
```

### Step 4: Add detection to `/discover`

In `skills/onboard/phases/phase-a.md`, add a sentinel file entry:

```
| {sentinel file pattern} | `{stack}` |
```

### Step 5: Test

1. Create a test workspace with a repo of your stack
2. Run `/discover` — verify your stack is detected
3. Run `/deliver` on a simple feature — verify the implementer works
4. Run `/review` — verify the reviewer produces findings

## Plugin structure

```
feature-pipeline/
├── .claude-plugin/plugin.json    ← plugin metadata
├── agents/                       ← finished, domain-agnostic agents
├── skills/
│   ├── deliver/              ← main pipeline skill (split into phases/)
│   ├── onboard/                  ← workspace initialization
│   ├── review/                   ← standalone code review
│   ├── assess/                   ← standalone assessment
│   ├── context-refresh/          ← agent-context audit/refresh
│   └── pipeline-view/            ← live browser dashboard
├── templates/                    ← skeletons filled by /discover
│   ├── agents/                   ← domain-aware agent templates
│   ├── agent-context/            ← repo-level doc templates
│   ├── workspace-config.*.json   ← config schema + example
│   ├── repo-CLAUDE.md.template
│   └── platform.md.template
└── scripts/
    └── validate-config.js        ← workspace config validator
```

## Conventions

- Agent files: `{stack}-{role}.md` (e.g., `nestjs-implementer.md`)
- Skill files: `skills/{name}/SKILL.md` with `phases/` subdirectory if large
- Templates: `*.template` extension, `{{DOUBLE_BRACE}}` placeholders
- Zero external dependencies — pure Node stdlib for scripts
- All agents use `model: sonnet` except security-consultant (opus) and reporter (haiku)
