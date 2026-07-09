/* ===========================================================================
   Margin — side panel logic (v0.3)  — block editor
   =========================================================================== */
const STORE_KEY = "margin.notes";
const SETTINGS_KEY = "margin.settings";
const $ = (id) => document.getElementById(id);
const now = () => Date.now();
let editor; // set on init
let captureCaretRange = null; // last caret position inside the editor (for capture insertion — B5)
let lastActiveId = null;      // id of the most recently opened note (for locked capture when reopened — B4)

let state = {
  notes: [], settings: { theme: "dark", follow: false, sort: "updated", textSize: "regular" }, host: null, pageKey: null, tabInfo: null, activeId: null, query: "", selectMode: false, selected: new Set()
};

/* ---------- tiny dom utils ---------- */
const elc = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
const br = () => document.createElement("br");
const para = () => { const p = elc("p"); p.appendChild(br()); return p; };
const uid = () => "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; } }
function pageKeyOf(url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return null; } }
function htmlToText(html) { const d = elc("div"); d.innerHTML = html || ""; return d.textContent || ""; }
function relTime(ts) {
  const s = (now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const TWO_LEVEL = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","co.nz","co.jp","com.br","co.in","com.mx"]);
function siteName(host) {
  if (!host) return "Note";
  const p = host.split(".");
  let l = p.length >= 3 && TWO_LEVEL.has(p.slice(-2).join(".")) ? p[p.length - 3] : (p.length >= 2 ? p[p.length - 2] : p[0]);
  l = l || host; return l.charAt(0).toUpperCase() + l.slice(1);
}
function shortStamp(d = new Date()) {
  const mo = d.toLocaleString(undefined, { month: "short" });
  let h = d.getHours(); const m = d.getMinutes(); const ap = h < 12 ? "a" : "p"; h = h % 12 || 12;
  return `${mo} ${d.getDate()} ${h}:${m < 10 ? "0" + m : m}${ap}`;
}
const BRAND_WORDS = "Google Docs|Google Sheets|Google Slides|Google Drive|Google Search|Docs|Sheets|Slides|Claude|Notion|Figma|FigJam|GitHub|GitLab|YouTube|LinkedIn|Gmail|Outlook|Reddit|Stack Overflow|Medium|Substack|ClickUp|Slack|Vercel|Linear|Google";
const BRAND_SUFFIX = new RegExp("\\s*[-–—|·:]\\s*(" + BRAND_WORDS + ")\\s*$", "i");
const BRAND_WHOLE = new RegExp("^(" + BRAND_WORDS + ")$", "i");
function pageTag(info) {
  if (!info) return "";
  const url = info.url || "";
  let t = (info.title || "").trim().replace(/^\(\d+\)\s*/, ""); // drop "(3) " notification counts
  const site = siteName(hostOf(url));
  for (let i = 0; i < 2; i++) { const n = t.replace(BRAND_SUFFIX, "").trim(); if (n === t) break; t = n; } // strip brand suffix
  if (site) { const re = new RegExp("\\s*[-–—|·:]\\s*" + site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i"); t = t.replace(re, "").trim(); }
  if (BRAND_WHOLE.test(t)) t = ""; // title is *only* a product name ("Google Docs", "Claude")
  if (!t || t.toLowerCase() === (site || "").toLowerCase()) { // fall back to first path segment (Document vs Spreadsheets)
    try { const seg = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[0] || ""); t = seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : ""; } catch { t = ""; }
  } else { t = t.split(/\s+[-–—|]\s+/)[0].trim() || t; } // multi-part title -> keep the lead segment ("Inbox - email" -> "Inbox")
  if (!t) return "";
  t = t.replace(/\s+/g, " ");
  return t.length > 22 ? t.slice(0, 21).trimEnd() + "…" : t;
}
function autoTitle(host, tag, d = new Date()) {
  const parts = [siteName(host)];
  if (tag) parts.push(tag);
  parts.push(shortStamp(d));
  return parts.join(" · ");
}

/* ---------- sanitizer (whitelist; preserves block markup, blocks scripts) ---------- */
const ALLOWED_TAGS = new Set(["P","BR","DIV","SPAN","H1","H2","H3","H4","BLOCKQUOTE","PRE","CODE","UL","OL","LI","B","STRONG","I","EM","U","S","STRIKE","A","HR","IMG","DETAILS","SUMMARY","TABLE","THEAD","TBODY","TR","TD","TH","FONT"]);
const ALLOWED_CLASSES = new Set(["callout","callout-blue","callout-green","callout-yellow","callout-red","callout-gray","callout-body","checklist","checked","check","badge","toggle","toggle-body","link-card","loading","lc-body","lc-title","lc-desc","lc-host","lc-image","src","prov"]);
const STYLE_PROPS = new Set(["color","background-color","font-weight","font-style","text-decoration","text-decoration-line","margin-left"]);
const BLOCKLIST = "script,style,iframe,object,embed,link,meta,base,form,input,button,svg,math,template,noscript";
function cleanStyle(value) {
  return (value || "").split(";").map((s) => s.trim()).filter(Boolean).filter((decl) => {
    const i = decl.indexOf(":"); if (i < 0) return false;
    const prop = decl.slice(0, i).trim().toLowerCase(), val = decl.slice(i + 1).trim().toLowerCase();
    if (!STYLE_PROPS.has(prop) || !val) return false;
    if (/url\(|expression|javascript:/i.test(val)) return false;
    return true;
  }).join("; ");
}
function cleanAttrs(el) {
  const tag = el.tagName;
  [...el.attributes].forEach((a) => {
    const n = a.name.toLowerCase(), v = a.value;
    if (n === "class") { const k = [...el.classList].filter((c) => ALLOWED_CLASSES.has(c)); if (k.length) el.setAttribute("class", k.join(" ")); else el.removeAttribute("class"); return; }
    if (n === "style") { const s = cleanStyle(v); if (s) el.setAttribute("style", s); else el.removeAttribute("style"); return; }
    let keep = false;
    if (n === "href" && tag === "A") keep = /^(https?:|mailto:)/i.test(v.trim());
    else if (n === "src" && tag === "IMG") keep = /^(data:image\/|https?:)/i.test(v.trim());
    else if (n === "alt" && tag === "IMG") keep = true;
    else if ((n === "colspan" || n === "rowspan") && (tag === "TD" || tag === "TH")) keep = /^\d+$/.test(v);
    else if (n === "open" && tag === "DETAILS") keep = true;
    else if (n === "data-count" && tag === "UL") keep = /^\d+\/\d+$/.test(v);
    // Paste-from-page provenance (#5/#6): the source URL + host of a pasted block, and the
    // full-URL tooltip. Kept only when the value is a real web URL so a tag can't smuggle other data.
    else if (n === "data-src") keep = /^https?:/i.test(v.trim());
    else if (n === "data-srchost") keep = !!el.getAttribute("data-src");
    else if (n === "title") keep = !!el.getAttribute("data-src");
    else if (n === "contenteditable") keep = v === "false";
    if (!keep) el.removeAttribute(a.name);
  });
  if (tag === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
}
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const body = doc.body;
  body.querySelectorAll(BLOCKLIST).forEach((e) => e.remove());
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    body.querySelectorAll("*").forEach((el) => {
      if (!ALLOWED_TAGS.has(el.tagName)) { const p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); changed = true; }
    });
    if (!changed) break;
  }
  body.querySelectorAll("*").forEach(cleanAttrs);
  return body.innerHTML;
}

/* ---------- storage ---------- */
async function load() {
  const data = await chrome.storage.local.get([STORE_KEY, SETTINGS_KEY]);
  state.notes = Array.isArray(data[STORE_KEY]) ? data[STORE_KEY] : [];
  if (data[SETTINGS_KEY]) state.settings = { ...state.settings, ...data[SETTINGS_KEY] };
  let migrated = false;
  state.notes.forEach((n) => { if (migrateNote(n)) migrated = true; });
  if (migrated) await saveNotes();
}
async function saveNotes() {
  try { await chrome.storage.local.set({ [STORE_KEY]: state.notes }); return true; }
  catch (e) { setStatus("Save failed", "error"); return false; }
}
async function saveSettings() { await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }); }

/* ---------- theme + toggles (icons are Lucide <use> refs, swapped by id) ----------
   The topbar icons live in sidepanel.html as inline <use href="#i-*"> sprites, so
   the two state-driven buttons (lock, theme) just repoint their <use> at another
   symbol rather than re-injecting SVG markup. */
function setUse(btn, id) { const u = btn && btn.querySelector("use"); if (u) u.setAttribute("href", "#i-" + id); }
function applyTheme() {
  const dark = state.settings.theme === "dark";
  document.body.classList.toggle("dark", dark);
  // The app-bar theme button was removed; keep this null-safe so applyTheme()
  // still drives the theme (and re-syncs any future settings-page control).
  const tb = $("theme-toggle");
  if (tb) {
    setUse(tb, dark ? "moon" : "sun");
    tb.classList.toggle("on", dark);
    tb.title = dark ? "Dark mode (click for light)" : "Light mode (click for dark)";
  }
}
function toggleTheme() { state.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; applyTheme(); saveSettings(); }
function applyLockIcon() {
  const following = !!state.settings.follow; // follow=true => note changes per tab => UNLOCKED
  const b = $("lock-toggle");
  setUse(b, following ? "lock-open" : "lock");
  b.classList.toggle("on", !following); // locked (stays put) is the engaged/accent state
  b.title = following
    ? "Unlocked — the note follows the active tab, switching per site. Click to lock it in place."
    : "Locked — this note stays put no matter which tab you're on. Click to unlock and follow tabs.";
  b.setAttribute("aria-label", following ? "Unlocked: note follows tabs" : "Locked: note stays put");
}

/* ---------- sources (a note's identity is a set of pages, not one) ----------
   Every note carries `sources: [{ url, key, host, at }]`. `url` is the *full* URL it was
   drawn from (the provenance trail, rarely shown); `key` is the normalized page key
   (origin+path, query/hash dropped) used for matching (the association set — where the
   note surfaces unlocked). Merge unions these sets; capture appends to them. */
function sourceFrom(url) {
  const u = url || "";
  const key = pageKeyOf(u), host = hostOf(u);
  if (!key && !host) return null; // unparseable / non-web (e.g. about:blank) — a source-less scratch note
  return { url: u, key, host, at: now() };
}
function sourcesFor(url) { const s = sourceFrom(url); return s ? [s] : []; }
function noteHost(n) { const s = (n.sources || []).find((x) => x.host); return s ? s.host : (n.host || null); }
// Union a page into a note's source set: dedup by key (or host for non-web), upgrading a
// migrated key-only entry to a full URL when we now have one, and bumping its recency.
function addSource(n, url) {
  if (!Array.isArray(n.sources)) n.sources = [];
  const s = sourceFrom(url); if (!s) return;
  const hit = n.sources.find((x) => s.key ? x.key === s.key : (!x.key && x.host === s.host));
  if (hit) { if (s.url && s.url.length > (hit.url || "").length) hit.url = s.url; hit.at = s.at; }
  else n.sources.push(s);
}
// One-time, idempotent: lift legacy {pageKey, host} notes into the sources[] model. Pre-change
// notes never stored the full URL, so the page key is the best `url` we can show.
function migrateNote(n) {
  if (Array.isArray(n.sources)) return false;
  const key = n.pageKey || null, host = n.host || null;
  n.sources = (key || host) ? [{ url: key || "", key, host, at: n.createdAt || now() }] : [];
  delete n.pageKey; delete n.host;
  return true;
}

