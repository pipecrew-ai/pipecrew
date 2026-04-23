---
name: UI Prototype Notes
type: project
date: 2026-04-11
---

# DAL Pipeline UI — Gamification Prototype

## Concept

A web dashboard that visualizes agent work as cartoon characters. Gamification approach: each pipeline agent is a chibi-style SVG character with a distinct personality, role, and animation tied to their work state.

## Prototype Locations

Seven variants covering different visual-style approaches. All are single self-contained HTML files (no build step). Open each in a browser to compare.

| File | Style | Approach | Deps | Best for |
|------|-------|----------|------|----------|
| `index.html` | Chibi cartoon | Hand-coded inline SVG | None (offline) | Simple, recognizable, zero deps |
| `polished.html` | Chibi cartoon in landscapes | Hand-coded inline SVG + scene switcher + feedback bubbles | None (offline) | Rich state system, landscapes, approval gates |
| `dicebear.html` | Varies (bottts/lorelei/pixel-art/etc) | DiceBear HTTP API | Internet | Unique deterministic avatars from names, one-line integration |
| `pixel.html` | 8-bit retro | Hand-coded SVG pixel grids | None (offline) | Retro game feel, nostalgic aesthetic |
| `peeps.html` | Hand-drawn sketchy | Hand-coded rough SVG (Open Peeps-inspired) | None (offline) | Warm, friendly, organic feel |
| `doodles.html` | Doodle notebook | Hand-coded rough SVG (Open Doodles-inspired) | None (offline) | Playful, unique action poses per character, notebook-paper background |
| `blueprint.html` | Technical wireframe | Hand-coded thin-stroke SVG, monospace, grid bg | None (offline) | Lean engineering aesthetic, dimension lines, meta-fit for a pipeline tool |
| `lottie.html` | Animated JSON shapes | lottie-web from CDN + procedural JSON | Internet (CDN) | Complex motion, After Effects workflow |
| `threejs.html` | 3D rendered | Three.js procedural geometry | Internet (CDN) | High wow-factor, orbit camera, 3D depth |

### Which to open first
- **Simplest comparison** — open `index.html` and `polished.html` side by side
- **See style variety** — open `dicebear.html` and cycle the style dropdown (bottts, lorelei, notionists, pixel-art, adventurer, micah, big-ears, avataaars, fun-emoji)
- **Most immersive** — open `threejs.html`, drag to orbit, click a character

## Landscape Edition (polished.html)

### Scene switcher
Four buttons in the header switch between environments:
- **🏢 Office** — desks, computers, whiteboard, window with sun, potted plant
- **🌳 Park** — grass, sky gradient, clouds drifting, sun, mountains, trees, pond with bobbing ducks, bench, path, flowers
- **🏗️ Site** — sunset sky, distant city silhouette, crane, scaffolding, half-built brick wall, stacked bricks, wheelbarrow, traffic cones
- **🎼 Orchestra** — stage with red curtains and gold valance, wooden floor with planks, spotlight gradient, conductor's podium, music stands, floating musical notes

Body background transitions between scenes using CSS gradient transition.

### Orchestra instrument assignments
In orchestra scene, each character is placed in the section matching their role and holds an instrument:

| Character | Instrument | Section | Rationale |
|-----------|-----------|---------|-----------|
| **Pip** (PO) | Baton (conductor) | Podium, front-center | Sets the tempo for everyone, first to speak |
| **Archie** (Architect) | Violin (1st chair) | Strings, front | Concertmaster — leads the ensemble |
| **Mira** (UX) | Cello | Strings, front | Warm, flowing, bridges melody and bass |
| **Yara** (Spec) | Harp | Strings, front | Elegant, every note precisely placed |
| **Echo** (Mock) | Clarinet | Winds, middle | Mimics other voices — echo metaphor |
| **Pixel** (Frontend) | Flute | Winds, middle | Expressive melody line on top |
| **Crit** (Reviewer) | Oboe | Winds, middle | Precise, cuts through everything |
| **Stratos** (Infra) | French Horn | Brass, middle | Big, atmospheric, holds the air |
| **Judge** (Assessor) | Trombone | Brass, back | Deep, authoritative, final voice |
| **Bruno** (Backend) | Timpani | Percussion, back | Foundation, rhythm, power |

Orchestra positioning is a classical semicircle: conductor on podium, strings in front, winds middle, brass + percussion at back.

### Character positions
Each of the 10 characters has a dedicated x,y position per scene (`POSITIONS` object in the script). Characters are placed contextually — e.g., Stratos (infra) is elevated in the park/site scenes to stay on-theme with "lives in the clouds".

### States
Each character can be in one of five states via CSS class toggling:
- **idle** (default) — gentle bob animation on the char-body group
- **working** — faster bob + shake + `work-fx` props become visible (tool icon, sparkle, etc.) + pulsing yellow status dot appears above head
- **done** — celebrate animation (jump + scale)
- **blocked** — grayscale + shake
- **needs-feedback** — character does a questioning bob, a white speech bubble with "Help?" appears above them, header flashes amber, and a subtle beep plays via WebAudio

Per-character working FX are defined in the `fx:` function of each character — e.g., Archie gets a mini blueprint panel, Bruno gets sparkles, Yara gets a magnifying glass.

