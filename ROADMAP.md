# Margin — Roadmap

*Captured from your idea dumps. Nothing here is shipped except where noted. Items keep your intent, then a tight read: what it touches, the lift (S/M/L), and the one thing to watch. Bugs are split out from features so the broken stuff doesn't hide behind the new stuff.*

---

## The through-line

A growing share of these ideas — URL info, multi-URL association, paste provenance, paste-from-page, active citation links — are all about *where knowledge came from*. Margin keeps drifting from **scratchpad** toward a **research surface that remembers its sources**. The honest cognitive problem: people lose the seam between what they thought and what they borrowed, and rebuilding a source weeks later is miserable. If that's the Margin you want, the provenance cluster is the differentiator and earns priority.

The *second* thing these dumps reveal: the **editor itself is maturing** — lists, selection tools, sizing, a TOC, Margin Numbers. That's a separate track from provenance, and the two can advance in parallel.

---

## Decisions locked

- **Public share link — killed.** Margin stays on-device.
- **Google Docs — in, as one more export method** alongside `.html` (and a likely `.docx`).
- **Full URLs — stored, rarely shown.** Every note persists exact source URL(s); surfaced only on demand.
- **Merge pools sources.** Merging notes unions their URLs into one provenance/association set; unlocked, the merged note surfaces on *any* of those URLs.
- **Margin Numbers** *(name locked)* — the per-block reference system (full spec in The Editor).
- **Numbering is per block, hierarchical** — paragraph / block element is the unit, rendered legal-style (`12`, then `12.1 / 12.2` for nested list items and table rows), in a faint left gutter.
- **Default theme — dark.** The side panel opens in dark mode by default.
- **"Badge," never "highlight."** Highlight as a concept is retired; the term and the tool are *badge* everywhere.

### ✅ Shipped in v0.8.0 (Phase 2 — Merge)

