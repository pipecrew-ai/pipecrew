## Phase B1: Domain Interrogation (3 questions — name was already captured in Pre-phase 0)

The project name was already collected in Pre-phase 0 (used to create the scratchpad dir). Do NOT re-ask it. Ask only the three remaining questions. The opener should echo the name back for confirmation so the user can catch a typo without another round-trip:

```
Domain details for {workspace.name}. Three quick questions:

1. **Domain in one sentence**: What does it do?
   (e.g., "Arabic-language book publishing and review platform")

2. **User roles**: Who uses it? List the roles.
   (e.g., Publisher, Manager, Reviewer, Admin)

3. **Languages + RTL**: Which UI languages, and is RTL needed?
   (e.g., "English + Arabic, yes RTL" or "English only, no RTL")
```

From these answers + Pre-phase 0 name, derive:
- `workspace.name` = name from Pre-phase 0
- `workspace.slug` = kebab-case of the name (lowercase, non-alphanum → `-`, truncate to 20 chars)
- `domain.name` = same as `workspace.name`
- `domain.domain_notes` = answer 1
- `domain.user_roles` = answer 2 (split by comma)
- `domain.i18n_languages` = answer 3 (parse language codes)
- `domain.rtl_support` = true if RTL mentioned in answer 3

**If the user corrects the name in their answer** (e.g., "Actually it's called X, not Y"), treat that as a name-change request: update the scratchpad, rename the workspace directory if the slug changes, and re-confirm before proceeding.

Do NOT ask about:
- Tech stack — already detected in Phase A
- Entities — architect discovers from code in B2
- API design — not the user's job
- Deployment — discovered from infra repo

**Update scratchpad**: write answers to `## Domain Answers` in `scratchpad.md`. Set Phase B1 status to COMPLETED. Set Current Phase to "B2.0. Per-repo Discovery".