### Feedback mechanism ("agent calls you")
When an agent hits an approval gate or needs input, it enters `needs-feedback` state via `requestFeedback(id, context)`. The bubble says "Help?" and is clickable. Clicking the bubble calls `respondToFeedback(id)`, which:
1. Removes feedback state → transitions to working
2. Adds an acknowledgement line to the live feed
3. After 1.5s, the character transitions to done

**In the demo pipeline**: Pip and Archie both hit feedback gates (requirements approval + tech design approval). The pipeline pauses with `waitForFeedbackResponse(id)` until the user clicks the bubble. The Run Demo button shows "⏸ Waiting for your feedback..." while paused.

**Manual trigger**: "💬 Simulate Feedback Request" button picks a random character and puts them in feedback state with a random context ("approve requirements draft", "confirm spec changes", etc.).

**Notification**: when `requestFeedback` fires, the header flashes amber (3 pulses) and a WebAudio oscillator plays a single 660Hz beep for 300ms. If audio is blocked by the browser, the visual flash still works.

### Animated scene props
- Clouds drift across the park scene
- Ducks bob on the pond
- Character SVGs use `animation` CSS classes like `.anim-sway`, `.anim-float`, `.anim-spin`

### Side panel
- Demo Pipeline button (same 22-step sequence as v1, works in any scene)
- Selected Agent detail card (name, role, description, quote, 4 stats)
- Live Feed showing agent messages with color-coded left border per character

### Technical notes
- Single HTML file, no dependencies
- SVG viewBox 1400×780 with `preserveAspectRatio="xMidYMid slice"` so the scene fills the stage proportionally
- Characters are rendered via JS at scene-switch time — the `renderScene()` function builds the full SVG content by concatenating the scene background + character group markup
- Character SVG bodies are defined as functions `(color, skin) => svgString` so colors can be templated
- State transitions use CSS classes on the `.character` element

---

## Characters

| Character | Role | Animation | Personality |
|-----------|------|-----------|-------------|
| **Pip** | Product Owner | bob | Amber beret + notepad. Turns vague ideas into precise requirements. |
| **Archie** | Solution Architect | float | Blue square glasses + blueprint. Sees the full system. |
| **Yara** | Spec Editor | scan | Teal lab coat + magnifying glass. Precise and meticulous. |
| **Bruno** | Backend Implementer | hammer (wrench spins) | Amber hard hat. Builds fast and solid. |
| **Pixel** | Frontend Implementer | bounce | Purple paint splatters + paintbrush. Brings designs to life. |
| **Mira** | UX Consultant | sway + floating wireframe | Pink elegant. Makes the user experience feel effortless. |
| **Echo** | Mock Implementer | colorshift body + tongue | Green chameleon. Mirrors whatever the real API does. |
| **Stratos** | Infra/DevOps | float on clouds + lightning | Cyan. Keeps everything running at altitude. |
| **Crit** | Reviewer | tap (red pen animates) | Red stern expression. No bug escapes unnoticed. |
| **Judge** | Assessor | gavel animates + scoreboard | Purple robe + wig. Delivers the final verdict. |

---

## Technical Implementation

- **Pure SVG** — all characters hand-crafted with basic shapes (circle, rect, polygon, path, line)
- **CSS animations** — `bob`, `float`, `sway`, `bounce`, `hammer`, `scan`, `pulse`, `tap`, `colorshift`, `gavel`, `blink`
- **Status dots** — idle (gray), working (amber pulse), done (green), blocked (red)
- **5-column grid layout** — dark gaming aesthetic (`#0d1117` background)
- **Click to inspect** — character detail panel with name, role tag, description, personality quote, 4 stats
- **Demo pipeline** — "Run Demo Pipeline" button triggers 19-step timed sequence, animating all characters through pipeline states with live feed output

---

## Demo Pipeline Sequence (19 steps)

1. Pip activates (requirements phase)
2. Pip done
3. Archie activates (architecture phase)
4. Archie done
5. Yara activates (spec editing)
6. Yara done
7. Bruno + Echo + Stratos activate in parallel (implementation)
8. Pixel activates (frontend)
9. Mira activates (UX)
10. Pixel done
11. Mira done
12. Bruno done
13. Echo done
14. Stratos done
15. Crit activates (review)
16. Crit done
17. Judge activates (assessment)
18. Judge done
19. All clear, pipeline complete

---

## Potential Enhancements

### Interactivity
- Clickable phase labels to expand agent output logs
- Progress bars per character during working state
- Hover tooltips on status dots

### Real Data Integration
- Read `~/.claude/dal-pipeline/active.md` scratchpad
- Map pipeline phase → character state in real time
- Show actual agent output snippets in live feed
- Auto-refresh while pipeline is running

### Visual Polish
- Add more working micro-animations (Archie drawing on blueprint, Pip writing in notepad)
- Character speech bubbles during active state
- Success confetti on pipeline complete
- "Blocked" state with X mark and red flash

### Architecture
- Extract characters to JSON config (name, svg, animations, stats)
- Pipeline state machine driving character states
- WebSocket or file-watch for live updates from `active.md`
- Embed in Claude Code output somehow (or as a local web app)

---

## Design Decisions

- **Chibi style** — chosen over flat icons for personality and memorability
- **SVG only** — avoids image dependencies, fully portable
- **Dark theme** — gaming aesthetic fits the "pipeline as a game" framing
- **Per-role animation** — idle animation matches the character's job (Bruno hammers, Echo shifts colors)
- **No frameworks** — vanilla HTML/CSS/JS, zero build step, opens anywhere
