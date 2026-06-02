## Phase B3: Design System Discovery (only if frontend repo exists)

**Skip if**: no repo in the config has `role: "frontend"`. Proceed directly to Phase C.

**Design-system output location — per-repo, not workspace-wide.** Each frontend repo gets its own `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` because different frontend repos often use different component libraries (e.g., publisher-frontend on MUI, admin-portal on Ant Design). Storing at the workspace level would overwrite when the second frontend is processed. If a repo already has `agent-context/common/DESIGN_SYSTEM.md` (hand-written by the team), the discovery agent uses refresh semantics — read + merge, never destroy-and-rewrite.

**Step 1: Detect design system presence**

Run the following for each frontend repo (all signals at once per repo):

```bash
cd {frontend.path} && (
  grep -q "storybook\|@storybook" package.json 2>/dev/null && echo "HAS_STORYBOOK" || echo "NO_STORYBOOK"
  test -d .storybook && echo "HAS_STORYBOOK_DIR" || true
  grep -q "\"@mui\|\"antd\|\"@radix\|\"@chakra\|\"@mantine" package.json 2>/dev/null && echo "HAS_COMPONENT_LIB" || echo "NO_COMPONENT_LIB"
  find src -maxdepth 3 -name "tokens.*" -o -name "theme.*" -o -name "design-tokens.*" 2>/dev/null | head -3
)
```

**Step 2: If design system signals found** → dispatch a discovery agent:

**Tool**: `Agent`
**description**: `"Design system discovery — {frontend-repo-name}"`
**prompt**:

```
Read the frontend repository at {frontend.path}. Start with CLAUDE.md if it exists.

Discover the design system and answer these questions with specific file paths and component names:

1. COMPONENT LIBRARY: which one? (MUI, Ant Design, Radix, Chakra, Mantine, custom, none)
   - Version? (e.g., MUI v5 vs v6 matters for API)
   - Import pattern? (e.g., `import { Button } from '@mui/material'`)

2. STORYBOOK: does it exist?
   - Path to stories directory
   - How many components have stories?
   - Run `ls {storybook_dir}` to list available stories

3. DESIGN TOKENS: where are colors, spacing, typography defined?
   - File path (e.g., `src/theme/tokens.ts`, `tailwind.config.js`)
   - Token format (CSS vars, JS object, Tailwind classes)

4. ESTABLISHED UI PATTERNS: read 3-4 existing feature pages and identify:
   - How tables are built (which component, pagination pattern)
   - How modals/dialogs are built (which component, open/close pattern)
   - How forms are built (controlled vs uncontrolled, validation library)
   - How navigation/routing works

5. COMPONENTS TO AVOID: search for comments like "deprecated", "do not use",
   "broken", "TODO: replace". Also check if any imported components have known
   RTL issues (common: Drawer, Tooltip positioning, icon direction).

6. CUSTOMIZATION LEVEL: does the team use library components as-is, or wrap
   them in custom abstractions? (check for a `components/ui/` or `components/common/` 
   directory with thin wrappers)

Output format — structured, not narrative:

## Design System Report: {repo-name}

### Component Library
- Name: {name} v{version}
- Import pattern: `{example}`

### Storybook
- Available: yes/no
- Path: {path}
- Component count: {N}

### Design Tokens
- Location: {file path}
- Format: {CSS vars / JS object / Tailwind}
- Key tokens: {list 5-6 most-used: primary color, spacing unit, font family}

### Established Patterns
| Pattern | Component used | Example file |
|---------|---------------|-------------|
| Data tables | {component} | {path} |
| Modals/dialogs | {component} | {path} |
| Forms | {approach} | {path} |
| Navigation | {pattern} | {path} |

### Components to Avoid
| Component | Reason | Alternative |
|-----------|--------|------------|
| {name} | {why} | {use instead} |

### Customization Level
- {as-is / thin wrappers / heavy customization}
- Wrapper directory: {path or "none"}
```

**After the agent returns**: save the report to `{repo_path}/agent-context/common/DESIGN_SYSTEM.md`.

**Write semantics:**
- If `{repo_path}/agent-context/common/` does not exist yet, create it first (`mkdir -p`).
- If `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` does not exist, write the agent's output verbatim.
- If the file already exists (hand-curated by the team), show a diff and ask:
  ```
  {repo-name}/agent-context/common/DESIGN_SYSTEM.md already exists.
  (o) Overwrite — replace with what B3 discovered
  (m) Merge — dispatch a refresh pass that merges new findings into the existing file
  (s) Skip — keep the existing file untouched
  ```
  Default is **(s) Skip** if the user doesn't answer — hand-curated content is load-bearing, never silently clobber it.

**Why repo level**: each frontend uses its own component library / tokens. The UX consultant agent called during `/deliver` Phase 5b receives `repo_path: {frontend.path}` and reads the design system from that repo, so the file must live with the repo it describes.

**Step 3: If NO design system signals found** → ask the user:

```
Frontend repo "{repo-name}" has no detected design system
(no Storybook, no component library, no design tokens).

Options:
  (a) Continue without — UX consultant will recommend components
      based on what already exists in the codebase
  (b) Note as a gap — add "no established design system" to
      platform.md Known Constraints so agents are aware

Choose (a) or (b):
```

- **(a)**: write a minimal `{repo_path}/agent-context/common/DESIGN_SYSTEM.md` stating: "No design system detected. Recommend components based on what exists in the codebase. Do not assume any component library is available — check before recommending." This ensures the UX consultant always has a file to read at `{repo_path}/agent-context/common/DESIGN_SYSTEM.md`.
- **(b)**: same as (a), plus append to `{workspace_root}/{slug}/context/platform.md` under `## Known Constraints`: "No established design system in {repo-name}. Components are ad-hoc. Consider establishing a component library + Storybook before scaling the frontend."

**Update scratchpad**: Set Phase B3 status to COMPLETED. Set Current Phase to "C. Generation".