/* ---------- note model ---------- */
function noteMatchesContext(n) {
  const src = n.sources || [];
  if (state.pageKey) return src.some((s) => s.key === state.pageKey);
  if (state.host) return src.some((s) => !s.key && s.host === state.host);
  return src.length === 0; // non-web context (chrome://, blank): the source-less scratch notes
}
function latestContextNote() { return state.notes.filter(noteMatchesContext).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null; }
function createContextualNote(host, ephemeral) {
  const title = autoTitle(host, pageTag(state.tabInfo));
  const sources = sourcesFor(state.tabInfo && state.tabInfo.url);
  const n = { id: uid(), title, autoTitle: title, html: "", sources, pinned: false, ephemeral: !!ephemeral, createdAt: now(), updatedAt: now() };
  state.notes.unshift(n); return n;
}
function noteIsEmpty(n) { return n ? htmlToText(n.html).trim() === "" && (n.title || "") === (n.autoTitle || "") : false; }
function pruneIfEmpty(id) { const n = state.notes.find((x) => x.id === id); if (n && noteIsEmpty(n)) state.notes = state.notes.filter((x) => x.id !== id); }

/* ---------- views ---------- */
function isEditorView() { return $("view-editor").classList.contains("is-active"); }
function activate(view) { ["view-editor", "view-browser", "view-info"].forEach((id) => $(id).classList.toggle("is-active", id === view)); }
function showEditor() { activate("view-editor"); }
async function showBrowser() {
  pruneIfEmpty(state.activeId); await saveNotes();
  closeAllPopovers(); hideToast();
  activate("view-browser");
  state.query = ""; $("search").value = "";
  state.selectMode = false; state.selected.clear();
  $("select-toggle").textContent = "Select"; $("select-toggle").classList.remove("active");
  $("sort-select").value = state.settings.sort || "updated";
  renderList();
}

/* ---------- editor core ---------- */
let saveTimer = null, cssModeSet = false;
// Save state is never color-alone (brand AA): every state pairs a glyph with a
// label. saving = pulsing dot, saved = check, error = ×. The three glyphs are
// static in sidepanel.html; CSS reveals the one matching [data-state], so here we
// only flip data-state + the label. Legacy callers pass `true` for the saving flag.
const SAVE_TITLE = { saved: "All changes saved", saving: "Saving…", error: "Couldn't save to local storage" };
function setStatus(t, state) {
  const el = $("save-status"); if (!el) return;
  const s = state === true ? "saving" : (state || "saved");
  el.dataset.state = s;
  el.title = SAVE_TITLE[s] || "";
  const lbl = $("save-label"); if (lbl) lbl.textContent = t;
}
function activeNote() { return state.notes.find((x) => x.id === state.activeId); }
function ensureCssMode() { if (!cssModeSet) { try { document.execCommand("styleWithCSS", false, true); } catch (e) {} cssModeSet = true; } }
function openNote(id) {
  const n = state.notes.find((x) => x.id === id); if (!n) return;
  hideToast();
  state.activeId = id; lastActiveId = id;
  try { chrome.storage.session.set({ "margin.activeId": id }); } catch (e) {}
  $("title").value = n.title || "";
  editor.innerHTML = sanitizeHtml(n.html || "");
  updateChecklistCounts();
  editor.classList.toggle("numbered", !!n.numbered);
  editor.classList.toggle("show-prov", !!n.showProv);
  syncNoteMenu();
  $("note-menu").hidden = true;
  renderNoteSub(n); syncMnToggle(n);
  setStatus("Saved"); updateCounts(); syncToolbar();
  showEditor(); // activate the editor view first so the band/TOC renders (they gate on isEditorView)
  closeConnDrawer(); renderConn(n);
  closeTocMenu(); renderToc(n);
}
// Compact "Jun 24" for the created stamp (relTime gives the fuzzy "edited" half).
function fmtShortDate(ts) { return ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""; }
// The created/edited line under the title: when the note was created and last edited.
function renderNoteSub(n) {
  const el = $("created-line"); if (!el) return;
  el.textContent = n ? `Created ${fmtShortDate(n.createdAt)} · Edited ${relTime(n.updatedAt)}` : "Created — · Edited —";
}
// Footer "#" quick-toggle mirrors the note's Margin Numbers state.
function syncMnToggle(n) {
  const b = $("mn-toggle"); if (!b) return;
  const on = !!(n && n.numbered);
  b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
}
function updateCounts() {
  const text = editor.innerText || "";
  const words = (text.trim().match(/\S+/g) || []).length;
  const chars = text.replace(/\u200B/g, "").replace(/\n$/, "").length;
  const base = `${words} ${words === 1 ? "word" : "words"} · ${chars} ${chars === 1 ? "character" : "characters"}`;
  let pill = "";
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode) && editor.contains(sel.focusNode)) {
    const str = sel.toString();
    const selChars = str.length;
    if (selChars > 0) {
      const selWords = (str.trim().match(/\S+/g) || []).length;
      pill = `<span class="sel-pill">${selWords} ${selWords === 1 ? "word" : "words"} · ${selChars} ${selChars === 1 ? "character" : "characters"} selected</span>`;
    }
  }
  const c = $("counts"); c.textContent = base; if (pill) c.insertAdjacentHTML("beforeend", pill);
  renderNoteSub(activeNote());
}
function queueSave() {
  const n = activeNote(); if (!n) return;
  n.title = $("title").value;
  n.html = sanitizeHtml(editor.innerHTML);
  if (n.ephemeral && htmlToText(n.html).trim() !== "") n.ephemeral = false;
  n.updatedAt = now();
  setStatus("Saving…", "saving"); updateCounts();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { if (await saveNotes()) setStatus("Saved"); }, 400);
}
function flashSaved() { setStatus("Saved"); }

async function newNote() { await refreshHost(); pruneIfEmpty(state.activeId); const n = createContextualNote(state.host, true); await saveNotes(); openNote(n.id); editor.focus(); }
async function ensureForActiveTab() { let n = latestContextNote(); if (!n) { n = createContextualNote(state.host, true); await saveNotes(); } openNote(n.id); }
async function loadActiveTabNote() { pruneIfEmpty(state.activeId); let n = latestContextNote(); if (!n) n = createContextualNote(state.host, true); await saveNotes(); openNote(n.id); }
async function deleteNote() {
  const n = activeNote(); if (!n) return;
  if (!confirm(`Delete “${n.title || "this note"}”? This can’t be undone.`)) return;
  state.notes = state.notes.filter((x) => x.id !== n.id); await saveNotes(); await ensureForActiveTab();
}
// Favorite = the stored `pinned` field (kept for data compatibility), relabelled.
function togglePin() { const n = activeNote(); if (!n) return; n.pinned = !n.pinned; n.updatedAt = now(); saveNotes(); $("note-menu").hidden = true; }
function toggleMarginNumbers() {
  const n = activeNote(); if (!n) return;
  n.numbered = !n.numbered; n.updatedAt = now();
  editor.classList.toggle("numbered", n.numbered);
  syncMnToggle(n); syncNoteMenu();
  saveNotes(); $("note-menu").hidden = true;
}
// Refresh the note kebab menu's live accessories (source count, toggle state, favorite).
// LOCKED SET: connected · toc · margin numbers · copy · download · favorite · delete.
function syncNoteMenu() {
  const n = activeNote();
  const cc = $("note-conn-count"); if (cc) cc.textContent = `${n ? (n.sources || []).length : 0} ›`;
  const ts = $("toc-state"); if (ts) ts.textContent = tocIsOn(n) ? "On" : "Off";
  const ms = $("mn-state"); if (ms) ms.textContent = (n && n.numbered) ? "On" : "Off";
  const fl = $("fav-label"); if (fl) fl.textContent = (n && n.pinned) ? "Favorited" : "Favorite";
  const menu = $("note-menu");
  const fav = menu && menu.querySelector('[data-act="favorite"]'); if (fav) fav.classList.toggle("fav-on", !!(n && n.pinned));
}

/* ---------- Connected pages — the sources[] set, made visible & editable ----------
   A note's sources[] IS its identity as a set of pages (see the sources helpers
   above). This band + drawer let the user see, connect, and disconnect those
   pages. The read model already exists; the drawer adds connect / disconnect /
   add-custom-URL mutations. Favicons aren't fetched (no host permission), so each
   page shows a colored initial tile derived deterministically from its host. */
