# Handoff: New Instance modal — Refract-brand redesign

## Overview
A redesign of the launcher's **New Instance** dialog so it matches the Refract brand
(website + in-app look) instead of the old flat cyan / pixel-font version. Same fields
and behaviour as today — name, Minecraft version, snapshots toggle, mod loader, memory,
group, and the Import ZIP / MultiMC-Prism / Create actions — restyled in the violet
brand system with a live instance-card preview.

## About the design files
The files in this bundle are **design references created in plain HTML/CSS/JS** — a
working prototype showing the intended look and behaviour. They are **not** meant to be
dropped into the app as-is. The task is to **recreate this design inside the existing
Refract launcher codebase** (Electron + React, per the website copy) using its current
components, styling approach, state, and version/Java services. Reuse the launcher's
existing modal shell, form primitives, and theme variables where they exist; only add
new styles where the design introduces something the codebase doesn't already have.

The backdrop (a blurred launcher screenshot) in the prototype is **only demo framing** —
in the real app this modal opens over the actual running launcher, so ignore the
`.scene::before` / `logo/screenshot.png` backdrop entirely.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and interactions are final.
Recreate the UI to match, mapping the tokens below onto the codebase's existing theme
system (the launcher already ships light/dark themes and a purple accent — prefer those
variables over hardcoding).

---

## Screen: New Instance dialog

### Purpose
Let the user configure a new Minecraft instance (name, version, loader, memory, group)
and create it, import a ZIP, or import from MultiMC / Prism. A left-hand card previews
how the instance will look in the library, updating live as fields change.

### Layout
- **Dialog**: centered modal, `width: min(880px, 100%)`, `max-height: calc(100vh - 64px)`,
  `border-radius: 18px`, 1px border, large soft shadow. Vertical flex: header / body / footer.
- **Header** (`padding: 20px 22px`, bottom border, subtle top-down surface gradient):
  iris logo (34×34) · title block (title + mono subtitle) · close button (right).
- **Body**: CSS grid `grid-template-columns: 266px 1fr`. Collapses to a single column
  under 720px (preview moves above the form with a bottom border instead of right border).
  - **Left — Live preview** (`padding: 22px 20px`, surface-2 bg, right border): a mono
    "LIVE PREVIEW" label, the instance card, then a helper sentence.
  - **Right — Form** (`padding: 22px 24px 4px`): vertical flex, `gap: 18px` between fields.
- **Footer** (`padding: 16px 22px`, top border, surface-2 bg): `Cancel` (left) · flexible
  spacer · `Import ZIP` · `MultiMC / Prism` · `Create` (right).

### Components

**Iris logo** — the Refract mark (6 rotated diamonds + dark pupil). Reuse the existing app
logo component/SVG. In the prototype it's an inline `<svg viewBox="-110 -110 220 220">`;
`filter: drop-shadow(0 2px 6px var(--p-glow))`.

**Title block**
- Title "New Instance": Inter 800, 19px, `letter-spacing: -.02em`, color `--ink`.
- Subtitle "Set it up · launch in seconds": JetBrains Mono, 11.5px, uppercase,
  `letter-spacing: .08em`, color `--ink-3`.

**Close button** — 34×34, `border-radius: 9px`, transparent; hover: bg `--field-2`,
border `--border-2`, icon `--ink`. X icon 17px, stroke 2.1.

