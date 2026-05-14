# Feature: {{FEATURE_NAME}}

## Overview

{{FEATURE_OVERVIEW_PARAGRAPH}}

| Property | Value |
|---|---|
| Module path | `src/features/{{MODULE_DIR}}/` |
| Routes | {{ROUTES_LIST}} |
| Required role(s) | {{REQUIRED_ROLES}} |
| Backend services | {{CONSUMED_SERVICES}} |
| i18n namespace(s) | {{I18N_NAMESPACES}} |

## User Flows

{{USER_FLOWS}}

<!-- agent-updatable -->

## Pages

{{PAGES_TABLE}}

## Key Components

{{KEY_COMPONENTS_TABLE}}

## Custom Hooks (feature-local)

{{LOCAL_HOOKS_TABLE}}

## Translation Keys

{{TRANSLATION_KEYS_TABLE}}

<!-- /agent-updatable -->

<!-- human-owned -->

## State Management

{{STATE_OVERVIEW}}

## Permissions Logic

{{PERMISSIONS_LOGIC}}

## Edge Cases

{{EDGE_CASES_LIST}}

## What NOT to Do

{{WHAT_NOT_TO_DO_BULLETS}}

<!-- /human-owned -->

<!--
AGENT INSTRUCTIONS (strip these comments before writing the final file):

This is the canonical shape for features/{feature}.md. Copy this template,
rename to a lowercase-dashed feature name (e.g., publisher-dashboard.md,
book-upload.md, alc-book-reviewer.md), and fill the placeholders.

ONE file per feature MODULE under src/features/ (or equivalent), not per
view. If a feature has 5 sub-pages, all 5 go in this file under "Pages".

- {{FEATURE_NAME}}: human-readable feature name (e.g., "Publisher Dashboard",
  "Book Upload", "ALC Book Reviewer").
- {{FEATURE_OVERVIEW_PARAGRAPH}}: 2-3 sentences naming what this feature
  does and who uses it.
- {{MODULE_DIR}}: directory under src/features/ (e.g., publisher,
  book-upload, alc-book-reviewer).
- {{ROUTES_LIST}}: comma-separated list of routes owned by this feature.
- {{REQUIRED_ROLES}}: roles required to access this feature.
- {{CONSUMED_SERVICES}}: list of api-clients/{service}.md files this
  feature consumes.
- {{I18N_NAMESPACES}}: top-level keys in the locale files used by this
  feature.
- {{USER_FLOWS}}: bulleted list of the main user journeys (e.g., "Publisher
  uploads books → reviews validation → submits for approval").
- {{PAGES_TABLE}}: AGENT-UPDATABLE markdown table Path | Component | File
  columns.
- {{KEY_COMPONENTS_TABLE}}: AGENT-UPDATABLE markdown table Component |
  Purpose | File columns. Cover the load-bearing components.
- {{LOCAL_HOOKS_TABLE}}: AGENT-UPDATABLE markdown table Hook | Purpose |
  File columns.
- {{TRANSLATION_KEYS_TABLE}}: AGENT-UPDATABLE markdown table Key | EN |
  AR (or whatever languages) columns. Skip if the feature has no UI text.
- {{STATE_OVERVIEW}}: any feature-local context, hook, or state pattern.
- {{PERMISSIONS_LOGIC}}: per-action permission rules (e.g., "Publisher
  can only edit their own books"; "Manager can approve at any time").
- {{EDGE_CASES_LIST}}: known edge cases this feature handles (empty
  states, error states, race conditions).
- {{WHAT_NOT_TO_DO_BULLETS}}: feature-specific prohibitions.
-->
