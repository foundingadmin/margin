# Design integration — accepting a UI package from Claude Design

How a UI design handoff lands in Margin without breaking the working extension.
Margin ships UI per feature, so this is built for **incremental, one-surface-at-a-time**
intake, not a wholesale replace.

---

## The non-negotiable constraints

Any design package must respect these, because Margin is a **Manifest V3 Chrome
extension loaded unpacked with no build step**:

1. **No build pipeline.** Chrome loads the folder as-is. There is no bundler,
   no transpiler, no `package.json`. Deliverables must be plain **HTML + CSS
   (+ vanilla JS if needed)**. React/JSX/Tailwind-class output can't run here
   without first introducing a Vite + CRX build — a separate, deliberate
   decision, not a side effect of a handoff.
2. **MV3 Content Security Policy.** No inline `<script>`, no inline event
   handlers (`onclick="…"`), no `javascript:` URLs, no remote-loaded resources.
   Behavior lives in `sidepanel.js`; markup carries `id`/`class`/`data-*` hooks
   that the JS binds to.
3. **Everything self-contained / local.** No CDN fonts, no external
   stylesheets, no remote images. If a design adds a typeface, the font files
   get committed to the repo and `@font-face`'d locally.
4. **Side-panel viewport.** The UI renders in Chrome's side panel — a tall,
   narrow column (~320–420px wide). Designs must be responsive to a narrow
   width; full-page mockups don't translate directly.
5. **Light + dark, dark by default.** `<body>` gets a `dark` class toggled by
   the theme button. Every color must be expressed as a token with a light
   value and a dark override (see below).

---

## The seam: `tokens.css`

`tokens.css` is the single source of truth for color, type, radius, and shadow,
and the **intended drop-in point** for a design handoff. It loads before
`sidepanel.css`; the rest of the CSS only references tokens via `var(--token)`.
A re-theme is, ideally, *just new values in this file*.

**Keep the token names stable** — `sidepanel.css` consumes them by name. To add
a token, add it here and use it via `var()`; don't hardcode new raw colors in
component CSS.

| Token | Role |
|---|---|
| `--bg` | app background |
| `--chrome` | top bars / toolbars |
| `--surface-2` | raised surfaces, hover fills, code blocks |
| `--ink` | primary text |
| `--muted` | secondary text / icons |
| `--faint` | placeholders, hints, disabled |
| `--border` | hairlines, input borders |
| `--accent` | brand accent (active, links, focus) |
| `--accent-soft` | accent-tinted backgrounds (active toolbar btn) |
| `--on-accent` | text/icon on an accent fill |
| `--danger` | destructive actions |
| `--shadow` | popover/menu elevation |
| `--radius`, `--radius-sm` | corner radii |
| `--ui`, `--mono` | font stacks |
| `--mn-tint` | Margin Numbers gutter row tint |

> Light values on `:root`; dark overrides on `.dark`. Every color token needs both.

---

## The DOM contract (do not silently rename)

`sidepanel.js` wires behavior to specific element IDs via `const $ = id =>
document.getElementById(id)`. **A redesign may restyle and rearrange freely, but
these IDs must survive** (or the JS must be updated in the same change — flag it
in the handoff). Renaming an ID without touching the JS silently breaks that
control.

**Structural pattern.** Three top-level views, one active at a time:
`#view-editor`, `#view-browser`, `#view-info`, each `class="view"`; the active
one also has `is-active`. View switching = toggling that class. Floating layers
(menus, popovers, slash menu) are siblings toggled via the `hidden` attribute.

**IDs the JS depends on (current inventory):**

- **Editor view:** `#view-editor`, `#open-browser`, `#new-note`, `#lock-toggle`,
  `#theme-toggle`, `#app-menu-btn`, `#title`, `#title-edit`, `#note-menu-btn`,
  `#note-menu`, `#editor`, `#counts`, `#save-status`
- **Toolbar:** `#style-trigger`/`#style-current`/`#style-menu`,
  `#size-trigger`/`#size-current`/`#size-menu`, `#color-btn`/`#color-pop`,
  `#checklist-btn`, `#plus-btn`, `#slash`, `#image-input`; rich-text buttons use
  `[data-cmd="…"]` (e.g. `bold`, `italic`, `insertUnorderedList`, `createLink`)
- **Browser view:** `#view-browser`, `#back`, `#new-note-2`, `#select-toggle`,
  `#app-menu-btn-2`, `#search`, `#sort-select`, `#note-list`, `#empty`,
  `#bulk-bar`/`#bulk-all`/`#bulk-count`/`#bulk-delete`
- **Info view:** `#view-info`, `#info-back`, `#info-title`, `#info-seg`
  (with `.seg-btn[data-tab]`), `#info-body`
- **App menu:** `#app-menu` with `button[data-act]` (`guide`, `changelog`,
  `roadmap`, `shortcut`); note menu uses `data-act` (`copy`, `export`, `pin`,
  `mnumbers`, `delete`); labels `#pin-label`, `#mn-label`
- **Dynamic list rows** (built in JS) use `.row-title` / `.row-snip`; checklists
  use `ul.checklist > li(.checked)`. Keep these class hooks if restyling rows.

State classes the JS toggles: `.is-active` (views), `.on` (`.pill-toggle` for
lock/theme), `.active` (toolbar buttons), `.checked` (checklist items),
`hidden` (menus/popovers/empty state).

---

## Component inventory (shared vocabulary with Claude Design)

Name surfaces consistently so a handoff maps cleanly to code:

- **Top bar** (`.topbar`) + **icon buttons** (`.icon-btn`), **pill buttons**
  (`.newbtn`), **pill toggles** (`.pill-toggle`, on-state for lock/theme)
- **Title row** — title input + hover rename affordance + note-actions kebab
- **Rich-text toolbar** (`.rt-toolbar`) — style dropdown, size dropdown,
  B/I/U/S, combined color+badge, list/checklist/link, insert-block, clear
- **Editor canvas** (`.editor`, contenteditable) — headings, lists, checklist,
  quote, divider, callout, toggle, code, image, link card, table; optional
  **Margin Numbers** gutter
- **Menus & popovers** (`.menu`, `.popover`, `.style-menu`, `.size-menu`,
  `.slash`) — elevated with `--shadow`, dismiss on outside click
- **Note browser** — search, sort, note-list rows, empty state, bulk-select bar
- **Info pages** — segmented tabs (release notes / roadmap), guide body
- **Status bar** (`.statusbar`) — word/char counts + save status

---

## Intake checklist (per feature)

1. **Receive** the package (tokens and/or component HTML+CSS for one surface).
2. **Tokens first.** Merge new token *values* into `tokens.css`; keep names. If
   the design needs a new token, add it and route component CSS through `var()`.
3. **Restyle, don't re-wire.** Apply markup/CSS changes while preserving the IDs
   and class hooks above. If the structure genuinely must change, update the
   matching bindings in `sidepanel.js` in the same commit and note it.
4. **Self-contained check.** No remote URLs; fonts/images committed locally.
5. **Verify in Chrome.** `chrome://extensions` → reload the unpacked card →
   exercise the changed surface in **both light and dark** at narrow width.
6. **Commit per surface** so each feature's UI lands as a reviewable change.

---

## If a handoff ever arrives as React/Tailwind

That's the one path that doesn't drop in. It would require adding a build step
(e.g. Vite + `@crxjs/vite-plugin`), which changes how the extension is loaded
and developed. Treat it as its own decision — don't let it ride in on a routine
UI handoff. The token-driven, no-build path above is the supported default.