**Merge notes (#3)** landed on top of the `sources[]` model: in the all-notes Select mode, pick 2+ notes → **Merge** folds them into one — bodies **newest-on-top** with a divider, each section **headed by its original title**, the **newest title** becoming the merged note's own, **source sets unioned** (pinned if any were; created-date the oldest). A **toast with Undo** replaces a confirm dialog. This is also the second slice of multiselect management (#1), joining bulk delete. Next in Phase 2: **Note info (#2)**.

### ✅ Shipped in v0.7.0 (Phase 2 keystone — the `sources[]` model)

The one real fork landed: **a note's identity is now a *set* of pages, not a single URL** (#4). Each note carries `sources[]` — full URLs for provenance, normalized page keys for matching. A note surfaces on *any* of its source pages when unlocked, and **capture unions** the captured page into the set. Legacy notes migrate on first load. This unblocks the rest of Phase 2 — **Merge (#3)** unions two notes' sets, **Note info (#2)** displays them.

### ✅ Shipped in v0.6.0 (Phase 1 — editor wins, no new data)

Six low-dependency editor items landed: **Margin Numbers** (#7 — per-note gutter numbering, legal/hierarchical, with the subtle alternating row tint), **Text size** (#10 — Small/Regular/Large/Supersize, persisted, scales the whole note), **Selection word count** (#11 — live in the footer), **Lists & indenting** (#8 — `⌘/Ctrl+]`/`[` indent/outdent for lists *and* plain text, extra line-space; Tab/Shift-Tab already shipped with B2), **Rename affordance** (#18 — pencil + tint on title hover), and **Default dark** (#17). Items #7, #8, #10, #11, #17, #18 are therefore done.

### ✅ Shipped in v0.5.0 (no longer on the board)

Nav/UX overhaul landed: **blue icon** (one mid-tone glyph legible on every surface — retired the tile and the runtime light/dark swap), **home/house icon** for the notes list, **+ New pinned to a consistent position** across views, **settings gear** holding app-level items (guide / release notes / roadmap / shortcut), **note-actions menu** moved to the title row (copy / download / pin / delete), **combined text-color + badge tool** (one static square-A icon, two-section menu), **note-browser sorting** (last updated / created / title, persisted), **contextual in-app title** (resolves the double-title), **in-app roadmap** (split: User guide on its own page; Release notes + Roadmap tabbed), and **default shortcut → ⌘⇧E**. Items #19 and #20 below are therefore done; #12 is scrapped.

---

## 🐞 Bugs & correctness — fix before piling on features

**B1. Toggle shortcut fires only sometimes** *(default is now ⌘⇧E — shipped; the *sporadic* part remains)*
- **Symptom:** open/close-via-shortcut works sporadically — success *and* failure with cursor on the page (text, form fields) or inside Margin, no pattern.
- **Likely cause:** the MV3 service worker sleeps, and the in-memory `openPanels` map that tracks which windows have the panel open is wiped when it restarts. On a cold wake, `toggle()` can't tell open from closed, so it opens-when-open or fails to close. Waking the worker also burns milliseconds that can invalidate the user-gesture token `sidePanel.open()` requires. Both produce exactly this "random" feel.
- **Fix direction:** persist panel-open state (per window) to `chrome.storage.session` instead of memory; keep the `open()` call synchronous on the gesture. Then set `⌘⇧E` as the suggested default.
- **Lift:** M (mostly investigation + a state-persistence change).

**B2. Tab inside a list jumps to a random far-off block**
- **Likely cause:** we only intercept Tab while the slash menu is open; otherwise the browser's default contenteditable Tab moves *focus* to the next focusable element — and a toggle's `<summary>` is focusable, which is why it leaps to a far-down toggle.
- **Fix direction:** intercept Tab/Shift-Tab inside lists → indent/outdent and `preventDefault`. (Folds into the Lists work, L1.)
- **Lift:** S–M.

**B3. Captured citation link looks inactive**
- **Likely cause:** the link *is* inserted, but inside a contenteditable a click just places the caret — it doesn't open. So it reads as dead. (The faint `.src` styling makes it look inactive too.)
- **Fix direction:** add a click handler that opens note links in a new tab (or make the citation line `contenteditable="false"`), and lift the link styling so it reads as a link.
- **Lift:** S.

**B4. Locked note is ignored when sending from a webpage**
- **Symptom:** with a note **LOCKED**, "Add to Margin" from the page's right-click menu still drops content into the *tab's* note, not the note you're actually looking at.
- **Fix direction:** the panel should publish its current open-note id + locked state to storage; on capture, if locked, the background appends to *that* note instead of resolving by tab. (This is the locked-semantics promise applied to capture.)
- **Lift:** M.

**B5. Sent content always lands at the end**
- **Want:** inserted at the **last known caret position** in the note, not appended.
- **Fix direction:** track and persist the note's last selection range; insert there on capture.
- **Lift:** M. *(Pairs with B4 — same capture path.)*

---

## Theme — Managing notes at scale

**1. Multiselect note management** *(bulk delete shipped v0.4.3; merge shipped v0.8.0)* — selection scaffold now does delete + merge. Remaining slice: bulk **pin**. **Lift:** S.

**2. Note info menu — associated URL(s), created, updated** — data already exists on every note. Full URL now stored (decided), shown on demand. **Lift:** S. *Pre-change notes have only the path to show.*

**3. Merge notes — newest content on top** — ✅ **shipped v0.8.0.** Selected notes concatenate by `updatedAt` desc with an `<hr>` between bodies; each section is **headed by its original title** (inline `<h2>`) so the merged chunks stay legible; source sets union. Resolved watch-items: the **newest note's title** becomes the merged note's own, originals are **consumed** (replaced by the merged note) with a **toast Undo** instead of a confirm dialog. **Lift:** M.

**4. Multi-URL association — one note across many pages when unlocked** *(the keystone / the one real fork)* — ✅ **shipped v0.7.0.** A note's `pageKey` became a `sources[]` set: each entry holds the **full URL** (the provenance trail, rarely shown) keyed by normalized page (origin + path) for matching (the association set — where the note surfaces unlocked). A note matches the current page if *any* source matches; **capture unions** the captured page into the note's set, so one note can span every page it borrowed from. Legacy notes migrate automatically on first load. Merge (#3) and Note info (#2) consume this model. **Lift:** M.

---

## Theme — Capture & provenance *(the differentiator)*

**5. Paste-from-page hotkey** — a key command that pulls the active tab's live selection into the **currently open** note. Needs the `scripting` permission (we hold `<all_urls>`). Distinct from right-click capture: respects the note you're viewing, and tags the paste with a *certain* source URL. **Lift:** M.

**6. Paste provenance — show/hide which paragraphs came from the web** — tag pasted blocks with origin URL; a toggle reveals a subtle "from \<source\>" treatment, traceable to the URL. **Watch:** the browser can't reveal the true copy source; best signal is the active tab URL at paste time (right for #5, a guess for free-form paste). The spine of the research-surface thesis. **Lift:** M.

*(B3/B4/B5 above are correctness work in this same cluster.)*

---

## Theme — The text editor

**7. Margin Numbers** *(name locked)* — ✅ **shipped v0.6.0.** A per-note toggle (in the note ⋯ menu) that numbers each block down a **faint, code-editor-style left gutter**.
- **Format:** hierarchical/legal — top-level blocks get `1, 2, 3…`; nested units (list items, table rows) get `12.1, 12.2, 12.3`. *This is why your "bullets get their own number" worry dissolves: the gutter + the `12.x` sub-numbering keep them visually and semantically separate from a list's own ordinals.*
- **Gutter solves the double-number problem:** a separate dim left column physically removes Margin Numbers from the content's own numbers. Placement *is* the disambiguation.
- **On-state signal:** the faint gutter appearing *is* the "it's on" cue — no extra chrome. Plus a **very subtle alternating row tint** so each number's span (start→end) reads at a glance.
- **Scope:** strictly an *immediate* reference aid (positional, renumbers live). Not a permanent ID.
- **Touches:** a CSS counter on the editor's blocks + a per-note (or global setting?) toggle. **Lift:** S–M — the note is already a block sequence, so no `<pre>`/line restructuring.

**8. Lists** — ✅ **shipped v0.6.0.** Make list editing behave.
- Tab / Shift-Tab → indent / outdent + correct marker (fixes **B2**). *(shipped)*
- `⌘]` indent in; `⌘[` indent out — also indent **non-list** text (now persisted: `margin-left` is whitelisted in the sanitizer). *(shipped)*
- A list applied to **H1/H2/H3** text inherits that text's size, color, weight — headings inside `<li>` already render at heading scale via the editor's descendant rules. *(covered)*
- Subtle extra line-space between items. *(shipped)*
- **Lift:** M.

**9. Selection toolbar — floating menu on selection** — select text in a note → minimal menu above it: style dropdown, text color, **badge**, add link, clear formatting. Visual match to the main toolbar (slightly tighter sizing OK). *(Resolved: the menu carries **badge** — consistent with the combined color/badge tool already shipped. No highlight returns.)* **Lift:** M.

**10. Text size — accessibility, not formatting** — ✅ **shipped v0.6.0.** A dropdown after the style tool: Small / Regular / Large / Supersize. Scales *all* styles equally across the whole note (headings/badges are em-based, so scaling the editor's base size scales everything). A **persisted setting** (sticks across notes), in the toolbar where people expect sizing to live. **Lift:** S–M.

**11. Selection word/char count** — ✅ **shipped v0.6.0.** The footer shows the selection's live word count next to the note total. **Lift:** S.

*(Was #12, one-click spell-check — **scrapped.** Chrome doesn't expose spellcheck suggestions to JS, and bundling a dictionary isn't worth the weight.)*

---

## Theme — Structure & navigation

**13. Table of Contents** — auto-generated, auto-updating. Items = **H1** (Title) and their nested **H2** only; no other styles. A **non-invasive sticky** treatment. Genuinely ahead of most editors — a real differentiator if the sticky UX stays light. **Lift:** M.

---

## Theme — Rich media

**14. Images — paste, drop, capture, manage**
- Paste images from clipboard into a note.
- Drag/drop images into a note.
- Add **"Add to Margin"** to the right-click menu on a **webpage image** (today it only appears for selected text).
- **Hover controls, top-right of an image:** copy-to-clipboard + download. Match the lock/dark-mode toggle UI pattern so the two icon buttons stay legible over *any* image — dark, light, busy, or text-filled — backed by a subtle margin-color wash on image hover. Accessibility is the point here, not decoration.
- **Lift:** M (storage/downscale logic already exists for uploads).

**15. Multiple filetype support** *(extends #14)* — drop common files into a note as **blocks** with a filetype icon + contextual preview, for later revisiting.
- Types: **video** (strictest size cap), **GIF**, **audio**, **text docs** (docx/md/txt/rtf), **PDF**.
- **Preview in-note**; download is the *secondary* action.
- **Clear per-type filesize constraints** to keep notes from bloating and the panel fast — the load-bearing constraint of the whole feature.
- **Watch:** local storage has limits; large media as data URLs will pressure `unlimitedStorage`. Caps + maybe thumbnail-only-for-heavy-types is the speed safeguard.
- **Lift:** L.

---

## Theme — Getting notes out

**16. Export to Google Docs** *(additional export method)* — sits beside the existing `.html` export. Needs `chrome.identity` OAuth + Docs/Drive API. Ship the cheaper sibling first — a **`.docx` export** (we can already generate Word) — then the direct Docs push if still wanted. **Lift:** L.

---

## Theme — Platform & polish

**17. Default to dark mode** — ✅ **shipped v0.6.0.** Side panel opens dark on first run (the `theme` setting defaults to `dark`; an explicit prior choice still wins). **Lift:** S.

**18. Note-title hover affordance** *(ref: Loom)* — ✅ **shipped v0.6.0.** Hovering the title eases in a pencil icon and shifts the title toward the accent, signaling "click to rename." Clicking the pencil focuses and selects the title. **Lift:** S.

**19. Contextual in-app title** *(double-title fix)* — ✅ **shipped in v0.5.0.** The Chrome-drawn top header can't be touched, so the in-app title slot now carries a contextual page title ("All notes," "User guide," "Release notes & roadmap") instead of echoing the app name.

**20. Icon polarity in menu & panel surfaces** — ✅ **resolved in v0.5.0 via the blue icon.** Rather than fight the no-theme-swap limit on the context-menu and side-panel-header icons, a single mid-tone blue glyph reads on both light and dark surfaces. The adaptive toolbar-icon swap was removed as no longer needed.

---

## Suggested build order

- **Phase 0 — Squash the bugs (B1–B5).** Correctness first; most are S–M and several (B2/B4/B5) fold into features you're building anyway.
- **Phase 1 — Editor wins that don't need new data:** ✅ **shipped in v0.6.0** — Margin Numbers (#7), Lists (#8), Text size (#10), Selection count (#11), Title hover (#18), Default dark (#17). *(Contextual title #19 and the nav/icon work shipped in v0.5.0.)*
- **Phase 2 — The `sources[]` model (#4) → Merge (#3) → Note info (#2).** ✅ #4 shipped v0.7.0; ✅ Merge (#3) shipped v0.8.0. **Next up: Note info (#2)** — surface a note's source URLs / created / updated. (Plus the small remaining multiselect slice: bulk **pin**, #1.)
- **Phase 3 — Provenance & capture:** Paste-from-page (#5) + provenance display (#6). Same plumbing; ship as a pair.
- **Phase 4 — Rich media:** Images (#14) → filetypes (#15). Media before TOC since they're more-used.
- **Phase 5 — Structure & reach:** TOC (#13), then `.docx`/Google Docs export (#16).
- **Decide first:** Selection toolbar (#9 — resolved to badge; just confirm placement). Spell-check is scrapped; icon polarity is solved.

---

## The one real fork — ✅ taken (v0.7.0)

**A note's identity is now a set, not a single URL** (#4). One `pageKey` → a `sources[]` set: full URLs for provenance, normalized page keys for matching. The stored-data change shipped with an automatic migration. The merge / association / provenance cluster now hangs off a foundation that exists — no structural decisions left open on the board.

---

*Want any phase turned into a build-ready RUNDOC? Name it and it becomes a working doc.*
