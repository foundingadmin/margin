# Margin — version log

## v0.13.0 — 2026-07-09

App-bar + connected-pages pass, and two editor fixes.

- **Clearer lock state** — the notepad lock now reads at a glance: **Locked** is a solid accent fill (engaged), **Unlocked** is a plain muted outline. The padlock glyph still swaps open/closed, so the state is never carried by color alone.
- **Theme toggle out of the app bar** — the dark/light button is removed from the top bar to declutter it; it'll return on the full settings page later. The theme machinery (`applyTheme` / `toggleTheme`, persisted `settings.theme`, `dark` class on load) is untouched, and the JS references are null-guarded so nothing breaks.
- **One-click "Connect this page"** — a compact **+ Connect** chip now trails the connected-pages chip row whenever the current tab isn't already in the note's set. One click unions it in — no need to open the drawer (roadmap #21). Hidden once the page is connected.
- **Closed connected band matches the chrome** — when the drawer is closed, the band now uses the raised app surface (`--chrome`), so it sits flush with the title bar above and the format toolbar below instead of reading as the editor plane.
- **Fix · margin numbers** — the gutter numerals were floating above their text lines and, for list items, colliding with the inset rail. Numbers now sit on their block's first text line (line box matched, scales with the text-size control) and all sit in one clean right-aligned gutter column, clear of the rail and bullets.
- **Fix · save indicator showed ✓ and ✕ together** — the global `svg[viewBox]` reset was out-specifying the rule that hides the inactive save glyphs, so the × leaked through next to the check. The hide rule is now scoped through `.save-status` so exactly one glyph (check / × / pulsing dot) shows per state.

## v0.12.1 — 2026-07-09

Editor accessibility pass — link contrast and a fuller text-color picker.

- **AAA link contrast** — note hyperlinks now use a dedicated `--link` token instead of the mid-tone `--accent`. The new values clear WCAG **AAA** (≥7:1) body-text contrast against the note plane: `#33517f` in light (8.0:1 on `--bg`, 7.4:1 on `--chrome`) and `#93abd1` in dark (7.8:1 on `--bg`). Splitting links off from the app accent keeps chrome/UI accents untouched. Applied to editor links, provenance/source links, and release-notes links.
- **Neutral text colors (White / Black)** — the text-color menu gains a hairline-separated **NEUTRALS** row under the six status inks, exposing white and black as selectable text colors (theme-invariant `--ink-white` / `--ink-black` tokens; no hex literals in JS). White reads as the natural emphasis ink on the dark default theme, black on light; the white swatch carries a firmer ring so it stays legible on the light menu.
- **Reset text color** — the picker's "Reset text color" control (re-applies the theme's neutral `--ink-reset`) is confirmed present alongside the new neutrals, and swatches gain a `:focus-visible` ring for keyboard users.

## v0.12.0 — 2026-07-03

Azure editor polish — a second Claude Design round for the editor surface, closing the remaining gaps between the shipped app and the Margin Prototype. Restyle plus small JS-wired hooks; no token names or DOM IDs renamed.

- **Created / edited subtitle** — a provenance line under the title ("Created Jun 24 · Edited 2m ago") reads straight off the note's `createdAt` / `updatedAt` and refreshes live as you type.
- **Format bar to spec** — a single clean row: the text-size control is now the stacked "A" glyph (its label kept for a11y, hidden visually), the color tool shows the "A"-over-warm-bar ink glyph, and a right-aligned **"/ cmd"** accent pill opens the slash menu. The redundant link (↗) and clear (⌫) buttons leave the bar — linking stays on **⌘/Ctrl+K**.
- **Brand-colored source chips** — recognized hosts (Linear, Claude, GitHub, Figma, Notion, Stripe, Reddit, Google, and more) get their brand tint + proper-cased name in the connected-pages chip row; anything unlisted keeps the deterministic hash hue.
- **Footer Margin Numbers toggle** — a **"#"** quick-toggle on the left of the status bar mirrors (and flips) the note's Margin Numbers state, alongside the ⋯-menu entry; the selection word/char count now reads as an accent pill.
- **Larger title** — the note title steps up to the prototype's 21px / 700 weight.
- **Scope** — this round covers the editor (the shown prototype). The package's Home filter-chips, Settings page, and User Guide restyle remain a later per-surface increment, per the incremental intake model in `docs/DESIGN_INTEGRATION.md`.

## v0.11.0 — 2026-07-03

Azure UI — the first large front-end update. Adopts the "Azure" brand from the Claude Design handoff and builds the net-new surfaces it locked, one reviewable commit each.

