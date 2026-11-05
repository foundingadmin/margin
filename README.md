# Margin — side notes for the web (v0.3)

A fast, tab-aware notepad that lives in your Chrome side panel. Now a real block editor: slash menu, an element library, rich text, color/highlight/badges, and a checklist type.

## Install / update (unpacked)
1. Unzip `margin-extension.zip`.
2. Go to `chrome://extensions`, enable **Developer mode** (top-right).
3. **Load unpacked** → pick the folder. (Updating from a previous version? Just hit the reload ↻ on the Margin card.)
4. Open it with the toolbar icon or **⌘/Ctrl+Shift+E**.

## Stay in sync with `main` (dev)
Want to track the repo instead of re-downloading a zip? Chrome can't load an unpacked extension straight from GitHub, but this gets you one-click-close:

1. **First time**, clone the repo into your apps folder:
   ```sh
   git clone https://github.com/foundingadmin/margin.git "$HOME/Custom Apps/margin"
   ```
   Then **Load unpacked** → pick that `margin` folder.
2. **After any merge to `main`**, double-click **`update-margin.command`** in the folder (it pulls the latest and pops open `chrome://extensions` in **Comet**), then hit the reload ↻ on the Margin card.

The script clones if the folder is missing, fast-forwards to `main` if it's already a checkout, and — if you *unzipped* the folder instead of cloning (so it has no `.git`) — converts it into a checkout in place on first run. It targets the Margin repo specifically: it will refuse to touch a parent folder that happens to be some *other* git repo (e.g. a home directory that's itself a checkout). Override the location with `MARGIN_DIR=…` if you keep it elsewhere.

> **macOS blocked it?** ("Apple could not verify… Not Opened.") That's Gatekeeper quarantine on a downloaded script, not malware. Either **System Settings → Privacy & Security → Open Anyway**, or clear the flag once in Terminal: `xattr -d com.apple.quarantine "<path>/update-margin.command"`. Cloning the repo (rather than downloading a zip) avoids the quarantine flag entirely.

## Set your own keyboard shortcut
The ⋯ menu → **Set keyboard shortcut…** opens `chrome://extensions/shortcuts`. Click the row for **Open or close Margin**, press your combo (Chrome requires Ctrl/Alt/⌘ in it), and flip the dropdown to **Global** if you want it to fire even when Chrome isn't focused.

## The block editor
Type **`/`** anywhere for the element grid, or hit the **＋** in the toolbar. Partial names work — `/cod` + Enter drops a code block, `/ban` a callout. Arrow keys move, Enter or Tab inserts.

