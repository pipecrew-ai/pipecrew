## Phase B1: Domain Interrogation (3 questions — name was already captured in Pre-phase 0)

**Incremental mode** (`discover_mode == incremental`): **skip the three questions.**
Adding repos doesn't change the domain. Load `workspace` + `domain` from the
existing `config.json` and reuse them verbatim; offer the one-line confirmation in
`{plugin_dir}/rules/incremental-discovery.md` § "Phase B1" (`yes` proceeds, `edit`
amends the stored values for the Phase B2 config merge). Then go straight to Phase
B2.0. The full-mode questions below run only in `full` mode.

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

**Optional follow-up: known upstream dependencies (Part 2 — external_dependencies)**

After the three required questions, if this is a non-trivial workspace (more than one repo, or the user mentioned consuming external platforms), offer one optional question:

```
4. **Known upstreams** (optional — press Enter to skip): Does this workspace
   depend on any OTHER PipeCrew workspace or external domain? If yes, list
   them by name and what the dependency is.
   (e.g., "payments domain — we pull their transaction events",
   "user-service workspace — SSO / identity provider")
```

If the user provides upstreams, record each one as an `external_dependencies` edge with:
- `target_id`: leave as `"dom_TBD"` (the peer's real id is unknown at interview time)
- `relation`: infer from the description (`upstream` for providers the workspace consumes, `peer` for mutual dependencies, `child` if this workspace owns a sub-domain)
- `resolution.kind`: `"absent"` (the edge is a declaration; resolve is Part 3)
- `resolution.expected_name`: the user's string (record it so Phase B2 can note it in config)

If the user skips, record nothing — **absence of the array is completely silent** (EC-4). The question is low-friction opt-in; never block or re-ask.

Store captured upstreams in the scratchpad's `## Domain Answers` section so Phase B2 can write them into `config.json`'s `external_dependencies[]` array when building the config. If none were captured, omit the array entirely from config.

Do NOT ask about:
- Tech stack — already detected in Phase A
- Entities — architect discovers from code in B2
- API design — not the user's job
- Deployment — discovered from infra repo

**Update scratchpad**: write answers to `## Domain Answers` in `scratchpad.md` (including any captured upstreams). Set Phase B1 status to COMPLETED. Set Current Phase to "B2.0. Per-repo Discovery".