// Inline Lucide icon from the #i-* sprite, wrapped in a span for flex layout.
// Every icon in the app is a sprite <use>; no literal glyph characters live here.
function svgUse(id, cls) { const s = elc("span", cls || ""); s.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-${id}"/></svg>`; return s; }
let connQuery = "";
// Known-host brand tints, so recognizable sites (Linear, Claude, GitHub…) read
// as themselves in the favicon chip; anything unlisted falls back to the
// deterministic hash hue below. White glyph is legible on every value here.
const BRAND_TILE = {
  "linear.app":"#5e6ad2", "claude.ai":"#c96442", "github.com":"#30363d",
  "figma.com":"#a259ff", "notion.so":"#2f2f2f", "stripe.com":"#635bff",
  "reddit.com":"#ff4500", "youtube.com":"#ff0000", "google.com":"#4285f4",
  "docs.google.com":"#4285f4", "drive.google.com":"#4285f4", "mail.google.com":"#ea4335",
  "linkedin.com":"#0a66c2", "medium.com":"#242424", "vercel.com":"#111111",
  "gitlab.com":"#fc6d26", "slack.com":"#611f69", "x.com":"#111111", "twitter.com":"#111111",
};
// Proper-cased display names for recognized hosts (siteName only title-cases the
// first letter, which would render "Github"/"Linkedin"/"Youtube").
const BRAND_NAME = {
  "github.com":"GitHub", "gitlab.com":"GitLab", "linkedin.com":"LinkedIn",
  "youtube.com":"YouTube", "figjam.com":"FigJam", "x.com":"X", "twitter.com":"X",
};
function brandColor(host) {
  if (!host) return null;
  const h = host.replace(/^www\./, "");
  return BRAND_TILE[h] || BRAND_TILE[h.split(".").slice(-2).join(".")] || null;
}
function brandName(host) {
  if (!host) return null;
  const h = host.replace(/^www\./, "");
  return BRAND_NAME[h] || BRAND_NAME[h.split(".").slice(-2).join(".")] || null;
}
// Tile color from a host string: brand tint when known, else a stable hash hue.
function sourceColor(host) {
  const brand = brandColor(host); if (brand) return brand;
  const s = host || "?"; let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 46%)`;
}
function sourceInitial(host) { return (siteName(host) || "?").charAt(0).toUpperCase(); }
function sourceLabel(s) { return brandName(s.host) || siteName(s.host) || s.host || (s.url || s.key || "Page"); }
function isCurrentSource(s) {
  if (state.pageKey) return s.key === state.pageKey;
  if (state.host) return !s.key && s.host === state.host;
  return false;
}
// Is the active tab's page already in the note's set?
function currentPageConnected(n) {
  const src = n.sources || [];
  if (state.pageKey) return src.some((s) => s.key === state.pageKey);
  if (state.host) return src.some((s) => s.host === state.host);
  return false;
}
function faviconTile(s, cls) {
  const t = elc("span", cls || "conn-fav");
  t.style.background = sourceColor(s.host); t.textContent = sourceInitial(s.host);
  return t;
}
function connIsOpen() { const b = $("connected-band"); return !!b && b.dataset.open === "true"; }

// Collapsed band: horizontal favicon name-chip row + pinned count chip. The band
// is its own in-flow horizontal band (A1) that stays put when the TOC toggles (A2).
function renderConn(n) {
  const band = $("connected-band"); if (!band) return;
  if (!n || !isEditorView()) { band.hidden = true; return; }
  band.hidden = false;
  const srcs = n.sources || [];

  const chips = $("connected-chips"); if (chips) {
    chips.innerHTML = "";
    // Quick action: a compact "+ Connect" chip LEADING the row, shown only when
    // the current tab's page isn't already connected. One click unions it into
    // sources[] — no need to open the drawer (mirrors #connect-current).
    const url = state.tabInfo && state.tabInfo.url;
    if (url && (state.pageKey || state.host) && !currentPageConnected(n)) {
      const add = elc("button", "conn-chip conn-chip-add");
      add.setAttribute("role", "listitem");
      add.title = "Connect this page";
      add.setAttribute("aria-label", "Connect this page to this note");
      add.appendChild(svgUse("plus", "conn-add-ic"));
      const lbl = elc("span", "conn-chip-name"); lbl.textContent = "Connect"; add.appendChild(lbl);
      add.addEventListener("click", (e) => { e.stopPropagation(); connectCurrentPage(n); });
      chips.appendChild(add);
    }
    srcs.forEach((s) => {
      const chip = elc("button", "conn-chip" + (isCurrentSource(s) ? " is-active" : ""));
      chip.setAttribute("role", "listitem");
      chip.appendChild(faviconTile(s));
      const nm = elc("span", "conn-chip-name"); nm.textContent = sourceLabel(s); chip.appendChild(nm);
      if (/^https?:/i.test(s.url || "")) { chip.title = s.url; chip.addEventListener("click", () => chrome.tabs.create({ url: s.url })); }
      chips.appendChild(chip);
    });
  }
  const cnt = String(srcs.length);
  const c1 = $("connected-count"); if (c1) c1.textContent = cnt;
  const c2 = $("connected-count-2"); if (c2) c2.textContent = cnt;
  const open = connIsOpen();
  const tgl = $("connected-toggle"); if (tgl) tgl.setAttribute("aria-expanded", String(open));
  if (open) { renderConnList(n); syncConnActions(n); }
}

// Drawer rows: 34×34 favicon, name + Current-page pill, mono URL, hover-reveal disconnect.
function renderConnList(n) {
  const list = $("connected-list"); if (!list) return;
  list.innerHTML = "";
  const q = connQuery.trim().toLowerCase();
  const srcs = (n.sources || []).filter((s) => !q || sourceLabel(s).toLowerCase().includes(q) || (s.url || s.key || "").toLowerCase().includes(q));
  if (!srcs.length) {
    const e = elc("li", "conn-empty"); e.textContent = (n.sources || []).length ? "No pages match." : "No connected pages yet."; list.appendChild(e); return;
  }
  srcs.forEach((s) => {
    const rowEl = elc("li", "conn-row" + (isCurrentSource(s) ? " is-current" : ""));
    rowEl.appendChild(faviconTile(s, "conn-row-fav"));
    const mid = elc("div", "conn-row-mid");
    const top = elc("div", "conn-row-top");
    const nm = elc("span", "conn-row-name"); nm.textContent = sourceLabel(s); top.appendChild(nm);
    if (isCurrentSource(s)) { const b = elc("span", "conn-row-pill"); b.textContent = "Current page"; top.appendChild(b); }
    mid.appendChild(top);
    const urlStr = s.url || s.key || "";
    if (/^https?:/i.test(urlStr)) {
      const a = elc("a", "conn-row-url"); a.href = urlStr; a.target = "_blank"; a.rel = "noopener noreferrer";
      const t = elc("span", "conn-row-url-t"); t.textContent = urlStr; a.appendChild(t);
      a.appendChild(svgUse("external-link", "conn-row-ext")); a.title = urlStr; mid.appendChild(a);
    } else if (urlStr) {
      const u = elc("div", "conn-row-url conn-row-url-path"); u.textContent = urlStr; u.title = "Saved before full URLs were stored — only the page path is known."; mid.appendChild(u);
    }
    rowEl.appendChild(mid);
    const rm = elc("button", "conn-row-rm"); rm.title = "Disconnect page";
    const rml = elc("span", "conn-row-rm-lbl"); rml.textContent = "Disconnect page"; rm.appendChild(rml);
    rm.appendChild(svgUse("x", "conn-row-rm-x"));
    rm.addEventListener("click", (e) => { e.stopPropagation(); disconnectSource(n, s); });
    rowEl.appendChild(rm);
    list.appendChild(rowEl);
  });
}

// The two action buttons are static in sidepanel.html; JS only reflects state.
function syncConnActions(n) {
  const connected = currentPageConnected(n);
  const hasPage = !!(state.pageKey || state.host);
  const cc = $("connect-current");
  if (cc) {
    const title = cc.querySelector(".da-title"), url = cc.querySelector(".da-url"), ic = cc.querySelector(".da-ic use");
    if (title) title.textContent = connected ? "This page is connected" : "Connect this page";
    if (url) url.textContent = hasPage ? (connected ? "Already connected" : (siteName(state.host) || state.host || "current tab")) : "No web page in view";
    if (ic) ic.setAttribute("href", connected ? "#i-check" : "#i-plus");
    cc.classList.toggle("is-done", connected);
    cc.disabled = !hasPage || connected;
  }
}

function connRefresh(n) { renderConn(n); if (connIsOpen()) { renderConnList(n); syncConnActions(n); } }
function disconnectSource(n, s) { n.sources = (n.sources || []).filter((x) => x !== s); n.updatedAt = now(); saveNotes(); connRefresh(n); }
function connectCurrentPage(n) { const url = state.tabInfo && state.tabInfo.url; if (!url) return; addSource(n, url); n.updatedAt = now(); saveNotes(); connRefresh(n); }
function addCustomUrl(n) {
  let url = (prompt("Connect this note to a page URL:") || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!pageKeyOf(url)) { setStatus("That doesn't look like a web URL", "error"); setTimeout(() => setStatus("Saved"), 1600); return; }
  addSource(n, url); n.updatedAt = now(); saveNotes(); connRefresh(n);
}
// Open = animate the band's height (CSS reads data-open → --drawer-open) with the
// drawer content fading in; the collapsed chip row is swapped for the drawer body.
function openConnDrawer() {
  const n = activeNote(); if (!n) return;
  closeAllPopovers();
  connQuery = ""; const f = $("connected-filter"); if (f) f.value = "";
  const band = $("connected-band"); if (!band) return;
  const d = $("connected-drawer"); if (d) d.hidden = false;
  band.dataset.open = "true";
  renderConnList(n); syncConnActions(n); renderConn(n);
}
function closeConnDrawer() {
  const band = $("connected-band"); if (!band) return;
  band.dataset.open = "false";
  const d = $("connected-drawer"); if (d) d.hidden = true;
  const tgl = $("connected-toggle"); if (tgl) tgl.setAttribute("aria-expanded", "false");
  const n = activeNote(); if (n && isEditorView()) renderConn(n);
}
function toggleConnDrawer() { if (connIsOpen()) closeConnDrawer(); else openConnDrawer(); }

/* ---------- Table of contents — outline bar over the editor's headings ----------
   A per-note toggle (n.tocOn, lazily created like n.numbered) reveals a sticky
   translucent bar above the editor. Its frosted dropdown lists the note's
   headings (H1/H2/H3 — the editor's top-level blocks), with a scroll-progress
   bar that hugs the bar when closed and relocates to the menu's bottom when open. */
let tocActiveIndex = 0;
// TOC is on by default; the note actions menu toggle can switch it off per-note.
function tocIsOn(n) { return !!n && n.tocOn !== false; }
// B1: build the outline from the editor's REAL heading nodes (H1/H2), queried live
// each call, so a freshly-typed heading appears without reload. Falls back to
// "No headings yet" only when zero headings exist.
function tocSections() {
  if (!editor) return [];
  return [...editor.querySelectorAll("h1, h2")]
    .map((el) => ({ el, level: +el.tagName[1], text: (el.textContent || "").trim() || "Untitled section" }));
}
// A heading's scroll offset within the editor's scroll box (robust to offsetParent).
function tocScrollTop(el) { return el.getBoundingClientRect().top - editor.getBoundingClientRect().top + editor.scrollTop; }
function tocMenuIsOpen() { const m = $("toc-menu"); return !!m && !m.hidden; }
function renderToc(n) {
  const bar = $("toc-bar"); if (!bar) return;
  if (!n || !isEditorView() || !tocIsOn(n)) { bar.hidden = true; closeTocMenu(); return; }
  bar.hidden = false;
  updateTocState();
}
function updateTocState() {
  const n = activeNote(); const bar = $("toc-bar");
  if (!n || !tocIsOn(n) || !bar || bar.hidden) return;
  const secs = tocSections(), total = secs.length, th = 46;
  let active = 0;
  for (let i = 0; i < secs.length; i++) { if (tocScrollTop(secs[i].el) - editor.scrollTop <= th) active = i; }
  tocActiveIndex = active;
  const cur = secs[active];
  const numEl = $("toc-cur-num");
  if (numEl) { const show = n.numbered && total; numEl.textContent = show ? String(active + 1) : ""; numEl.style.display = show ? "" : "none"; }
  const title = $("toc-cur-title"); if (title) title.textContent = total ? (cur ? cur.text : "") : "No headings yet";
  const pos = $("toc-pos"); if (pos) pos.textContent = total ? `${active + 1}/${total}` : "";
  const max = editor.scrollHeight - editor.clientHeight;
  const prog = max > 0 ? (editor.scrollTop / max) * 100 : 0;
  const bf = $("toc-bar-fill"), mf = $("toc-menu-fill");
  if (bf) bf.style.width = prog.toFixed(1) + "%";
  if (mf) mf.style.width = prog.toFixed(1) + "%";
  // keep the open menu's active-row highlight in sync while scrolling
  if (tocMenuIsOpen()) {
    const rows = $("toc-menu-list").querySelectorAll(".toc-menu-row");
    rows.forEach((r, i) => r.classList.toggle("is-active", i === active));
  }
}
function renderTocMenu(n) {
  const list = $("toc-menu-list"); if (!list) return; list.innerHTML = "";
  const secs = tocSections();
  if (!secs.length) { const e = elc("li", "toc-empty"); e.textContent = "No headings in this note yet."; list.appendChild(e); return; }
  secs.forEach((s, i) => {
    const li = elc("li");
    const row = elc("button", "toc-menu-row lvl" + s.level + (i === tocActiveIndex ? " is-active" : ""));
    if (n.numbered) { const num = elc("span", "toc-rownum"); num.textContent = String(i + 1); row.appendChild(num); }
    const t = elc("span", "toc-rowtitle"); t.textContent = s.text; row.appendChild(t);
    row.addEventListener("click", () => tocJump(i));
    li.appendChild(row); list.appendChild(li);
  });
}
// B3: while the menu is open the scroll-progress bar relocates to hug the menu's
// bottom edge (the bar's own progress is hidden via .is-open); it returns on close.
function openTocMenu() {
  const n = activeNote(); if (!n || !tocIsOn(n)) return;
  closeAllPopovers();
  renderTocMenu(n);
  $("toc-menu").hidden = false;
  const bar = $("toc-bar"); if (bar) { bar.classList.add("is-open"); bar.setAttribute("aria-expanded", "true"); }
  updateTocState();
}
function closeTocMenu() {
  const m = $("toc-menu"); if (m) m.hidden = true;
  const bar = $("toc-bar"); if (bar) { bar.classList.remove("is-open"); bar.setAttribute("aria-expanded", "false"); }
  updateTocState();
}
function toggleTocMenu() { if (tocMenuIsOpen()) closeTocMenu(); else openTocMenu(); }
function tocJump(i) {
  const s = tocSections()[i]; if (!s) return;
  editor.scrollTo({ top: Math.max(0, tocScrollTop(s.el) - 12), behavior: "smooth" });
  closeTocMenu();
}
// The on/off toggle (wired from the note actions menu).
function toggleToc() {
  const n = activeNote(); if (!n) return;
  n.tocOn = !tocIsOn(n); n.updatedAt = now(); saveNotes();
  if (!n.tocOn) closeTocMenu();
  renderToc(n);
  $("note-menu").hidden = true;
}

/* ---------- range / block helpers ---------- */
function focusEditor() { editor.focus(); ensureCssMode(); }
function currentBlock() {
  let n = window.getSelection().anchorNode;
  if (!n || n === editor) return null;
  while (n && n.parentNode !== editor) n = n.parentNode;
  return n && n.parentNode === editor ? n : null;
}
function caretInto(node) { const s = window.getSelection(); const r = document.createRange(); r.selectNodeContents(node); r.collapse(true); s.removeAllRanges(); s.addRange(r); editor.focus(); }
function caretIntoEnd(node) { const s = window.getSelection(); const r = document.createRange(); r.selectNodeContents(node); r.collapse(false); s.removeAllRanges(); s.addRange(r); editor.focus(); }
function caretAfter(node) { const s = window.getSelection(); const r = document.createRange(); r.setStartAfter(node); r.collapse(true); s.removeAllRanges(); s.addRange(r); editor.focus(); }
function insertBlock(node, focusEl) {
  const block = currentBlock();
  if (block) {
    const empty = block.textContent.trim() === "" && !block.querySelector("img,hr,table");
    if (empty) block.replaceWith(node); else block.after(node);
  } else editor.appendChild(node);
  const trailing = para(); node.after(trailing);
  caretInto(focusEl || trailing); queueSave();
}
function insertInline(node) {
  const s = window.getSelection(); let r;
  if (s.rangeCount && editor.contains(s.anchorNode)) r = s.getRangeAt(0); else { r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); }
  r.deleteContents(); r.insertNode(node); caretAfter(node);
}

/* ---------- inline formatting / color / badge ---------- */
function exec(cmd) { focusEditor(); if (cmd === "createLink") return addLink(); document.execCommand(cmd, false, null); queueSave(); syncToolbar(); }
function addLink() {
  focusEditor();
  const sel = window.getSelection(); const has = sel && !sel.isCollapsed;
  const url = prompt("Link URL:", "https://"); if (!url) return;
  if (has) document.execCommand("createLink", false, url);
  else { const a = elc("a"); a.href = url; a.textContent = url; insertInline(a); }
  queueSave(); syncToolbar();
}
// G2: the editor ink/badge palette is a token, never a hardcoded hex. We keep the
// six status KEYS here and resolve the live hex from tokens.css at apply time, so
// this file holds no editor-color literals and the palette re-themes with tokens.
function tokenHex(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }
function statusHex(key) { return tokenHex("--status-" + key); }
function applyColor(color) { focusEditor(); if (color) document.execCommand("foreColor", false, color); queueSave(); }
function applyBadge(key) {
  focusEditor();
  const hex = statusHex(key);
  const sel = window.getSelection();
  const span = elc("span", "badge"); span.style.color = hex; span.style.backgroundColor = rgbaFromHex(hex, 0.16);
  if (sel && !sel.isCollapsed) { const txt = sel.toString(); span.textContent = txt; const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(span); caretAfter(span); }
  else { span.textContent = "Label"; insertInline(span); }
  queueSave();
}
// Soft same-hue fill for badges: the resolved status hex at low alpha.
function rgbaFromHex(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec((hex || "").trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

/* ---------- style dropdown ---------- */
const STYLES = [
  { tag: "P", label: "Body", cls: "sd-body" },
  { tag: "H1", label: "Title", cls: "sd-h1" },
  { tag: "H2", label: "Heading", cls: "sd-h2" },
  { tag: "H3", label: "Subheading", cls: "sd-h3" },
  { tag: "BLOCKQUOTE", label: "Quote", cls: "sd-quote" },
  { tag: "PRE", label: "Code block", cls: "sd-code" }
];
function buildStyleMenu() {
  const m = $("style-menu"); m.innerHTML = "";
  STYLES.forEach((s) => { const b = elc("button"); b.dataset.tag = s.tag; b.innerHTML = `<span class="${s.cls}">${s.label}</span>`; b.addEventListener("click", () => { applyStyle(s.tag); m.hidden = true; }); m.appendChild(b); });
}
function applyStyle(tag) { focusEditor(); document.execCommand("formatBlock", false, tag); setStyleLabel(tag); queueSave(); syncToolbar(); }
function setStyleLabel(tag) { const s = STYLES.find((x) => x.tag === tag) || STYLES[0]; $("style-current").textContent = s.label; }
function syncToolbar() {
  try {
    ["bold","italic","underline","strikeThrough","insertUnorderedList","insertOrderedList"].forEach((cmd) => {
      const btn = document.querySelector('.rt-toolbar [data-cmd="' + cmd + '"]'); if (btn) btn.classList.toggle("active", document.queryCommandState(cmd));
    });
    let block = (document.queryCommandValue("formatBlock") || "").toUpperCase();
    if (!["H1","H2","H3","BLOCKQUOTE","PRE"].includes(block)) block = "P";
    setStyleLabel(block);
    $("style-menu").querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.tag === block));
  } catch (e) {}
}

/* ---------- text size (accessibility; persisted, whole-note scale) ---------- */
// [key, label, preview font-size for the Aa sample in the menu (F3)]
const SIZES = [["small","Small","13px"],["regular","Regular","15px"],["large","Large","17px"],["supersize","Supersize","20px"]];
function applyTextSize() {
  const sz = SIZES.some(([k]) => k === state.settings.textSize) ? state.settings.textSize : "regular";
  SIZES.forEach(([k]) => editor.classList.toggle("size-" + k, k === sz));
  const lbl = (SIZES.find(([k]) => k === sz) || SIZES[1])[1];
  const cur = $("size-current"); if (cur) cur.textContent = lbl;
  $("size-menu").querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.size === sz));
}
// Each row: label + an "Aa" preview at that scale; a check marks the active row.
function buildSizeMenu() {
  const m = $("size-menu"); m.innerHTML = "";
  SIZES.forEach(([k, label, px]) => {
    const b = elc("button"); b.dataset.size = k;
    const l = elc("span"); l.textContent = label;
    const aa = elc("span", "sz-aa"); aa.textContent = "Aa"; aa.style.fontSize = px;
    b.append(l, aa);
    b.addEventListener("click", () => setTextSize(k)); m.appendChild(b);
  });
}
function setTextSize(k) {
  state.settings.textSize = k; applyTextSize(); saveSettings(); $("size-menu").hidden = true;
}

/* ---------- checklist ---------- */
function checkSpan() { const c = elc("span", "check"); c.contentEditable = "false"; return c; }
function makeChecklist() {
  focusEditor();
  const block = currentBlock();
  const ul = elc("ul", "checklist"); const li = elc("li"); li.appendChild(checkSpan());
  if (block && block.textContent.trim() !== "") { while (block.firstChild) li.appendChild(block.firstChild); } else li.appendChild(br());
  ul.appendChild(li);
  if (block) block.replaceWith(ul); else editor.appendChild(ul);
  if (!ul.nextSibling) ul.after(para());
  updateChecklistCounts();
  caretIntoEnd(li); queueSave();
}
function currentChecklistLi() {
  let n = window.getSelection().anchorNode; if (!n) return null;
  while (n && n !== editor) { if (n.tagName === "LI" && n.parentNode && n.parentNode.classList && n.parentNode.classList.contains("checklist")) return n; n = n.parentNode; }
  return null;
}
function currentListItem() {
  let n = window.getSelection().anchorNode; if (!n) return null;
  while (n && n !== editor) { if (n.nodeType === 1 && n.tagName === "LI") return n; n = n.parentNode; }
  return null;
}
function updateChecklistCounts() {
  editor.querySelectorAll("ul.checklist").forEach((ul) => {
    const items = ul.querySelectorAll(":scope > li");
    const done = ul.querySelectorAll(":scope > li.checked").length;
    if (items.length) ul.setAttribute("data-count", done + "/" + items.length); else ul.removeAttribute("data-count");
  });
}
function handleChecklistEnter() {
  const li = currentChecklistLi(); if (!li) return false;
  if (li.textContent.trim() === "") { const ul = li.parentNode; const p = para(); ul.after(p); li.remove(); if (!ul.querySelector("li")) ul.remove(); else updateChecklistCounts(); caretInto(p); queueSave(); return true; }
  const nli = elc("li"); nli.appendChild(checkSpan()); nli.appendChild(br()); li.after(nli); updateChecklistCounts(); caretIntoEnd(nli); queueSave(); return true;
}

/* ---------- element library (slash + "+") ---------- */
function elDivider() { insertBlock(elc("hr")); }
function elCallout() { const d = elc("div", "callout callout-blue"); const body = elc("div", "callout-body"); const p = para(); body.appendChild(p); d.appendChild(body); insertBlock(d, p); }
function elToggle() { const det = elc("details", "toggle"); det.open = true; const sum = elc("summary"); sum.textContent = "Toggle"; const tb = elc("div", "toggle-body"); const p = para(); tb.appendChild(p); det.append(sum, tb); insertBlock(det, p); }
function elCode() { const pre = elc("pre"); const code = elc("code"); code.appendChild(br()); pre.appendChild(code); insertBlock(pre, code); }
function elTable() {
  const t = elc("table"); const thead = elc("thead"); const hr1 = elc("tr");
  for (let i = 0; i < 3; i++) { const th = elc("th"); th.textContent = "Head"; hr1.appendChild(th); } thead.appendChild(hr1);
  const tb = elc("tbody"); let first = null;
  for (let r = 0; r < 2; r++) { const tr = elc("tr"); for (let c = 0; c < 3; c++) { const td = elc("td"); td.appendChild(br()); if (!first) first = td; tr.appendChild(td); } tb.appendChild(tr); }
  t.append(thead, tb); insertBlock(t, first);
}
let savedRange = null;
function saveRange() { const s = window.getSelection(); if (s.rangeCount && editor.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); }
function restoreRange() { if (savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); } }
function elImage() { saveRange(); $("image-input").value = ""; $("image-input").click(); }
function downscale(img) {
  const max = 1280; let w = img.naturalWidth, h = img.naturalHeight;
  if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
  const c = elc("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
  try { return c.toDataURL("image/jpeg", 0.85); } catch (e) { return img.src; }
}
function handleImageFile(file) {
  if (!file || !/^image\//.test(file.type)) return;
  const reader = new FileReader();
  reader.onload = () => { const img = new Image(); img.onload = () => { const im = elc("img"); im.src = downscale(img); restoreRange(); insertBlock(im); }; img.src = reader.result; };
  reader.readAsDataURL(file);
}
function buildLinkCard(meta, loading) {
  const a = elc("a", "link-card" + (loading ? " loading" : "")); a.href = meta.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.contentEditable = "false";
  const body = elc("div", "lc-body");
  const t = elc("div", "lc-title"); t.textContent = meta.title || meta.url;
  const d = elc("div", "lc-desc"); d.textContent = meta.description || "";
  const h = elc("div", "lc-host"); h.textContent = meta.host || "";
  body.append(t, d, h); a.append(body);
  if (meta.image) { const im = elc("img", "lc-image"); im.src = meta.image; a.append(im); }
  return a;
}
function elLinkCard() {
  focusEditor();
  const url = prompt("Bookmark URL:", "https://"); if (!url) return;
  const host = hostOf(url) || "";
  const card = buildLinkCard({ url, title: url, description: "Fetching preview…", image: "", host }, true);
  insertBlock(card);
  chrome.runtime.sendMessage({ type: "fetchMeta", url }, (meta) => {
    const data = meta || { url, title: url, description: "", image: "", host };
    const nc = buildLinkCard(data, false);
    if (card.parentNode) card.replaceWith(nc);
    queueSave();
  });
}
// Slash blocks. `lu` is a Lucide sprite id (rendered as <use>); headings use a
// short text token. No literal bullet/check/glyph icons — Lucide only (D).
const ELEMENTS = [
  { key: "h1", label: "Title", icon: "H1", aliases: ["title","heading1"], run: () => applyStyle("H1") },
  { key: "h2", label: "Heading", icon: "H2", aliases: ["heading2"], run: () => applyStyle("H2") },
  { key: "h3", label: "Subheading", icon: "H3", aliases: ["heading3","subheading"], run: () => applyStyle("H3") },
  { key: "bullet", label: "Bullet list", lu: "list", aliases: ["ul","unordered","list"], run: () => exec("insertUnorderedList") },
  { key: "number", label: "Numbered", lu: "list-ordered", aliases: ["ol","ordered"], run: () => exec("insertOrderedList") },
  { key: "todo", label: "Checklist", lu: "list-checks", aliases: ["checkbox","check","task"], run: () => makeChecklist() },
  { key: "quote", label: "Quote", lu: "quote", aliases: ["blockquote"], run: () => applyStyle("BLOCKQUOTE") },
  { key: "divider", label: "Divider", lu: "minus", aliases: ["hr","rule","separator"], run: elDivider },
  { key: "callout", label: "Callout", lu: "message-square", aliases: ["banner","note","info"], run: elCallout },
  { key: "toggle", label: "Toggle", lu: "chevron-right", aliases: ["collapse","accordion","details"], run: elToggle },
  { key: "code", label: "Code", lu: "code", aliases: ["pre","snippet"], run: elCode },
  { key: "image", label: "Image", lu: "image", aliases: ["img","picture","upload"], run: elImage },
  { key: "bookmark", label: "Link card", lu: "link", aliases: ["link","bookmark","embed"], run: elLinkCard },
  { key: "table", label: "Table", lu: "table", aliases: ["grid"], run: elTable }
];
function slashIcon(e) { return e.lu ? `<svg viewBox="0 0 24 24"><use href="#i-${e.lu}"/></svg>` : (e.icon || ""); }

/* ---------- slash menu ---------- */
let slashCtx = null, slashSel = 0, slashItems = [];
function scoreEl(e, q) {
  if (!q) return 1;
  const hay = [e.key, e.label.toLowerCase(), ...(e.aliases || [])]; let best = -1;
  for (const h of hay) { if (h === q) best = Math.max(best, 100); else if (h.startsWith(q)) best = Math.max(best, 80); else if (h.includes(q)) best = Math.max(best, 40); }
  return best;
}
function filterEls(q) { q = (q || "").toLowerCase(); return ELEMENTS.map((e) => ({ e, s: scoreEl(e, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e); }
function checkSlash() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return hideSlash();
  const node = sel.anchorNode, offset = sel.anchorOffset;
  if (!node || node.nodeType !== 3 || !editor.contains(node)) return hideSlash();
  const before = node.textContent.slice(0, offset);
  const m = before.match(/(?:^|\s)\/([\w-]*)$/);
  if (!m) return hideSlash();
  slashCtx = { node, slashStart: offset - (m[1].length + 1) };
  showSlash(m[1]);
}
function showSlash(q) {
  slashItems = filterEls(q); slashSel = 0;
  const box = $("slash");
  if (!slashItems.length) { box.innerHTML = '<div class="slash-empty">No blocks match “' + q + '”</div>'; }
  else {
    let html = '<div class="slash-hint">↑↓ to move · Enter or Tab to insert</div><div class="slash-grid">';
    slashItems.forEach((e, i) => { html += `<div class="slash-item${i === 0 ? " sel" : ""}" data-i="${i}"><div class="slash-ico">${slashIcon(e)}</div><div class="slash-label">${e.label}</div></div>`; });
    box.innerHTML = html + "</div>";
    box.querySelectorAll(".slash-item").forEach((it) => { it.addEventListener("mousedown", (ev) => { ev.preventDefault(); chooseSlash(slashItems[+it.dataset.i]); }); });
  }
  // position near caret
  try {
    const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
    const pw = document.documentElement.clientWidth;
    box.hidden = false;
    let left = Math.min(r.left, pw - box.offsetWidth - 10);
    box.style.left = Math.max(8, left) + "px";
    box.style.top = (r.bottom + 6) + "px";
  } catch (e) { box.hidden = false; box.style.left = "12px"; box.style.top = "120px"; }
}
function hideSlash() { $("slash").hidden = true; slashCtx = null; slashItems = []; }
function paintSlashSel() { $("slash").querySelectorAll(".slash-item").forEach((it, i) => it.classList.toggle("sel", i === slashSel)); }
function deleteSlashText() {
  if (!slashCtx) return;
  try { const sel = window.getSelection(); const r = document.createRange(); r.setStart(slashCtx.node, slashCtx.slashStart); r.setEnd(sel.anchorNode, sel.anchorOffset); r.deleteContents(); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
}
function chooseSlash(elDef) { if (!elDef) return; deleteSlashText(); hideSlash(); elDef.run(); }

/* ---------- color / badge menu (6-color status palette) ----------
   Exactly six ink colors, exactly six badges (G2). Blue is NOT an ink color
   (blue = app). Two columns TEXT + BADGE, with a centered "Reset text color".
   Every value is a --status-* token resolved live; no hex lives in this file. */
const STATUS_KEYS = ["positive", "alert", "warning", "negative", "information", "new"];
// Neutral text colors, kept out of the 6-color status set. Values live in
// tokens.css (theme-invariant), resolved live so this file holds no hex.
const NEUTRAL_INKS = [{ title: "White", token: "--ink-white" }, { title: "Black", token: "--ink-black" }];
function buildPopovers() {
  const cp = $("color-pop"); cp.innerHTML = "";
  const cols = elc("div", "color-cols");

  const textCol = elc("div", "color-col");
  textCol.appendChild(Object.assign(elc("div", "pop-label"), { textContent: "TEXT" }));
  const g1 = elc("div", "swatch-grid");
  STATUS_KEYS.forEach((k) => {
    const s = elc("button", "swatch"); s.style.background = `var(--status-${k})`; s.title = k;
    s.addEventListener("mousedown", (e) => { e.preventDefault(); applyColor(statusHex(k)); cp.hidden = true; });
    g1.appendChild(s);
  });
  textCol.appendChild(g1);
  // NEUTRALS — white + black, in their own hairline-separated row under TEXT.
  const gN = elc("div", "swatch-grid swatch-grid-neutral");
  NEUTRAL_INKS.forEach((n) => {
    const s = elc("button", "swatch swatch-neutral"); s.style.background = `var(${n.token})`; s.title = n.title;
    s.addEventListener("mousedown", (e) => { e.preventDefault(); applyColor(tokenHex(n.token)); cp.hidden = true; });
    gN.appendChild(s);
  });
  textCol.appendChild(gN);

  const badgeCol = elc("div", "color-col");
  badgeCol.appendChild(Object.assign(elc("div", "pop-label"), { textContent: "BADGE" }));
  const g2 = elc("div", "swatch-grid");
  STATUS_KEYS.forEach((k) => {
    const s = elc("button", "swatch swatch-badge"); s.textContent = "A";
    s.style.color = `var(--status-${k})`; s.style.background = `color-mix(in srgb, var(--status-${k}) 16%, transparent)`; s.title = k;
    s.addEventListener("mousedown", (e) => { e.preventDefault(); applyBadge(k); cp.hidden = true; });
    g2.appendChild(s);
  });
  badgeCol.appendChild(g2);

  cols.append(textCol, badgeCol); cp.appendChild(cols);

  const reset = elc("button", "color-reset");
  reset.appendChild(svgUse("rotate-ccw", "color-reset-ic"));
  reset.appendChild(Object.assign(elc("span"), { textContent: "Reset text color" }));
  reset.addEventListener("mousedown", (e) => { e.preventDefault(); applyColor(tokenHex("--ink-reset")); cp.hidden = true; });
  cp.appendChild(reset);
}
function closeAllPopovers() {
  ["style-menu", "color-pop", "size-menu"].forEach((id) => { const el = $(id); if (el) el.hidden = true; });
  closeConnDrawer(); closeTocMenu();
}
function openPopover(popId, anchor) {
  closeAllPopovers();
  const pop = $(popId); pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = document.documentElement.clientWidth;
  pop.style.top = (r.bottom + 6) + "px";
  pop.style.right = "auto";
  pop.style.left = Math.max(8, Math.min(r.left, pw - pop.offsetWidth - 10)) + "px";
}

/* ---------- browser list ---------- */
function renderList() {
  const ul = $("note-list");
  let ns = state.notes.slice();
  const q = state.query.trim().toLowerCase();
  if (q) ns = ns.filter((n) => ((n.title || "") + " " + htmlToText(n.html)).toLowerCase().includes(q));
  const sort = state.settings.sort || "updated";
  const cmp = sort === "created" ? (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
            : sort === "title"   ? (a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled", undefined, { sensitivity: "base" })
            : (a, b) => b.updatedAt - a.updatedAt;
  ns.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || cmp(a, b));
  state.visibleIds = ns.map((n) => n.id);
  $("empty").hidden = ns.length > 0; ul.innerHTML = "";
  const sel = state.selectMode;
  for (const n of ns) {
    const li = elc("li", "note-row" + (sel ? " selectable" : "") + (sel && state.selected.has(n.id) ? " sel" : ""));
    const snip = htmlToText(n.html).trim().slice(0, 120) || "Empty note";
    const nh = noteHost(n); const chip = nh ? `<span class="host-chip">${nh}</span>` : "";
    const check = sel ? '<span class="row-check" aria-hidden="true"></span>' : "";
    li.innerHTML = `${check}<div class="row-main"><div class="row-top"><span class="row-title"></span>${n.pinned ? '<span class="row-pin">★</span>' : ""}</div><div class="row-snip"></div><div class="row-foot">${chip}<span class="row-time">${relTime(n.updatedAt)}</span></div></div>`;
    li.querySelector(".row-title").textContent = n.title || "Untitled";
    li.querySelector(".row-snip").textContent = snip;
    li.addEventListener("click", () => { if (state.selectMode) toggleSelected(n.id, li); else openNote(n.id); });
    ul.appendChild(li);
  }
  updateBulkBar();
}
function toggleSelected(id, li) {
  if (state.selected.has(id)) { state.selected.delete(id); li.classList.remove("sel"); }
  else { state.selected.add(id); li.classList.add("sel"); }
  updateBulkBar();
}
function updateBulkBar() {
  const bar = $("bulk-bar");
  bar.hidden = !state.selectMode;
  if (!state.selectMode) return;
  const n = state.selected.size;
  $("bulk-count").textContent = n + " selected";
  $("bulk-delete").disabled = n === 0;
  $("bulk-merge").disabled = n < 2; // merge needs at least two notes to pool
  const all = (state.visibleIds || []).length > 0 && (state.visibleIds || []).every((id) => state.selected.has(id));
  $("bulk-all").textContent = all ? "Clear all" : "Select all";
}
function setSelectMode(on) {
  state.selectMode = on; state.selected.clear();
  $("select-toggle").textContent = on ? "Done" : "Select";
  $("select-toggle").classList.toggle("active", on);
  renderList();
}
function bulkSelectAll() {
  const ids = state.visibleIds || [];
  const all = ids.length > 0 && ids.every((id) => state.selected.has(id));
  if (all) state.selected.clear(); else ids.forEach((id) => state.selected.add(id));
  renderList();
}
async function bulkDelete() {
  const n = state.selected.size; if (!n) return;
  if (!confirm(`Delete ${n} ${n === 1 ? "note" : "notes"}? This can’t be undone.`)) return;
  state.notes = state.notes.filter((x) => !state.selected.has(x.id));
  await saveNotes();
  setSelectMode(false);
}
// Pool a source object into an array, deduping by key (or host for non-web) and keeping the
// most specific URL — the array-level twin of addSource(), used when merging existing notes.
function unionSourceInto(arr, s) {
  const hit = arr.find((x) => s.key ? x.key === s.key : (!x.key && x.host === s.host));
  if (hit) { if ((s.url || "").length > (hit.url || "").length) hit.url = s.url; }
  else arr.push({ url: s.url || "", key: s.key || null, host: s.host || null, at: s.at || now() });
}
// Merge (#3): concatenate selected notes newest-first, union their source sets into one note.
async function bulkMerge() {
  const picked = state.notes.filter((n) => state.selected.has(n.id));
  if (picked.length < 2) return;
  const ordered = picked.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); // newest content on top
  // Each section keeps its original title as an inline heading above its contents, so the
  // merged note shows where each chunk came from; the newest title still becomes the note's own.
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const body = ordered.map((n) => `<h2>${esc(n.title || "Untitled")}</h2>` + ((n.html && n.html.trim()) ? n.html : "")).join("<hr>");
  const sources = [];
  ordered.forEach((n) => (n.sources || []).forEach((s) => unionSourceInto(sources, s)));
  const newest = ordered[0]; // the newest note's title survives (its content leads)
  const merged = {
    id: uid(), title: newest.title || "Untitled", autoTitle: newest.autoTitle || newest.title || "",
    html: sanitizeHtml(body), sources,
    pinned: ordered.some((n) => n.pinned), numbered: !!newest.numbered, ephemeral: false,
    createdAt: Math.min(...ordered.map((n) => n.createdAt || now())), updatedAt: now()
  };
  const snapshot = state.notes.slice(); // originals are untouched objects — undo just restores the array
  const ids = new Set(picked.map((n) => n.id));
  state.notes = [merged, ...state.notes.filter((n) => !ids.has(n.id))];
  await saveNotes();
  setSelectMode(false);
  showToast(`Merged ${picked.length} notes into “${merged.title}”`, async () => {
    state.notes = snapshot; await saveNotes(); if (!isEditorView()) renderList();
  });
}

/* ---------- transient undo toast ---------- */
let toastTimer = null;
function hideToast() { clearTimeout(toastTimer); toastTimer = null; const t = $("toast"); if (t) t.hidden = true; }
function showToast(msg, onUndo) {
  const t = $("toast"); if (!t) return;
  $("toast-msg").textContent = msg;
  const undo = $("toast-undo"); undo.hidden = !onUndo;
  undo.onclick = onUndo ? () => { hideToast(); onUndo(); } : null;
  t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 7000);
}

/* ---------- tab context + follow ---------- */
async function refreshHost() { try { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); state.host = t ? hostOf(t.url) : null; state.pageKey = t ? pageKeyOf(t.url) : null; state.tabInfo = t ? { url: t.url, title: t.title } : null; } catch { state.host = null; state.pageKey = null; state.tabInfo = null; } }
async function onTabChanged() { await refreshHost(); if (state.settings.follow && isEditorView()) await loadActiveTabNote(); }
let tabTimer = null;
function onTabChangedDebounced() { clearTimeout(tabTimer); tabTimer = setTimeout(onTabChanged, 160); }
async function setFollow(on) { state.settings.follow = on; applyLockIcon(); saveSettings(); if (on) { await refreshHost(); await loadActiveTabNote(); } }

/* ---------- selection capture (consumed from the worker's pendingCapture) ---------- */
function saveCaptureCaret() { const s = window.getSelection(); if (s.rangeCount && editor.contains(s.anchorNode)) captureCaretRange = s.getRangeAt(0).cloneRange(); }
function restoreCaptureCaret() {
  if (!captureCaretRange || !editor.contains(captureCaretRange.startContainer)) return false;
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(captureCaretRange); return true;
}
// Resolve (or create) the note for a capture's own page — mirrors the old worker logic, panel-side.
function captureTargetNote(cap) {
  const pk = cap.pageKey, host = cap.host;
  let n = state.notes.filter((x) => (x.sources || []).some((s) => pk ? s.key === pk : (!s.key && s.host === host))).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!n) {
    const title = autoTitle(host, pageTag({ url: cap.url, title: cap.title }));
    n = { id: uid(), title, autoTitle: title, html: "", sources: sourcesFor(cap.url), pinned: false, ephemeral: false, createdAt: now(), updatedAt: now() };
    state.notes.unshift(n);
  }
  return n;
}
async function consumePendingCapture() {
  let cap;
  try { const d = await chrome.storage.session.get("margin.pendingCapture"); cap = d["margin.pendingCapture"]; } catch (e) { return false; }
  if (!cap) return false;
  await chrome.storage.session.remove("margin.pendingCapture");
  if (now() - (cap.at || 0) > 15000) return false; // stale (e.g. browser restarted) — drop it
  if (cap.empty) { // paste-from-page (#5) fired with nothing selected (or an unreadable page)
    setStatus("No selection on the page", "error"); setTimeout(() => setStatus("Saved"), 1600); return false;
  }
  if (!cap.html) return false;

  // paste-from-page (#5) always lands in the note you're looking at; right-click capture obeys the
  // lock (locked -> the open/last note; unlocked -> resolve by the captured page).
  const paste = cap.mode === "paste";
  const locked = !state.settings.follow; // locked = the note stays put regardless of tab
  let target = (paste || locked) ? (activeNote() || (lastActiveId && state.notes.find((n) => n.id === lastActiveId)) || null) : null;
  if (!target) target = captureTargetNote(cap); // unlocked capture, or nothing open: resolve by the capture's page
  if (!target) return false;
  target.ephemeral = false;
  addSource(target, cap.url); // union the captured page into the note's provenance/association set

  if (state.activeId === target.id && isEditorView()) {
    // Inserting into the note you're looking at — drop it at the last caret, not the end (B5).
    editor.focus();
    if (!restoreCaptureCaret()) caretIntoEnd(editor);
    document.execCommand("insertHTML", false, sanitizeHtml(cap.html));
    updateChecklistCounts(); queueSave();
  } else {
    target.html = (target.html && target.html.trim() ? target.html : "") + cap.html;
    target.updatedAt = now();
    await saveNotes();
    openNote(target.id);
  }
  return true;
}

/* ---------- keyboard ---------- */
function onKeydown(e) {
  if (!$("slash").hidden) {
    if (e.key === "Escape") { e.preventDefault(); return hideSlash(); }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); slashSel = Math.min(slashItems.length - 1, slashSel + 1); return paintSlashSel(); }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); slashSel = Math.max(0, slashSel - 1); return paintSlashSel(); }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return chooseSlash(slashItems[slashSel]); }
  }
  const meta = e.metaKey || e.ctrlKey;
  const inEditor = document.activeElement === editor;
  // B2: inside a list, Tab/Shift-Tab indents/outdents instead of moving focus to the next
  // focusable element (a toggle's <summary>), which is what made it "jump to a far-off block".
  if (inEditor && e.key === "Tab" && !meta && !e.altKey) {
    const li = currentListItem();
    if (li) {
      e.preventDefault();
      // Checklist nesting isn't modelled yet; still swallow Tab so it can't leap focus away.
      if (!(li.parentNode && li.parentNode.classList && li.parentNode.classList.contains("checklist"))) {
        document.execCommand(e.shiftKey ? "outdent" : "indent");
        queueSave(); syncToolbar();
      }
      return;
    }
  }
  // ⌘]/⌘[ — indent / outdent (works on lists and plain text alike).
  if (inEditor && meta && !e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
    e.preventDefault(); focusEditor();
    document.execCommand(e.code === "BracketRight" ? "indent" : "outdent");
    queueSave(); syncToolbar(); return;
  }
  if (inEditor && e.altKey && meta && /^Digit[0-3]$/.test(e.code)) { e.preventDefault(); applyStyle({ Digit0: "P", Digit1: "H1", Digit2: "H2", Digit3: "H3" }[e.code]); return; }
  if (inEditor && meta && e.shiftKey && e.code === "Digit8") { e.preventDefault(); return exec("insertUnorderedList"); }
  if (inEditor && meta && e.shiftKey && e.code === "Digit7") { e.preventDefault(); return exec("insertOrderedList"); }
  if (inEditor && meta && e.shiftKey && e.code === "Digit9") { e.preventDefault(); return makeChecklist(); }
  if (inEditor && meta && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); return addLink(); }
  if (inEditor && e.key === "Enter" && !e.shiftKey && !meta) { if (handleChecklistEnter()) { e.preventDefault(); return; } }
  if (isEditorView() && meta && e.key === "Enter") { e.preventDefault(); return newNote(); }
  if (!isEditorView() && e.key === "Escape") { e.preventDefault(); return showEditor(); }
  if (isEditorView() && meta && e.key.toLowerCase() === "s") { e.preventDefault(); saveNotes(); flashSaved(); return; }
}

/* ---------- in-app guide + version log ---------- */
const GUIDE_HTML = `
<p class="lead">A fast, tab-aware notepad in your side panel. Open or close it anytime with <kbd>⌘/Ctrl + Shift + E</kbd> (rebindable below).</p>
<h2>Blocks &amp; the slash menu</h2>
<p>Type <code>/</code> anywhere for the element grid, or hit the <strong>/ cmd</strong> chip in the toolbar. Partial names work — <code>/cod</code> + <kbd>Enter</kbd> drops a code block, <code>/ban</code> a callout. Arrows move, <kbd>Enter</kbd> or <kbd>Tab</kbd> inserts.</p>
<p>Available: Title / Heading / Subheading, bullet · numbered · checklist, quote, divider, callout, toggle, code, image (uploaded &amp; downscaled, stored locally), link card (pulls a page's title/description/image), and table.</p>
<h2>Text styling</h2>
<ul>
<li>The <strong>style menu</strong> previews each option in its real style.</li>
<li><strong>B / I / U / S</strong>, text color, and a ClickUp-style <strong>badge</strong> (select text → pick a color).</li>
<li><strong>Text size</strong> — the sizer beside the style menu (Small / Regular / Large / Supersize) scales the whole note evenly. It's a sticky setting, not per-selection formatting.</li>
<li><strong>Checklist</strong>: hollow circles with a live count at the top; click a circle to check it — the line goes muted and struck through.</li>
</ul>
<h2>Margin Numbers</h2>
<p>From a note's <strong>actions</strong> menu, switch on <strong>Margin Numbers</strong> to number every block down a faint left gutter — top-level blocks <code>1, 2, 3</code>, with list items and table rows as <code>12.1, 12.2</code>. They're a live positional reference, not a permanent ID, so they renumber as you write. Per-note, off by default.</p>
<h2>Keyboard (mirrors Google Docs)</h2>
<ul>
<li>Title / Heading / Subheading — <kbd>⌥⌘ / Alt+Ctrl + 1 / 2 / 3</kbd></li>
<li>Body text — <kbd>⌥⌘ / Alt+Ctrl + 0</kbd></li>
<li>Bulleted / numbered / checklist — <kbd>⌘/Ctrl + Shift + 8 / 7 / 9</kbd></li>
<li>Indent / outdent — <kbd>Tab</kbd> / <kbd>⇧Tab</kbd> in a list, or <kbd>⌘/Ctrl + ]</kbd> / <kbd>[</kbd> anywhere</li>
<li>Link selected text — <kbd>⌘/Ctrl + K</kbd></li>
<li>New note — <kbd>⌘/Ctrl + Enter</kbd> · Save now — <kbd>⌘/Ctrl + S</kbd></li>
<li>Paste page selection into the open note — <kbd>⌘/Ctrl + Shift + Y</kbd></li>
</ul>
<h2>The lock &amp; page notes</h2>
<p>The <strong>lock</strong> (top-right) controls whether the note tracks your tabs:</p>
<ul>
<li><strong>🔒 Locked</strong> <em>(default)</em> — the note stays put no matter which tab you're on.</li>
<li><strong>🔓 Unlocked</strong> — the panel follows the active tab, surfacing that page's note as you move.</li>
</ul>
<p>Notes are matched <strong>per page</strong>, so each Claude chat or Google Doc keeps its own. Empty notes are never saved, so this stays clutter-free. New notes auto-title as <code>Site · Page · Jun 28 3:30a</code>.</p>
<p>A note remembers <strong>every page it's drawn from</strong> — its sources. Capture from another page into a note and that page joins the note's set; unlocked, the note then surfaces on <em>any</em> of those pages. The exact source URLs are kept (for provenance) but stay out of the way until you ask for them — open <strong>Note info</strong> in the note actions menu to see them, along with when the note was created and last updated.</p>
<p>Right-click any selection on a page → <strong>Save selection to Margin</strong> drops it as a sourced quote into that page's note.</p>
<p>Or select on a page and press <kbd>⌘/Ctrl + Shift + Y</kbd> — <strong>paste-from-page</strong> drops that selection straight into the note you're <em>currently</em> looking at, at your cursor, tagged with the page it came from. Because it reads the live page, the source is certain (free-form ⌘V pastes aren't tagged — the browser can't tell where copied text came from). Open <strong>Show paste sources</strong> in the note actions menu to reveal a faint <em>from ‹site›</em> under each pasted block; the full URL is on hover.</p>
<h2>Organising notes</h2>
<p>On the all-notes list, hit <strong>Select</strong> to multi-pick. From there you can <strong>Delete</strong> in bulk, or <strong>Merge</strong> two or more into one — bodies stack newest-on-top with a divider, and each chunk is headed by its original title so you can tell the pieces apart. The newest note's title becomes the merged note's, and every page the notes came from is pooled into its sources. A merge can be <strong>undone</strong> from the toast that appears.</p>
<h2>Privacy</h2>
<p>Notes live locally via <code>chrome.storage.local</code> and never leave your machine. Broad host access exists only so link cards can fetch a URL's preview; no scripts run on pages.</p>
`;
const CHANGELOG_HTML = `
<div class="ver"><span class="ver-tag">v0.10.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>Paste-from-page</strong> — select text on any page and hit <kbd>⌘/Ctrl + Shift + Y</kbd> to drop it into the note you're <strong>currently viewing</strong>, right at your cursor, tagged with the page it came from. Unlike right-click capture (which makes a quote), this is a plain paste — and because it reads the live page, the source is <strong>certain</strong>.</li>
<li><strong>Paste sources, on demand</strong> — a new <strong>Show paste sources</strong> toggle in the note actions menu reveals a faint <em>from ‹site›</em> beneath each pasted block (full URL on hover), so you can see at a glance what you wrote versus what you borrowed. Off by default; the note reads clean until you ask.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.9.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>Note info</strong> — the note actions menu gains <strong>Note info</strong>: a panel showing every <strong>source URL</strong> the note was drawn from (click to open), plus when it was <strong>created</strong> and last <strong>updated</strong>. The full URLs were always stored — this is where you see them. Older notes show the page path they carried over with.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.8.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>Merge notes</strong> — in <strong>Select</strong> mode on the all-notes list, choose two or more and hit <strong>Merge</strong>. They become one note: bodies <strong>newest on top</strong> with a divider between, each chunk <strong>headed by its original title</strong> so you can see where it came from. The newest note's title becomes the merged note's own, and every page they came from is pooled into one set.</li>
<li><strong>Undo</strong> — a merge pops a toast with <strong>Undo</strong> for a few seconds, so it's safe to try; one click puts the originals back.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.7.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>A note is a set of pages now</strong> — every note remembers the <strong>full URL(s)</strong> it was drawn from (its provenance), matched per page so it still surfaces where you'd expect. Your existing notes carry over automatically.</li>
<li><strong>Capture spans pages</strong> — saving a selection into a locked note records that page on the note, so one note can gather from many pages. Unlocked, it'll surface on any of them.</li>
<li><em>Groundwork for merging notes and a per-note info panel (URLs · created · updated), both landing next.</em></li>
</ul>
<div class="ver"><span class="ver-tag">v0.6.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>Margin Numbers</strong> — a per-note toggle (note actions menu) that numbers each block down a faint left gutter, legal-style: top-level blocks <code>1, 2, 3</code>, and list items / table rows as <code>12.1, 12.2</code>. A whisper-quiet alternating row tint shows each number's span. Positional only — it renumbers live.</li>
<li><strong>Text size</strong> — a sizer in the toolbar (Small / Regular / Large / Supersize) scales a whole note evenly. It's a setting, so it sticks across notes — accessibility, not formatting.</li>
<li><strong>Selection count</strong> — the footer now shows the live word count of whatever you've selected, beside the note total.</li>
<li><strong>Lists & indenting</strong> — <kbd>⌘/Ctrl + ]</kbd> and <kbd>[</kbd> indent / outdent lists (and plain paragraphs); a little more breathing room between items.</li>
<li><strong>Rename affordance</strong> — hovering a note's title eases in a pencil and tints the text, signalling "click to rename."</li>
<li><strong>Dark by default</strong> — the panel now opens in dark mode on first run.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.5.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>Navigation overhaul</strong> — a <strong>home</strong> icon opens your notes (a hamburger implied a menu); <strong>+ New</strong> now holds the same position on every view so it never jumps.</li>
<li><strong>Settings gear</strong> — app-level items (user guide, release notes, roadmap, keyboard shortcut) live under the gear, top-right.</li>
<li><strong>Note actions on the title row</strong> — copy, download, pin, and delete sit by the note's title where they belong.</li>
<li><strong>One color tool</strong> — text color and badge share a single menu; the toolbar icon never changes color.</li>
<li><strong>Sorting</strong> — sort the notes list by last updated, date created, or title; your choice sticks.</li>
<li><strong>Contextual titles</strong> — the in-app title now names the page you're on instead of echoing the app name.</li>
<li><strong>Roadmap, in-app</strong> — release notes and roadmap share a tabbed page; the user guide stands on its own.</li>
<li><strong>Blue mark</strong> — one mid-tone glyph that reads on light and dark surfaces alike.</li>
<li><strong>Default shortcut</strong> is now <code>⌘/Ctrl + Shift + E</code>.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.4.3</span><span class="ver-date">Jun 28, 2026</span></div>
<ul>
<li><strong>Bulk delete</strong> — Select on the all-notes list to multi-select and clear notes in one pass.</li>
<li><strong>Checklist count</strong> — a small n/n tally sits at the top of each checklist.</li>
<li><strong>Cleaner toolbar</strong> — text-color and badge icons no longer show a color chip; removed the separate highlight tool (badges cover it) and the callout's lightbulb.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.4.2</span><span class="ver-date">Jun 28, 2026</span></div>
<ul>
<li><strong>Bare glyph icon</strong> — dropped the tile; the mark now ships in black and white, and the toolbar icon auto-matches your browser's light/dark theme.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.4.1</span><span class="ver-date">Jun 28, 2026</span></div>
<ul>
<li><strong>New app icon</strong> — the browser-edit mark on a Margin-blue tile, used everywhere Chrome shows an icon.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.4.0</span><span class="ver-date">Jun 28, 2026</span></div>
<ul>
<li><strong>Page-granular notes</strong> — matching moved from domain to per-page, so multiple Claude tabs or a Doc vs a Sheet each keep a distinct note.</li>
<li><strong>In-app Guide &amp; Version log</strong> — this screen, from the actions menu.</li>
<li><strong>Wordmark</strong> — Margin · Side notes for the web.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.3.1</span><span class="ver-date">Jun 28, 2026</span></div>
<ul>
<li><strong>Richer auto-titles</strong> — <code>Site · Page · time</code>, inferring a page identifier from the tab title (falling back to the URL path, e.g. Document vs Spreadsheets).</li>
<li><strong>Lock semantics fixed</strong> — locked now means "stays put," unlocked means "follows tabs."</li>
</ul>
<div class="ver"><span class="ver-tag">v0.3.0</span><span class="ver-date">Jun 28, 2026</span></div>
<ul>
<li><strong>Block editor</strong> — slash menu and an element library: callout, toggle, code, image, link card, table.</li>
<li>Text color, highlight, and badges; a checklist block; Google-Docs keyboard shortcuts.</li>
<li>Whitelist sanitizer hardened to preserve block markup while blocking scripts.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.2.0</span><span class="ver-date">Earlier</span></div>
<ul>
<li>Rich text, tab-aware notes, the lock toggle, and one-key panel open/close.</li>
</ul>
<div class="ver"><span class="ver-tag">v0.1.0</span><span class="ver-date">Earlier</span></div>
<ul>
<li>First cut — side-panel notepad, per-site notes, right-click selection capture.</li>
</ul>
`;
/* ---------- minimal markdown -> html (for the packaged ROADMAP.md) ---------- */
function mdInline(s) {
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function mdToHtml(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  let html = "", para = [], list = null;
  const flushP = () => { if (para.length) { html += "<p>" + mdInline(para.join(" ")) + "</p>"; para = []; } };
  const flushL = () => { if (list) { html += "</" + list + ">"; list = null; } };
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushP(); flushL(); continue; }
    let m;
    if (/^---+$/.test(line.trim())) { flushP(); flushL(); html += "<hr/>"; continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushP(); flushL(); const lv = m[1].length; html += "<h" + lv + ">" + mdInline(m[2]) + "</h" + lv + ">"; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushP(); if (list !== "ul") { flushL(); list = "ul"; html += "<ul>"; } html += "<li>" + mdInline(m[1]) + "</li>"; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushP(); flushL(); html += "<blockquote>" + mdInline(m[1]) + "</blockquote>"; continue; }
    flushL(); para.push(line.trim());
  }
  flushP(); flushL();
  return html;
}
let roadmapCache = null;
async function loadRoadmap() {
  if (roadmapCache) return roadmapCache;
  try { const r = await fetch(chrome.runtime.getURL("ROADMAP.md")); roadmapCache = mdToHtml(await r.text()); }
  catch (e) { roadmapCache = "<p>Roadmap file unavailable.</p>"; }
  return roadmapCache;
}

let infoMode = "guide"; // guide | changelog | roadmap
async function renderInfo() {
  const body = $("info-body");
  if (infoMode === "guide") body.innerHTML = GUIDE_HTML;
  else if (infoMode === "changelog") body.innerHTML = CHANGELOG_HTML;
  else { body.innerHTML = '<p class="rm-loading">Loading roadmap…</p>'; body.innerHTML = await loadRoadmap(); }
  body.scrollTop = 0;
  document.querySelectorAll("#info-seg .seg-btn").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === infoMode));
}
function openInfo(mode) {
  infoMode = mode || "guide";
  $("note-menu").hidden = true; $("app-menu").hidden = true; closeAllPopovers();
  const isGuide = infoMode === "guide";
  $("info-seg").hidden = isGuide;
  $("info-title").textContent = isGuide ? "User guide" : "Release notes & roadmap";
  renderInfo(); activate("view-info");
}

/* ---------- wiring ---------- */
function bind() {
  editor = $("editor");
  buildStyleMenu(); buildPopovers(); buildSizeMenu(); applyTextSize();

  // Topbar icons (home / settings) are static Lucide <use> sprites in the HTML now.
  $("open-browser").addEventListener("click", showBrowser);
  const openAppMenu = (e) => { e.stopPropagation(); closeAllPopovers(); $("note-menu").hidden = true; $("app-menu").hidden = !$("app-menu").hidden; };
  $("app-menu-btn").addEventListener("click", openAppMenu);
  $("app-menu-btn-2").addEventListener("click", openAppMenu);
  $("note-menu-btn").addEventListener("click", (e) => { e.stopPropagation(); closeAllPopovers(); $("app-menu").hidden = true; syncNoteMenu(); $("note-menu").hidden = !$("note-menu").hidden; });
  $("back").addEventListener("click", () => { const n = activeNote(); if (n) openNote(n.id); else ensureForActiveTab(); });
  $("info-back").addEventListener("click", () => { const n = activeNote(); if (n) openNote(n.id); else ensureForActiveTab(); });
  document.querySelectorAll("#info-seg .seg-btn").forEach((b) => b.addEventListener("click", () => { infoMode = b.dataset.tab; renderInfo(); }));
  $("new-note").addEventListener("click", newNote);
  $("new-note-2").addEventListener("click", newNote);
  $("lock-toggle").addEventListener("click", () => setFollow(!state.settings.follow));
  // theme-toggle removed from the app bar; toggleTheme() stays for a settings-page
  // control. Wire it only if the button exists so removal can't break init.
  { const tt = $("theme-toggle"); if (tt) tt.addEventListener("click", toggleTheme); }

  // Locked note-menu set (F2): connected · toc · mnumbers · copy · download · favorite · delete.
  // The single Download row exposes both formats as clickable .md / .html chips.
  const dlHint = $("note-menu").querySelector('[data-act="export"] .menu-hint');
  if (dlHint) {
    dlHint.textContent = "";
    ["md", "html"].forEach((f, i) => {
      if (i) dlHint.appendChild(document.createTextNode(" · "));
      const chip = elc("span", "dl-fmt"); chip.dataset.fmt = f; chip.textContent = "." + f; dlHint.appendChild(chip);
    });
  }
  $("note-menu").addEventListener("click", (e) => {
    const fmtEl = e.target.closest("[data-fmt]");
    if (fmtEl) { e.stopPropagation(); $("note-menu").hidden = true; exportNote(fmtEl.dataset.fmt); return; }
    const btn = e.target.closest("button"); if (!btn) return; $("note-menu").hidden = true;
    ({ connected: openConnDrawer, toc: toggleToc, mnumbers: toggleMarginNumbers, copy: copyNote,
       export: () => exportNote("md"), favorite: togglePin, delete: deleteNote }[btn.dataset.act] || (() => {}))();
  });
  $("app-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return; $("app-menu").hidden = true;
    ({ guide: () => openInfo("guide"), changelog: () => openInfo("changelog"),
       settings: () => { try { chrome.runtime.openOptionsPage && chrome.runtime.openOptionsPage(); } catch (e) {} },
       shortcut: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) }[btn.dataset.act] || (() => {}))();
  });
  $("sort-select").addEventListener("change", (e) => { state.settings.sort = e.target.value; saveSettings(); renderList(); });

  $("title-edit").addEventListener("click", () => { const t = $("title"); t.focus(); t.select(); });
  $("title").addEventListener("input", queueSave);
  editor.addEventListener("input", () => { updateChecklistCounts(); queueSave(); checkSlash(); });
  editor.addEventListener("focus", ensureCssMode);
  editor.addEventListener("keyup", (e) => { if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) checkSlash(); });
  editor.addEventListener("paste", (e) => {
    e.preventDefault(); const html = e.clipboardData.getData("text/html"), text = e.clipboardData.getData("text/plain");
    if (html) document.execCommand("insertHTML", false, sanitizeHtml(html)); else document.execCommand("insertText", false, text);
  });
  editor.addEventListener("click", (e) => {
    const c = e.target.closest && e.target.closest(".check");
    if (c && editor.contains(c)) { const li = c.closest("li"); if (li) { li.classList.toggle("checked"); updateChecklistCounts(); queueSave(); } return; }
    // Links inside a contenteditable don't navigate — a click just drops the caret. Open them
    // ourselves so citation links and inline links are actually active.
    const a = e.target.closest && e.target.closest("a[href]");
    if (a && editor.contains(a)) {
      const href = a.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) { e.preventDefault(); window.open(href, "_blank", "noopener,noreferrer"); }
    }
  });

  // style dropdown
  $("style-trigger").addEventListener("click", (e) => { e.stopPropagation(); const open = $("style-menu").hidden; closeAllPopovers(); if (open) { openPopover("style-menu", $("style-trigger")); syncToolbar(); } });
  $("size-trigger").addEventListener("click", (e) => { e.stopPropagation(); const open = $("size-menu").hidden; closeAllPopovers(); if (open) { applyTextSize(); openPopover("size-menu", $("size-trigger")); } });
  // toolbar commands
  document.querySelectorAll('.rt-toolbar [data-cmd]').forEach((b) => b.addEventListener("click", () => exec(b.dataset.cmd)));
  $("checklist-btn").addEventListener("click", makeChecklist);
  $("mn-toggle").addEventListener("click", (e) => { e.stopPropagation(); toggleMarginNumbers(); focusEditor(); });
  $("plus-btn").addEventListener("click", (e) => { e.stopPropagation(); focusEditor(); slashCtx = null; showSlash(""); });
  $("color-btn").addEventListener("click", (e) => { e.stopPropagation(); saveRange(); openPopover("color-pop", $("color-btn")); });

  // Connected-pages band (static shell in HTML; JS drives open/close + list).
  $("connected-toggle").addEventListener("click", (e) => { e.stopPropagation(); toggleConnDrawer(); });
  const connClose = $("connected-drawer") && $("connected-drawer").querySelector('[data-act="close-connected"]');
  if (connClose) connClose.addEventListener("click", (e) => { e.stopPropagation(); closeConnDrawer(); });
  $("connected-filter").addEventListener("input", (e) => { connQuery = e.target.value; const n = activeNote(); if (n) renderConnList(n); });
  $("connect-current").addEventListener("click", () => { const n = activeNote(); if (n) connectCurrentPage(n); });
  $("connect-custom").addEventListener("click", () => { const n = activeNote(); if (n) addCustomUrl(n); });

  $("image-input").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) handleImageFile(f); });

  $("search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
  $("select-toggle").addEventListener("click", () => setSelectMode(!state.selectMode));
  $("bulk-all").addEventListener("click", bulkSelectAll);
  $("bulk-merge").addEventListener("click", bulkMerge);
  $("bulk-delete").addEventListener("click", bulkDelete);

  document.addEventListener("selectionchange", () => { if (document.activeElement === editor) { syncToolbar(); saveCaptureCaret(); updateCounts(); } });
  document.addEventListener("keydown", onKeydown);

  // Table of contents: track scroll for the progress bar + active section; the bar toggles its menu.
  let tocRaf = 0;
  editor.addEventListener("scroll", () => { if ($("toc-bar").hidden) return; if (tocRaf) return; tocRaf = requestAnimationFrame(() => { tocRaf = 0; updateTocState(); }); });
  $("toc-bar").addEventListener("click", (e) => { e.stopPropagation(); toggleTocMenu(); });

  document.addEventListener("click", (e) => {
    const onApp = e.target.closest && (e.target.closest("#app-menu-btn") || e.target.closest("#app-menu-btn-2"));
    const onNote = e.target.closest && e.target.closest("#note-menu-btn");
    if (!$("app-menu").hidden && !$("app-menu").contains(e.target) && !onApp) $("app-menu").hidden = true;
    if (!$("note-menu").hidden && !$("note-menu").contains(e.target) && !onNote) $("note-menu").hidden = true;
    if (!$("slash").hidden && !$("slash").contains(e.target)) hideSlash();
    const inBar = e.target.closest && e.target.closest(".rt-toolbar");
    if (!inBar) ["style-menu","color-pop","size-menu"].forEach((id) => { const p = $(id); if (p && !p.hidden && !p.contains(e.target)) p.hidden = true; });
    // Connected-pages drawer: dismiss on outside click, but not when the click is
    // on the band itself (its toggle) or the note-menu entry that opens it.
    const onConn = e.target.closest && (e.target.closest("#connected-band") || e.target.closest("#note-menu"));
    if (connIsOpen() && !onConn) closeConnDrawer();
    // TOC dropdown: dismiss on outside click, but not on its own bar toggle.
    const onToc = e.target.closest && (e.target.closest("#toc-bar") || e.target.closest("#toc-menu"));
    if (tocMenuIsOpen() && !onToc) closeTocMenu();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes["margin.pendingCapture"] && changes["margin.pendingCapture"].newValue) { consumePendingCapture(); return; }
    if (area !== "local" || !changes[STORE_KEY]) return;
    state.notes = changes[STORE_KEY].newValue || [];
    if (!isEditorView()) { renderList(); return; }
    const n = activeNote(); const typing = document.activeElement === editor || document.activeElement === $("title");
    if (n && !typing) openNote(n.id);
  });

  chrome.tabs.onActivated.addListener(onTabChangedDebounced);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "complete" || info.url) onTabChangedDebounced(); });
  if (chrome.windows) chrome.windows.onFocusChanged.addListener(onTabChangedDebounced);
}

/* ---------- copy / export ---------- */
async function copyNote() { const n = activeNote(); if (!n) return; try { await navigator.clipboard.writeText(editor.innerText || ""); setStatus("Copied", "saved"); setTimeout(() => setStatus("Saved"), 1200); } catch { setStatus("Copy failed", "error"); } $("note-menu").hidden = true; }
// Serialize the note body's block set (headings, paragraphs, lists, checklist,
// quote, code, divider + inline bold/italic/strike/link/code) to Markdown.
function htmlToMarkdown(html) {
  const root = elc("div"); root.innerHTML = html || "";
  const inline = (node) => {
    let out = "";
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) { out += c.textContent; return; }
      if (c.nodeType !== 1) return;
      const t = c.tagName, inner = inline(c);
      if (t === "B" || t === "STRONG") out += `**${inner}**`;
      else if (t === "I" || t === "EM") out += `*${inner}*`;
      else if (t === "S" || t === "STRIKE" || t === "DEL") out += `~~${inner}~~`;
      else if (t === "A") out += `[${inner}](${c.getAttribute("href") || ""})`;
      else if (t === "CODE") out += `\`${inner}\``;
      else if (t === "BR") out += "\n";
      else out += inner; // U and any other wrapper: pass text through
    });
    return out;
  };
  const lines = [];
  const emitList = (el, ordered) => {
    const checklist = el.classList.contains("checklist");
    let i = 0;
    [...el.children].forEach((li) => {
      if (li.tagName !== "LI") return;
      i++;
      const mark = checklist ? (li.classList.contains("checked") ? "- [x] " : "- [ ] ") : (ordered ? `${i}. ` : "- ");
      lines.push(mark + inline(li).trim());
    });
    lines.push("");
  };
  [...root.children].forEach((el) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) lines.push("#".repeat(+t[1]) + " " + inline(el).trim(), "");
    else if (t === "P") lines.push(inline(el).trim(), "");
    else if (t === "UL") emitList(el, false);
    else if (t === "OL") emitList(el, true);
    else if (t === "BLOCKQUOTE") lines.push("> " + inline(el).trim().replace(/\n/g, "\n> "), "");
    else if (t === "PRE") lines.push("```", (el.textContent || "").replace(/\n$/, ""), "```", "");
    else if (t === "HR") lines.push("---", "");
    else { const s = inline(el).trim(); if (s) lines.push(s, ""); }
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function exportNote(fmt) {
  const n = activeNote(); if (!n) return;
  const base = (n.title || "note").replace(/[^\w\-]+/g, "-").slice(0, 40) || "note";
  let doc, mime, ext;
  if (fmt === "md") {
    doc = `# ${n.title || "Untitled"}\n\n` + htmlToMarkdown(sanitizeHtml(n.html || ""));
    mime = "text/markdown"; ext = ".md";
  } else {
    doc = `<!doctype html><meta charset="utf-8"><title>${(n.title || "note").replace(/[<>&]/g, "")}</title><h1>${n.title || "Untitled"}</h1>` + sanitizeHtml(n.html || "");
    mime = "text/html"; ext = ".html";
  }
  const blob = new Blob([doc], { type: mime }); const url = URL.createObjectURL(blob);
  const a = elc("a"); a.href = url; a.download = base + ext; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); $("note-menu").hidden = true;
}