**Live-preview card** (mirrors the launcher's real instance cards)
- Card: bg `--card`, 1px `--border`, `border-radius: 14px`, `box-shadow: 0 10px 30px -18px rgba(0,0,0,.5)`.
- Thumbnail: 128px tall, flat pixel skyline placeholder (`linear-gradient(--sky-1, --sky-2)`
  sky, blocky hill silhouettes, green-topped dirt ground, a glowing accent "sun", stars).
  In the real app, use the instance's actual world/icon thumbnail here.
- Body (`padding: 13px 14px 15px`, `gap: 9px`):
  - Name: Inter 700, 15px, truncates with ellipsis.
  - Meta "Minecraft <version>": JetBrains Mono, 11.5px, `--ink-3`.
  - Row: **loader tag** (mono 10.5px uppercase, `--p-deep` text on `--p-tint` bg, 1px
    `--p-tint-2`, `border-radius: 6px`, `padding: 3px 8px`, with a 6px accent dot) +
    **RAM tag** pushed right (mono 11px `--ink-3`, `--field` bg, 1px `--border`).
- Helper text below card: 12px `--ink-3`, the instance name bolded in `--ink-2`.

**Field label** — JetBrains Mono, 11px, weight 500, uppercase, `letter-spacing: .14em`,
color `--ink-3`. Optional "(optional)" suffix is non-mono, no transform, `--ink-4`.

**Text input** (`.inp`) — full width, Inter 15px, `--ink` text, bg `--field`, 1px `--border`,
`border-radius: 10px`, `padding: 12px 14px`. Placeholder `--ink-4`. Hover: border `--border-2`.
Focus: border `--p`, `box-shadow: 0 0 0 4px var(--p-ring)`, bg `--field-2`.

**Version select** — same `.inp` styling, `appearance: none`, `padding-right: 38px`, with a
custom chevron (16px, `--ink-3`) absolutely positioned right. Options are MC versions; in
the real app populate from the existing live version picker.

**Show snapshots checkbox** — sits on the version label's right. 18px box, `border-radius: 5px`,
bg `--field`, 1.5px `--border-2`; checked: bg + border `--p`, white check icon. Label mono
11.5px uppercase `--ink-3`. Wired to filter snapshot versions into the select.

**Mod loader segmented control** (`.seg`) — `grid-template-columns: repeat(5, 1fr)`, `gap: 8px`
(repeat(3,1fr) under 560px). Each button: Inter 13px/600, `--ink-2`, bg `--field`, 1px `--border`,
`border-radius: 10px`, `padding: 10px 6px`, with a small 13px square "glyph" + label. Hover:
border `--border-2`, text `--ink`, bg `--field-2`. **Selected** (`aria-pressed="true"`): bg
`--p-tint`, border `--p`, text `--p-deep`, `box-shadow: 0 0 0 3px var(--p-ring)`, glyph fills `--p`.
Options: Vanilla (default), Fabric, Forge, Quilt, NeoForge. *(Prototype uses generic square
glyphs; swap in the real loader icons if the app has them.)*

**Memory control**
- Label row: "MEMORY" label + value readout "`<n>` GB allocated" (mono 12px, `--p-deep`, weight 600).
- Slider (`input[type=range]`): 8px track, `border-radius: 99px`, 1px `--border`. Track fill is a
  `linear-gradient` split at `--fill%` between `--p` and `--field-2`; JS sets `--fill` =
  `((value-1)/(16-1))*100%`. Thumb: 20px white circle, 4px `--p` border, drop shadow. Range 1–16, step 1.
- Presets row (`gap: 7px`, wraps): 1G / 2G / 4G / 8G / 16G. Each: flex:1, mono 12px/600, bg `--field`,
  1px `--border`, `border-radius: 8px`. Selected (`aria-pressed="true"`): `--p-tint` bg, `--p` border,
  `--p-deep` text. Clicking a preset sets the slider; dragging the slider clears/sets the matching preset.

**Group input** — standard `.inp`, placeholder "e.g. Modded, Vanilla, Survival…", optional.

**Footer buttons** (all `border-radius: 10px`, Inter 14px/600, `padding: 11px 16px`; secondary set 13px/13px):
- **Cancel** — ghost: transparent, `--ink-2`, 1px `--border-2`. Hover: `--ink`, border `--p-bright`, bg `--field-2`.
- **Import ZIP** — soft: bg `--p-tint`, text `--p-deep`, 1px `--p-tint-2`, folder icon. Hover: bg `--p-tint-2`, lift -1px.
- **MultiMC / Prism** — soft (same as above), no icon.
- **Create** — primary: bg `--p`, white text, `box-shadow: 0 8px 20px -8px var(--p-glow), 0 2px 0 rgba(0,0,0,.18)`,
  plus (+) icon. Hover: bg `--p-hover`, lift -1px; active: lift 0.

---

## Interactions & behavior
- **Live preview** updates in real time: name input → card name + helper text; version select →
  card meta; loader selection → loader tag; memory slider/presets → RAM tag + value readout.
- **Loader segmented**: single-select via `aria-pressed`; click sets pressed on one, clears the rest.
- **Memory**: slider ↔ presets stay in sync (clamp 1–16). Slider fill is driven by the `--fill`
  CSS var recomputed on every change.
- **Snapshots checkbox**: toggles whether snapshot versions appear in the version select (hook into
  the app's existing version list).
- **Theme**: in-modal toggle button (top-right of the prototype) flips `data-theme` between
  `dark`/`light` and persists to `localStorage`. In the app, hook into the launcher's existing
  theme state instead of a standalone button.
- **No entrance animation is required.** (The prototype intentionally omits the modal rise
  animation; add the app's standard modal transition if it has one.)
- **Responsive**: body switches to one column below 720px; loader grid to 3 columns below 560px.

## State management
Component state needed:
- `name: string` (default "My Instance")
- `version: string` (from live version list; default latest release, e.g. "1.21.1")
- `showSnapshots: boolean` (default false) — filters the version list
- `loader: 'Vanilla' | 'Fabric' | 'Forge' | 'Quilt' | 'NeoForge'` (default Vanilla)
- `memoryGB: number` 1–16 (default 2)
- `group: string` (optional)

Actions: **Create** (validate name + version, create instance, auto-install matching JRE),
**Import ZIP**, **Import from MultiMC / Prism**, **Cancel/close**. Theme is app-level state.

## Design tokens

Map these onto the launcher's existing theme variables — they already match the website's
system. Dark is the in-app default; light mirrors the website.

**Dark (default)**
| token | value |
|---|---|
| `--bg` | `#15101f` |
| `--card` | `#1d1731` |
| `--card-2` | `#221a3a` |
| `--field` | `#181226` |
| `--field-2` | `#1f1834` |
| `--border` | `#2d2446` |
| `--border-2` | `#3b3057` |
| `--ink` | `#f1ecfa` |
| `--ink-2` | `#c2b7da` |
| `--ink-3` | `#8d81a8` |
| `--ink-4` | `#6d6286` |
| `--p` (accent) | `#8a52ff` |
| `--p-hover` | `#9d6bff` |
| `--p-bright` | `#b693ff` |
| `--p-deep` | `#c6abff` |

**Light (website default)**
| token | value |
|---|---|
| `--bg` | `#ffffff` |
| `--card` | `#ffffff` |
| `--card-2` | `#faf8ff` |
| `--field` | `#faf8ff` |
| `--field-2` | `#f3eeff` |
| `--border` | `#e7ddf6` |
| `--border-2` | `#d9caf0` |
| `--ink` | `#220f44` |
| `--ink-2` | `#574a6e` |
| `--ink-3` | `#8a7da4` |
| `--ink-4` | `#a99dc0` |
| `--p` (accent) | `#5316D4` |
| `--p-hover` | `#6b2cf0` |
| `--p-bright` | `#8a52ff` |
| `--p-deep` | `#3d0fa3` |

**Derived (both themes)** — compute from `--p` so accent + theme compose:
- `--p-tint`   = `color-mix(in srgb, var(--p) 18%, var(--card))` (dark) / `8%, #fff` (light)
- `--p-tint-2` = `color-mix(in srgb, var(--p) 30%, var(--card))` (dark) / `16%, #fff` (light)
- `--p-glow`   = `color-mix(in srgb, var(--p) 30%, transparent)` (dark) / `14%` (light)
- `--p-ring`   = `color-mix(in srgb, var(--p) 38%, transparent)` (dark) / `28%` (light)

**Other tokens**
- Radii: dialog 18px, cards/inputs/loader buttons 14px & 10px, small chips/checkbox 6–8px / 5px.
- Card shadow: `0 10px 30px -18px rgba(0,0,0,.5)`. Modal shadow (dark):
  `0 48px 100px -34px rgba(0,0,0,.78), 0 14px 38px -16px rgba(0,0,0,.6)`.
- Type: **Inter** (400–800) for UI text, **JetBrains Mono** (400–600) for labels / meta / values.
- Spacing: field gap 18px; input padding 12×14; button padding 11×16; header 20×22; footer 16×22.

## Assets
- **Iris logo** — inline SVG in the prototype; reuse the launcher's existing logo asset
  (`logo/refract-iris.svg` exists in this project).
- **Icons** — inline stroked SVGs (close X, chevron, check, folder, plus). Replace with the
  app's existing icon set.
- **Loader glyphs** — generic squares in the prototype; substitute real Fabric/Forge/Quilt/NeoForge
  icons if available.
- No raster assets are required for the modal itself (the demo backdrop screenshot is not part of it).

## Files in this bundle
- `Refract New Instance.html` — the full hi-fi prototype (all styles + interaction JS inline).
  The `:root` / `html[data-theme=…]` blocks at the top are the source of truth for tokens.
- `ni-tweaks.jsx` — optional Tweaks panel (accent hue, theme, backdrop dim); **not** needed for
  the production build, included only to show the accent/theme is fully variable-driven.
