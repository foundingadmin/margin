# Margin — Learnings

*Hard-won constraints and principles, kept next to the code so any AI session (or human) can load context fast. If you discover a new gotcha while building, add it here in the same shape: the rule, then why.*

---

## UX principles

**Persistent buttons must never change location across pages.**
If a control exists on more than one view (e.g. **+ New**, the settings **gear**), it must sit in the same screen position on every view. Moving it makes muscle memory misfire and reads as two different buttons. Only *contextual nav* may differ per page — the editor's left slot is **home (house)**, the browser's left slot is **back (‹)** — because those are different actions, not the same persistent button. This is why +New and the gear are pinned to identical positions on both topbars.

**Don't duplicate Chrome's app-name header in our own UI.**
The side panel's top strip (app name, pin, close) is **Chrome-drawn and uncontrollable**. Our in-app title bar previously echoed "Margin · Side notes for the web" right under it — a double title. Fix: the in-app title slot carries a **contextual page title** ("All notes", "User guide", "Release notes & roadmap"), never the app name. Turn the constraint into wayfinding.

**Right UX signal for the right action.** A hamburger (☰) implies a slide-out menu. "All my notes" is a destination, not a menu — so it's a **home (house)** icon. Match the glyph to the mental model.

**Icon affordances over any background.** Controls that float over arbitrary content (image hover controls, etc.) must stay legible over dark, light, busy, or text-filled images. Reuse the established lock/theme toggle pattern (pill, backing, clear contrast) rather than a bare icon.

---

## Chrome / MV3 constraints

**Context-menu and side-panel-header icons come from the *static* manifest icon.** There is no theme-swap API for them (only the *toolbar action* icon can be set at runtime via `chrome.action.setIcon`). A single static glyph can't win on both a light context menu and a dark panel header — so we use a **mid-tone blue**, which is legible on both. That's why the tile/frame and the runtime light/dark icon swap were deleted: blue solves the surface problem more simply than adapting ever could.

**MV3 service workers sleep, and in-memory state is wiped on restart.** Anything that must survive across events (e.g. the per-window "is the panel open?" map used by the toggle) belongs in `chrome.storage.session`, not a module variable. This is the leading suspect for the *sporadic* toggle shortcut: on a cold wake the worker can't tell open from closed.

**`chrome.sidePanel.open()` must be called synchronously inside the user gesture.** Awaiting anything before it can invalidate the gesture token and make the open silently fail.

**No reliable programmatic close for a global side panel.** We track open panels via `chrome.runtime.connect` ports and have the worker postMessage the panel to call `window.close()`.

**Spellcheck suggestions are not exposed to JS.** The red squiggle is browser-drawn; there's no API to read its suggestions. One-click-correct would require bundling our own dictionary — explicitly scrapped.

**Fetch your own packaged files** with `fetch(chrome.runtime.getURL("FILE"))` from the panel page — same-origin, no `web_accessible_resources` needed. (Used to render ROADMAP.md in-app.)

---

## contenteditable / editor

**Tab moves *focus*, not indentation.** Default contenteditable Tab jumps focus to the next focusable element — and a toggle's `<summary>` is focusable, which is why Tab "leaps to a far-off block." Fix: intercept Tab/Shift-Tab in the editor, `preventDefault`, and run our own indent. (Folds into the Lists work.)

**Links inside contenteditable don't navigate on click** — a click just places the caret. Active citation links need either a click handler that opens the URL, or `contenteditable="false"` on the link.