/* ---------- close-port ----------
   The worker tracks "is this window's panel open?" via this port. MV3 workers sleep and
   wipe that map, so we reconnect whenever the port drops (re-announcing open=true to the
   freshly-woken worker) and ping periodically to keep it warm — this is what makes the
   toggle shortcut deterministic instead of sporadic. A broadcast "closePanel" covers the
   case where the worker restarted cold and only has a rehydrated, port-less entry. */
(async () => {
  let win;
  try { win = await chrome.windows.getCurrent(); } catch (e) { return; }
  const wid = win.id;
  let port = null;
  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: "panel:" + wid });
      port.onMessage.addListener((m) => { if (m && m.type === "close") window.close(); });
      port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 200); });
    } catch (e) { port = null; }
  };
  connect();
  setInterval(() => { try { if (port) port.postMessage({ type: "ping" }); else connect(); } catch (e) {} }, 20000);
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "closePanel" && m.windowId === wid) window.close(); });
})();

/* ---------- boot ---------- */
async function init() {
  await load();
  applyTheme(); applyLockIcon();
  bind();
  await refreshHost();
  try { const d = await chrome.storage.session.get("margin.activeId"); lastActiveId = d["margin.activeId"] || null; } catch (e) {}
  // A right-click capture may have opened us; let it place the note. Otherwise open the tab's note.
  const handled = await consumePendingCapture();
  if (!handled) await ensureForActiveTab();
}
init();
