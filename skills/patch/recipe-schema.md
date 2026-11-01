# Patch recipe schema

A **recipe** crystallizes one decision about how to fix a class of problem into a reusable
artifact. It is BOTH a fix template (the `fix` directive an implementer follows) AND a detector
(the `match` pattern that finds its own work in `--sweep` mode).

The two halves have different audiences. The **detector** (`match`) is shared review lint:
code reviewers run it against every diff (see `rules/reviewer-common.md` Invariant 10 /
Step 5b) — new-line hits become findings citing the recipe; pre-existing hits route back
here as "run `/patch --recipe=<name>`" suggestions. The **fix template** (`fix`) stays
`/patch`-exclusive — the one exception is a `/deliver` fix round, where the orchestrator
pastes the `fix` text into the fix list for hits on the feature's own new lines.

Recipes are **workspace-scoped** — they live only at
`{workspace_root}/{slug}/context/recipes/*.yml` (one file per recipe, `name` == filename stem).
A recipe encodes a team's convention (and usually cites a workspace ADR), so it belongs to the
workspace, not the plugin. The plugin ships none. `/patch` and `/learn` grow the library over time;
a fresh workspace starts empty.

## Fields

```yaml
name: <kebab-case-id>            # required, unique within a layer
summary: <one line>              # required — what class of problem this fixes
match:                           # required — how to DETECT instances (used in --sweep and finding-match)
  globs: ["**/*.properties", "**/*.yaml"]   # files to scan (optional; default all)
  pattern: "<regex or literal>"  # ripgrep pattern that identifies a hit
  tags: [security, secret]       # free tags for finding-class matching
fix: >                           # required — the directive an implementer follows, verbatim
  <imperative, specific. Include "fix ALL copies" guidance, the exact replacement shape,
   and any ordering/edge-case rule. This is the design — write it like you'd brief an implementer.>
verify:                          # required — orchestrator-run, READ-ONLY checks (Bash)
  - "<grep/compile/synth assertion, phrased as a check>"
follow_up:                       # optional — non-code actions to surface in the report
  - "<ops / security / human action this fix implies>"
decided_in: ADR-NNN              # optional — the ADR that backs this decision
applies_to: [spring-boot, cdk]   # optional — repo types this is valid for
review_lint: true                # optional, default true — set false to keep this detector
                                 # out of code reviews (reviewers run `match` as a diff lint;
                                 # /patch --sweep is unaffected by this flag)
seen_in: []                      # appended to by /patch each time the recipe is applied
non_goals: >                     # optional — what this recipe must NOT do (scope guard)
  <e.g. "do not touch dev profiles", "do not introduce new constructs">
```

## Authoring rules
- `fix` is the load-bearing field. Be specific enough that an implementer needs no further design.
  Bake in the lessons (fix every copy, fail-closed, lazy not module-load, etc.).
- `match.pattern` must be precise enough that a `--sweep` doesn't flag false positives. Prefer the
  literal/symbol over a broad regex. This matters doubly now: reviewers run `match` as a diff lint
  on every code review, so a sloppy pattern surfaces noise in every review, not just in `--sweep`.
  If a pattern cannot be made precise, set `review_lint: false` and keep it sweep-only.
- `verify` checks are READ-ONLY. Never put a mutating command in `verify`.
- Keep one recipe per *class*. If two problems need different fixes, they're two recipes.

## Example

```yaml
name: externalize-committed-secret
summary: A credential/key/password literal is committed to source config.
match:
  globs: ["**/*.properties", "**/*.yml", "**/*.yaml"]
  pattern: "(api[-_]?key|password|secret)\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-]{16,}"
  tags: [security, secret, credential]
fix: >
  Replace the committed literal with a ${ENV_VAR} placeholder and NO default value
  (fail-closed). grep the literal repo-wide and fix EVERY copy — the caller side, and
  prod/regional twin profiles (e.g. application-prod-eu.yaml) — or the secret survives.
  Use one env-var name across all sides of a shared secret. Leave dev/test throwaway
  values alone unless they are real credentials.
verify:
  - "grep -r '<literal>' src/ returns zero hits"
  - "module compiles (mvn -q -DskipTests compile / equivalent)"
follow_up:
  - "Inject ENV_VAR into prod (+ regional twin) task defs before the next deploy (fail-closed)."
  - "Rotate the leaked value — it remains in git history."
decided_in: ADR-001
applies_to: [spring-boot, fastapi, flask, django, nestjs]
non_goals: "Do not introduce a Secrets Manager construct; match the existing ${ENV_VAR} convention."
```
