# Azure UI handoff → extension (integration record)

Source of truth: the "Margin Prototype" from Claude Design (the `design_handoff_azure`
bundle) + `CLAUDE.md` brand spec. Target: the unpacked MV3 side-panel extension. This
records what landed for the **Azure** brand and what was deferred, per the incremental,
one-surface-at-a-time model in `DESIGN_INTEGRATION.md`. Shipped as **v0.11.0** across a
sequence of per-surface commits.

## Landed

**Token re-theme + brand restyle (`tokens.css`, `sidepanel.css`).** The prototype's two-tier
surfaces map straight onto the existing seam: `--bg` = the lower editor plane, `--chrome` =
the raised app plane, so the look re-themes for free. New tokens: `--hairline` (cross-plane
rule), `--mn-rail` (Margin Numbers rule), `--ok` (positive/save-check green). An appended
"Azure brand overrides" block in `sidepanel.css` raises the title row + format bar onto the
app plane, sets body copy to weight 300, accent-tints active toggles (solid accent reserved
for New), rails the numbered gutter, and pins an AA `:focus-visible` ring. No IDs or class
hooks renamed, so `sidepanel.js` was untouched by the re-theme.

> Intake note: the handoff's `ready-to-commit/sidepanel.css` predated the Note info (#2) and
> paste-provenance (#6) CSS already in `main`, so only the additive override block was applied
> — a wholesale copy would have deleted those shipped features.

**Fonts (`/fonts`, `@font-face`).** MV3 CSP forbids CDN fonts, so **Hanken Grotesk** and
**JetBrains Mono** ship in the repo. The provided Google faces were the *variable* TTFs
(upright + italic); converted to woff2 and wired as four weight-range `@font-face` entries, so
one file per style covers every weight the brand uses (300 body … 700 headings).

**Connected pages (`#conn`, `#conn-drawer`).** The `sources[]` set (#4) surfaced as a favicon
chip row + count chip; the drawer adds connect / disconnect / add-custom-URL over that model
(favicons are colored initial tiles — no host fetch). Reuses `addSource()` / `pageKeyOf()`.

**Table of contents (`#toc-bar`, `#toc-menu`, #13).** Per-note `n.tocOn` toggle; a translucent
sticky outline bar + frosted heading dropdown + relocating scroll-progress bar. Headings are
the editor's top-level H1/H2/H3.

**Note ••• menu realignment.** Reordered to the locked layout with Lucide icons and live
accessories (source count, on/Off checks); **Pin → Favorite** (stored field stays `pinned`);
**Download** gains **.md** (a small HTML→Markdown serializer) beside .html. The kept rows —
Note info (#2) and the conditional Show paste sources (#6) — remain.

**Save state.** Footer indicator off color-alone (brand AA): check / pulsing dot / ×, each with
a label; a real `chrome.storage` write failure surfaces the error state.

## Deferred (intentional)

**Full-screen "Couldn't save" troubleshooting flow.** The prototype's save-error screen frames
failures around a network sync backend (`sync.margin.app`) that does not exist here — Margin
persists to `chrome.storage.local`. The three-state footer indicator covers how storage
actually behaves; the troubleshooting screen was left out rather than shipped with fictional
copy. Revisit if a sync backend is ever added.