Elements: Title / Heading / Subheading, bullet · numbered · **checklist**, quote, **divider**, **callout** (banner), **toggle** (collapsible), **code**, **image** (stored locally in the note), **link card** (pulls the page's title/description/image), and **table**.

### Lines, lists & checklists
Styles and lists apply **per line**: select three lines (paragraphs or `Shift+Enter` rows), press a style or list, get three styled lines. Re-applying a style is a no-op; a list button toggles the list off again. Tab / Shift+Tab nest items in every list type (checklists too), Enter on an empty item steps out a level, and Backspace at the start of an item drops its bullet. The checklist's `done/total` meter counts sub-tasks. All of this lives in `editor-engine.js` (see the header comment there for the explode → transform → rebuild model).

### Images
- **In:** paste a screenshot or copied image, drag files from the desktop, drag an image off any web page, or right-click a web image → **Save image to Margin**. Remote images are fetched and stored inside the note (they survive the page changing).
- **Out:** hover for **Copy** (PNG) / **Download**; click an image then ⌘/Ctrl+C; drag it onto the desktop or a folder; or right-click → Save image as.
- Storage: long edge capped at 2400px. Screenshots stay lossless PNG (WebP 0.92 if heavy), photos JPEG 0.88, GIF/SVG untouched.

### Pasting
Pastes are cleaned into Margin's own styles. Google Docs / Notion / GitHub / web structure and emphasis survive; page fonts, sizes and text colors don't (they'd be unreadable in the other theme). Plain-text `- `, `1. `, `[ ] ` lines become real lists. ⌘/Ctrl+Z undoes any paste, list or style change in one step (the editor keeps its own undo history).

### Text styling
- **Style menu** (left of the toolbar) — each option previews in its real style.
- **B / I / U / S**, **text color**, **highlight**, and a **badge** (ClickUp-style inline pill).
- **Checklist**: hollow circles; click one to check it — the line goes muted + struck through.

### Keyboard (mirrors Google Docs)
| Action | Keys |
|---|---|
| Title / Heading / Subheading | ⌥⌘/Alt+Ctrl + **1 / 2 / 3** |
| Body text | ⌥⌘/Alt+Ctrl + **0** |
| Bulleted list | ⌘/Ctrl+Shift+**8** |
| Numbered list | ⌘/Ctrl+Shift+**7** |
| Checklist | ⌘/Ctrl+Shift+**9** |
| Indent / outdent list item | **Tab** / **Shift+Tab** (or ⌘/Ctrl+**]** / **[**) |
| Undo / redo | ⌘/Ctrl+**Z** / ⌘/Ctrl+Shift+**Z** |
| Link selected text | ⌘/Ctrl+**K** |
| New note | ⌘/Ctrl+Enter |
| Save now | ⌘/Ctrl+S (autosaves anyway) |

## Page-linked notes — the lock
The **lock toggle** (top-right) controls whether the note tracks your tabs:
- **🔒 locked** *(default)* — this note stays put no matter which tab you're on. The accent fill = anchored here.
- **🔓 unlocked** — the panel follows the active tab, surfacing that page's note as you move between tabs.

Right-click any selection on a page → **Save selection to Margin** drops it as a quote (with source + timestamp) into that site's note.

## In-app guide
The ⋯ menu has a built-in **User guide** and **Version log**, so help and the change history travel with the extension as it grows.

## Notes are per-page
Matching is keyed to origin + path, so each Claude chat or Google Doc keeps its own note (query strings and hashes are ignored). Because empty notes are never saved, this granularity doesn't create clutter.

## Auto-titles
New notes are titled `Site · Page · Mon D h:mma` — e.g. `Claude · Margin extension build · Jun 28 3:30a` or `Google · Q3 Budget · Jun 28 3:30a`. The middle identifier is inferred from the tab's title (cleaned of brand noise), falling back to the URL's first path segment when the title is just a product name — so an untitled `docs.google.com` still reads `Google · Document` vs `Google · Spreadsheets`. Edit any title freely; it only auto-generates once.

## Privacy & permissions
Notes are stored locally via `chrome.storage.local` and never leave your machine. Two heavier permissions, both for features you asked for:
- **`<all_urls>` host access** — only so **link cards** can fetch a URL's Open Graph metadata (title/description/image) from the background worker. No content scripts run on pages; nothing is read unless you paste a link into a card. Sites that block the fetch degrade to a plain link card.
- **`unlimitedStorage`**: so images (kept as local data URLs, long edge capped at 2400px) don't bump the default storage cap. The same host access lets the panel fetch an image you drop or right-click so a local copy is kept.

## Files
- `manifest.json` — MV3 config, commands, permissions.
- `background.js` — panel toggle, selection capture, link-card metadata fetch.
- `sidepanel.html / .css / .js`: the app shell, views and wiring.
- `editor-engine.js`: block styles, lists/checklists, Enter/Backspace, paste cleanup, undo history.
- `images.js`: image paste/drop/capture, storage encoding, copy/download/drag-out.
- `tokens.css` — design tokens (color/type/radius/shadow); the design-system seam.
- `docs/DESIGN_INTEGRATION.md` — how a UI design package from Claude Design lands.
- `icons/` — the mark.

## Known limits (honest list)
- Inline rich text (bold/italic/color) still uses `document.execCommand`; block structure (styles, lists, paste) no longer does (`editor-engine.js`).
- Table editing is basic (type in cells; no add-row/col UI yet).
- Link-card previews depend on the target site exposing OG tags and allowing the fetch.

Built for Josh Titus / Founding Creative.
