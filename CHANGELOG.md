# Margin — version log

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