**`document.execCommand` is deprecated but pragmatic** for rich text in contenteditable. Enable `styleWithCSS` so `foreColor` writes an inline `color` style (keeps the sanitizer's job simple).

**Sanitize every byte of pasted or captured HTML** through the whitelist (`ALLOWED_TAGS` / `ALLOWED_CLASSES` / `STYLE_PROPS`). Never trust clipboard or web HTML. Keep block markup (callout, checklist, badge, link-card, `data-count`) on the allow-list deliberately; strip everything else.

**Whatever `execCommand` writes inline must be on `STYLE_PROPS`, or it won't survive a save.** With `styleWithCSS` on, `indent`/`outdent` on a *non-list* block writes `margin-left` inline. That's why `⌘]`/`⌘[` indent of plain paragraphs needs `margin-left` whitelisted — list indent changes nesting (no inline style) and was always safe, but the plain-text case silently reverted until the prop was allowed.

**Margin Numbers ride CSS counters on the editor's block sequence — no DOM/markup change.** `.editor.numbered` resets `mn`; each top-level child increments it and renders `counter(mn)` in the left gutter (absolute `::before`, positioned into extra `padding-left`). Lists/tables instead reset a second `mnsub` and render `counter(mn) "." counter(mnsub)` on their `li`/`tr` — and the container's *own* number is deliberately **not** drawn, because it would collide with `n.1` on the first line. So a list is section "12" only implicitly; its rows are 12.1, 12.2. The toggle is a per-note property (`n.numbered`), applied as a class on the editor element — it lives outside the note HTML, so the sanitizer never sees it.

**Whole-note text scaling is just the editor's base `font-size`.** Headings, badges, quotes, code are all `em`-based, so one class on `.editor` (`size-small|regular|large|supersize`) scales everything proportionally. The only px holdout was `pre`, switched to `em` to come along. It's a persisted *setting* (sticks across notes), not inline formatting.

---

## Updater (`update-margin.command`)

**`git rev-parse --show-toplevel` walks UP — never adopt the result blindly.** The "update in place" path found the repo *containing* the script, but an unzipped Margin folder (no `.git`) nested under a home directory that is *itself* a git checkout resolved to the **home repo** — so the updater `git reset --hard`'d the wrong repository and never touched the extension. Guard it: adopt the discovered repo only when its `origin` remote matches `foundingadmin/margin`. Otherwise fall back to the target folder and, if that folder exists without a `.git`, convert it in place (`git init` + add origin + `fetch` + `reset --hard origin/main`) — `reset --hard` overwrites tracked files but leaves unrelated untracked files alone, and never reaches outside the folder.

**Prefer `git clone` over an unzipped download** for the synced copy: clones carry no `com.apple.quarantine` flag (so Gatekeeper doesn't block the `.command`) and are already proper checkouts (so the updater's fast path works without the in-place conversion).

## Data model

**Page identity is `origin + pathname`** (lowercased, trailing slash trimmed; query/hash dropped). Non-http falls back to host.

**Merge** *(shipped v0.8.0, #3)* folds 2+ selected notes into one: bodies joined newest-`updatedAt`-first with `<hr>` separators, each section headed by the source note's original title as an inline `<h2>` (escaped before concatenation, since note titles are plain-text — the sanitizer keeps `<h2>` and decodes the entities back to text), so even an originally-empty note still contributes a labelled section. `sources[]` unioned via `unionSourceInto()` (the array-level twin of `addSource`), newest note's **title** kept, `pinned` if any were, `numbered` from the newest, `createdAt` the oldest. Originals are **consumed** (replaced by the merged note). Instead of a `confirm()`, it shows a transient **undo toast** holding a shallow snapshot of the pre-merge `notes` array — undo is just `state.notes = snapshot; saveNotes()`. The toast is dismissed on `openNote`/`showBrowser` so it can't linger across views.

**A note's identity is a `sources[]` set** *(shipped v0.7.0, #4)*, not a single page. Each entry is `{ url, key, host, at }`: `url` is the **full** URL (provenance, rarely shown), `key` is the normalized page identity above (used for matching — the association set), `host` for the list chip / non-web fallback. A note matches context if **any** source matches; `addSource()` unions a page in (dedup by `key`, or by `host` for non-web, upgrading a migrated key-only entry to a full URL). `migrateNote()` lifts legacy `{pageKey, host}` notes on load — idempotent, runs once, saves if it changed anything; pre-change notes have only the page key as their `url` (the full URL was never stored). Merge (#3) and Note info (#2) build on this. The `pendingCapture` object from the worker still carries `pageKey`/`host` for matching, plus `url` for the new source.