- **Azure re-theme + brand type** — `tokens.css` re-themes to the two-tier surface system (`--bg` = the lower editor plane, `--chrome` = the raised app plane), a slate-blue chrome accent, cool graphite neutrals, and new `--hairline` / `--mn-rail` / `--ok` tokens. Because the rest of the CSS reads tokens by name, the two-tier look falls out for free; a small appended override block raises the title row + format bar onto the app plane, sets body copy to weight 300, accent-tints active toggles, and pins an AA focus ring. **Hanken Grotesk** (UI + body) and **JetBrains Mono** (URLs, counts, code, gutter numerals) now ship locally under `/fonts` (variable woff2, MV3-CSP-safe) — no more system-stack fallback.
- **Connected pages** — the `sources[]` set (#4) made visible and editable. A collapsed favicon chip row (current page tinted) + a pinned count chip open a drawer: a filter joined flush to a recessed list inset, one row per page (name, "Current page" badge or click-to-open URL, hover-reveal Disconnect), plus Connect-this-page / Add-a-custom-URL. Connecting and disconnecting edit the note's source set directly. Same entry in the ⋯ menu.
- **Table of contents (#13)** — a per-note toggle reveals a translucent sticky outline bar above the editor; its frosted dropdown lists the note's headings (weight + indent hierarchy, active row highlighted) and a 2px scroll-progress bar tracks reading position, hugging the bar when closed and the menu when open.
- **Note ••• menu realignment** — reordered to the locked single-note layout with a Lucide icon per row and live accessories (source count, on/Off checks); **Pin → Favorite** (stored field unchanged); **Download** now offers **.md** alongside .html. The shipped-after-handoff rows (Note info, Show paste sources) are kept.
- **Save state** — the footer indicator moves off color-alone (brand AA): check (saved) / pulsing dot (saving) / × (save failed), each with a label; a real storage write failure now surfaces the error state instead of silently claiming "Saved".

## v0.10.0 — 2026-06-29

Provenance & capture (Roadmap Phase 3) — paste-from-page (#5) + provenance display (#6), shipped as a pair.

- **Paste-from-page (#5)** — a new command (`⌘/Ctrl+Shift+Y`, rebindable) reads the active tab's **live selection** via the `scripting` permission, opens the panel, and drops the text into the note you're **currently viewing** at the last caret position — not the page's note, not the end. Distinct from right-click capture: a plain paste rather than a blockquote+citation, and the page joins the note's `sources[]` set. The source is **certain** because it's read off the live page.
- **Provenance display (#6)** — pasted-from-page blocks carry `data-src` / `data-srchost` (and a full-URL `title`). A per-note **Show paste sources** toggle in the ⋯ menu adds a `.show-prov` class that reveals a faint *from ‹host›* line under each sourced block, with the full URL on hover. Off by default — the note reads clean until asked. The menu item only appears when the note actually holds pasted blocks.
- **Scope/decision:** only the *certain* path is tagged. Free-form `⌘V` pastes are **not** marked — the browser can't reveal the true copy source, and the roadmap flagged that as a guess. Keeping every `data-src` trustworthy beats polluting provenance with guesses.
- B4 (locked-note capture target) and B5 (insert at caret, not the end) were already handled in the panel-side capture path; paste-from-page reuses that same plumbing.

## v0.9.0 — 2026-06-29

Note info (Roadmap Phase 2, #2) — the last Phase 2 slice, built on the `sources[]` model.

- **Note info (#2)** — the note ⋯ menu gains **Note info**, a panel that surfaces a note's **source URL(s)** (the full provenance URLs, click to open in a new tab), plus its **created** and **updated** timestamps (absolute stamp, with a relative "x ago" on updated). The data already lived on every note since the `sources[]` model — this is the on-demand view of it. Notes that predate `sources[]` only carried a page path, so that's what they show.
- Closes out Phase 2 (sources[] → Merge → Note info). The remaining multiselect slice (bulk **pin**, #1) is the only Theme-1 item left.

## v0.8.0 — 2026-06-29

Merge notes (Roadmap Phase 2, #3) — the second slice of multiselect management, built on the `sources[]` model.

- **Merge (#3)** — in the all-notes **Select** mode, pick two or more notes and hit **Merge**. They fold into one: bodies stacked **newest-on-top** with a divider between each, every chunk **headed by its original title** so the pieces stay legible. The **newest note's title** becomes the merged note's own, and their **source sets union** (so the merged note surfaces on any of its pages when unlocked). Pinned if any original was; created-date is the oldest of the set.
- **Undo** — merging shows a toast with **Undo** for a few seconds; one click restores the originals. No confirmation dialog — the undo path replaces it.
- Extends the bulk-select scaffold (Select all / Clear all / Delete) from v0.4.3 with Merge alongside Delete.

## v0.7.0 — 2026-06-29

The `sources[]` model (Roadmap Phase 2, #4) — the keystone. A note's identity stops being a single page and becomes a **set of pages**.

- **Sources, not one page (#4)** — every note now carries a `sources[]` set: the **full URL(s)** it was drawn from (the provenance trail, stored but rarely shown) keyed by normalized page (origin + path, query/hash dropped) for matching (the association set — where the note surfaces when unlocked). Existing notes migrate automatically on first load; pre-change notes keep the one page they had.
- **Capture unions sources** — right-click "Save selection to Margin" into a locked note now records that page in the note's set, so a single note can span every page it borrowed from. Unlocked, it surfaces on **any** of those pages.
- Groundwork for **Merge (#3)** (union two notes' source sets) and the **Note info menu (#2)** (show a note's URLs / created / updated) — both consume this model.

## v0.6.0 — 2026-06-29

Editor wins (Roadmap Phase 1) — high-visibility, no new data model.

- **Margin Numbers (#7)** — a per-note toggle in the note ⋯ menu that numbers each block down a faint, code-editor-style left gutter, legal/hierarchical: top-level blocks `1, 2, 3`; nested list items and table rows `12.1, 12.2`. A very subtle alternating row tint shows each number's span. Strictly a live positional aid — it renumbers as you edit, not a permanent ID.
- **Text size (#10)** — a sizer in the toolbar (Small / Regular / Large / Supersize) that scales *all* styles in a note equally. It's a persisted setting (sticks across notes), placed where people expect sizing to live. Accessibility, not per-selection formatting.
- **Selection word count (#11)** — the footer shows the live word count of the current selection beside the note total.
- **Lists & indenting (#8)** — `⌘/Ctrl+]` / `[` indent and outdent lists *and* plain paragraphs (the latter now persists); a little more line-space between list items. (Tab / Shift-Tab list indent shipped earlier with B2.)
- **Rename affordance (#18)** — hovering a note's title eases in a pencil icon and tints the title toward the accent, signalling "click to rename."
- **Default to dark (#17)** — the side panel opens in dark mode on first run.

## v0.5.0 — 2026-06-29

Navigation & UX overhaul.

- **Navigation:** home/house icon for the notes list (replaces the hamburger); **+ New** pinned to a consistent position across views so it never jumps.
- **Settings gear:** app-level menu (user guide, release notes, roadmap, set keyboard shortcut) moved under a gear icon, top-right.
- **Note actions:** copy, download, pin, delete moved to a kebab on the note-title row (note-level), split apart from app-level items.
- **Combined color tool:** text color + badge share one static "square-A" tool that opens a two-section menu; the icon never recolors.
- **Sorting:** note browser sorts by last updated (default), date created, or title A–Z; the choice persists.
- **Contextual in-app title:** the in-app title bar names the current view ("All notes", "User guide", "Release notes & roadmap") instead of duplicating Chrome's app-name header.
- **In-app roadmap:** user guide is its own page; release notes + roadmap share a tabbed page. Roadmap renders from the packaged ROADMAP.md.
- **Blue icon:** a single mid-tone blue glyph (no tile, no frame) legible on light and dark surfaces; removed the runtime light/dark icon swap.
- **Default shortcut:** changed to Ctrl/Cmd+Shift+E.
- Added LEARNINGS.md to the package for fast context.


## v0.4.3 — Jun 28, 2026
- **Bulk delete** — a Select mode on the all-notes list for multi-selecting and deleting notes at once (with Select all / Clear all).
- **Checklist count** — a small tertiary `n/n` tally at the top of each checklist, updating live; checkmark centering tightened.
- **Cleaner toolbar** — text-color and badge buttons are now colorless glyphs (A with underline; knocked-out A in a solid square). Removed the separate text-highlight tool (badges cover the need) and the lightbulb from callouts.

## v0.4.2 — Jun 28, 2026
- **Bare glyph icon** — removed the colored tile. The mark now ships as transparent **black** and **white** sets (`icons/black`, `icons/white`), plus an editable `icon-source.svg`. The toolbar icon auto-switches polarity to match the browser's light/dark theme; the choice is remembered so it's correct on startup.

## v0.4.1 — Jun 28, 2026
- **New app icon** — the uploaded browser-edit glyph, set on a Margin-blue rounded tile and rendered to all required sizes (16/32/48/128, plus 256 for listings). Used for the toolbar action and everywhere Chrome shows an icon.

## v0.4.0 — Jun 28, 2026
- **Page-granular notes** — matching moved from domain to per-page (origin + path), so multiple Claude tabs, or a Google Doc vs a Sheet, each keep a distinct note. Query strings and hashes are ignored so a single page doesn't fragment. Empty notes are still never saved, so this stays clutter-free.
- **In-app Guide & Version log** — available from the ⋯ menu.
- **Wordmark** — "Margin · Side notes for the web."

## v0.3.1 — Jun 28, 2026
- **Richer auto-titles** — `Site · Page · time`, inferring a page identifier from the tab title (cleaned of brand noise), falling back to the URL's first path segment when the title is just a product name (Document vs Spreadsheets).
- **Lock semantics fixed** — locked = stays put; unlocked = follows tabs.

## v0.3.0 — Jun 28, 2026
- **Block editor** — slash menu + element library: callout, toggle, code, image, link card, table.
- Text color, highlight, badges; checklist block; Google-Docs keyboard shortcuts.
- Whitelist sanitizer hardened to preserve block markup while blocking scripts (19/19 XSS suite).

## v0.2.0 — earlier
- Rich text, tab-aware notes, the lock toggle, one-key panel open/close.

## v0.1.0 — earlier
- First cut — side-panel notepad, per-site notes, right-click selection capture.
