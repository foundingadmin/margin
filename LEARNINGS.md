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

---

## Data model

**Page identity is `origin + pathname`** (lowercased, trailing slash trimmed; query/hash dropped). Non-http falls back to host. The planned evolution is a **`sources[]` set of full URLs** per note — the one structural fork that unlocks merge, multi-URL association, and provenance. Treat it as a migration when it lands.
