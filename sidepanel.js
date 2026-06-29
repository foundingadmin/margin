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
const ALLOWED_CLASSES = new Set(["callout","callout-blue","callout-green","callout-yellow","callout-red","callout-gray","callout-body","checklist","checked","check","badge","toggle","toggle-body","link-card","loading","lc-body","lc-title","lc-desc","lc-host","lc-image","src"]);
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
async function saveNotes() { await chrome.storage.local.set({ [STORE_KEY]: state.notes }); }
async function saveSettings() { await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }); }

/* ---------- theme (binary) ---------- */
const ICON = {
  lockClosed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  lockOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.4-1.7"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
};
function applyTheme() {
  const dark = state.settings.theme === "dark";
  document.body.classList.toggle("dark", dark);
  const tb = $("theme-toggle");
  tb.innerHTML = dark ? ICON.moon : ICON.sun;
  tb.classList.toggle("on", dark);
  tb.title = dark ? "Dark mode (click for light)" : "Light mode (click for dark)";
}
function toggleTheme() { state.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; applyTheme(); saveSettings(); }
function applyLockIcon() {
  const following = !!state.settings.follow; // follow=true => note changes per tab => UNLOCKED
  const b = $("lock-toggle");
  b.innerHTML = following ? ICON.lockOpen : ICON.lockClosed;
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
  closeAllPopovers();
  activate("view-browser");
  state.query = ""; $("search").value = "";
  state.selectMode = false; state.selected.clear();
  $("select-toggle").textContent = "Select"; $("select-toggle").classList.remove("active");
  $("sort-select").value = state.settings.sort || "updated";
  renderList();
}

/* ---------- editor core ---------- */
let saveTimer = null, cssModeSet = false;
function setStatus(t, saving) { const el = $("save-status"); el.textContent = t; el.classList.toggle("saving", !!saving); }
function activeNote() { return state.notes.find((x) => x.id === state.activeId); }
function ensureCssMode() { if (!cssModeSet) { try { document.execCommand("styleWithCSS", false, true); } catch (e) {} cssModeSet = true; } }
function openNote(id) {
  const n = state.notes.find((x) => x.id === id); if (!n) return;
  state.activeId = id; lastActiveId = id;
  try { chrome.storage.session.set({ "margin.activeId": id }); } catch (e) {}
  $("title").value = n.title || "";
  editor.innerHTML = sanitizeHtml(n.html || "");
  updateChecklistCounts();
  editor.classList.toggle("numbered", !!n.numbered);
  $("mn-label").textContent = n.numbered ? "Hide Margin Numbers" : "Show Margin Numbers";
  $("pin-label").textContent = n.pinned ? "Unpin note" : "Pin note";
  $("note-menu").hidden = true;
  setStatus("Saved"); updateCounts(); syncToolbar();
  showEditor();
}
function updateCounts() {
  const text = editor.innerText || "";
  const words = (text.trim().match(/\S+/g) || []).length;
  const chars = text.replace(/\u200B/g, "").replace(/\n$/, "").length;
  let out = `${words} ${words === 1 ? "word" : "words"} · ${chars} ${chars === 1 ? "character" : "characters"}`;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode) && editor.contains(sel.focusNode)) {
    const str = sel.toString();
    const selChars = str.length;
    if (selChars > 0) { const selWords = (str.trim().match(/\S+/g) || []).length; out += `  ·  ${selWords} ${selWords === 1 ? "word" : "words"} selected`; }
  }
  $("counts").textContent = out;
}
function queueSave() {
  const n = activeNote(); if (!n) return;
  n.title = $("title").value;
  n.html = sanitizeHtml(editor.innerHTML);
  if (n.ephemeral && htmlToText(n.html).trim() !== "") n.ephemeral = false;
  n.updatedAt = now();
  setStatus("Saving…", true); updateCounts();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await saveNotes(); setStatus("Saved"); }, 400);
}
function flashSaved() { setStatus("Saved ✓"); setTimeout(() => setStatus("Saved"), 900); }

async function newNote() { await refreshHost(); pruneIfEmpty(state.activeId); const n = createContextualNote(state.host, true); await saveNotes(); openNote(n.id); editor.focus(); }
async function ensureForActiveTab() { let n = latestContextNote(); if (!n) { n = createContextualNote(state.host, true); await saveNotes(); } openNote(n.id); }
async function loadActiveTabNote() { pruneIfEmpty(state.activeId); let n = latestContextNote(); if (!n) n = createContextualNote(state.host, true); await saveNotes(); openNote(n.id); }
async function deleteNote() {
  const n = activeNote(); if (!n) return;
  if (!confirm(`Delete “${n.title || "this note"}”? This can’t be undone.`)) return;
  state.notes = state.notes.filter((x) => x.id !== n.id); await saveNotes(); await ensureForActiveTab();
}
function togglePin() { const n = activeNote(); if (!n) return; n.pinned = !n.pinned; n.updatedAt = now(); $("pin-label").textContent = n.pinned ? "Unpin note" : "Pin note"; saveNotes(); $("note-menu").hidden = true; }
function toggleMarginNumbers() {
  const n = activeNote(); if (!n) return;
  n.numbered = !n.numbered; n.updatedAt = now();
  editor.classList.toggle("numbered", n.numbered);
  $("mn-label").textContent = n.numbered ? "Hide Margin Numbers" : "Show Margin Numbers";
  saveNotes(); $("note-menu").hidden = true;
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
function applyColor(color) { focusEditor(); document.execCommand("foreColor", false, color); queueSave(); }
function applyBadge(bg, fg) {
  focusEditor();
  const sel = window.getSelection();
  const span = elc("span", "badge"); span.style.backgroundColor = bg; span.style.color = fg;
  if (sel && !sel.isCollapsed) { const txt = sel.toString(); span.textContent = txt; const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(span); caretAfter(span); }
  else { span.textContent = "Label"; insertInline(span); }
  queueSave();
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
const SIZES = [["small","Small"],["regular","Regular"],["large","Large"],["supersize","Supersize"]];
function applyTextSize() {
  const sz = SIZES.some(([k]) => k === state.settings.textSize) ? state.settings.textSize : "regular";
  SIZES.forEach(([k]) => editor.classList.toggle("size-" + k, k === sz));
  const lbl = (SIZES.find(([k]) => k === sz) || SIZES[1])[1];
  const cur = $("size-current"); if (cur) cur.textContent = lbl;
  $("size-menu").querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.size === sz));
}
function buildSizeMenu() {
  const m = $("size-menu"); m.innerHTML = "";
  SIZES.forEach(([k, label]) => { const b = elc("button"); b.dataset.size = k; b.textContent = label; b.addEventListener("click", () => setTextSize(k)); m.appendChild(b); });
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
const ELEMENTS = [
  { key: "h1", label: "Title", icon: "H₁", aliases: ["title","heading1"], run: () => applyStyle("H1") },
  { key: "h2", label: "Heading", icon: "H₂", aliases: ["heading2"], run: () => applyStyle("H2") },
  { key: "h3", label: "Subheading", icon: "H₃", aliases: ["heading3","subheading"], run: () => applyStyle("H3") },
  { key: "bullet", label: "Bullet list", icon: "•", aliases: ["ul","unordered","list"], run: () => exec("insertUnorderedList") },
  { key: "number", label: "Numbered", icon: "1.", aliases: ["ol","ordered"], run: () => exec("insertOrderedList") },
  { key: "todo", label: "Checklist", icon: "☑", aliases: ["checkbox","check","task"], run: () => makeChecklist() },
  { key: "quote", label: "Quote", icon: "❝", aliases: ["blockquote"], run: () => applyStyle("BLOCKQUOTE") },
  { key: "divider", label: "Divider", icon: "—", aliases: ["hr","rule","separator"], run: elDivider },
  { key: "callout", label: "Callout", icon: "💡", aliases: ["banner","note","info"], run: elCallout },
  { key: "toggle", label: "Toggle", icon: "▸", aliases: ["collapse","accordion","details"], run: elToggle },
  { key: "code", label: "Code", icon: "{ }", aliases: ["pre","snippet"], run: elCode },
  { key: "image", label: "Image", icon: "🖼", aliases: ["img","picture","upload"], run: elImage },
  { key: "bookmark", label: "Link card", icon: "🔗", aliases: ["link","bookmark","embed"], run: elLinkCard },
  { key: "table", label: "Table", icon: "▦", aliases: ["grid"], run: elTable }
];

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
    slashItems.forEach((e, i) => { html += `<div class="slash-item${i === 0 ? " sel" : ""}" data-i="${i}"><div class="slash-ico">${e.icon}</div><div class="slash-label">${e.label}</div></div>`; });
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

/* ---------- popovers ---------- */
const TEXT_COLORS = ["#e23b3b","#e07b1a","#d6a400","#2ea043","#2f6fed","#7c3aed","#db2777","#111111","#6b7280","#0e7490","#9a3412","#1f2937"];
const BADGE_COLORS = [["#e8f0fe","#2f6fed"],["#fde8e8","#c0392b"],["#fff1d6","#b7791f"],["#e6f6ea","#2e7d32"],["#f1e7fd","#7c3aed"],["#fce7f1","#db2777"],["#eceff3","#475569"],["#1f2937","#ffffff"]];
function buildPopovers() {
  const cp = $("color-pop"); cp.innerHTML = "";
  const s1 = elc("div", "pop-section"); s1.innerHTML = '<div class="pop-label">Text color</div>';
  const g1 = elc("div", "swatch-grid");
  TEXT_COLORS.forEach((c) => { const s = elc("div", "swatch"); s.style.background = c; s.addEventListener("mousedown", (e) => { e.preventDefault(); applyColor(c); cp.hidden = true; }); g1.appendChild(s); });
  s1.appendChild(g1); cp.appendChild(s1);

  const s2 = elc("div", "pop-section"); s2.innerHTML = '<div class="pop-label">Badge</div>';
  const g2 = elc("div", "swatch-grid");
  BADGE_COLORS.forEach(([bg, fg]) => { const s = elc("div", "swatch"); s.style.background = bg; s.style.color = fg; s.textContent = "A"; s.style.display = "grid"; s.style.placeItems = "center"; s.style.fontWeight = "700"; s.style.fontSize = "12px"; s.addEventListener("mousedown", (e) => { e.preventDefault(); applyBadge(bg, fg); cp.hidden = true; }); g2.appendChild(s); });
  s2.appendChild(g2); cp.appendChild(s2);
}
function closeAllPopovers() { ["style-menu","color-pop","size-menu"].forEach((id) => { $(id).hidden = true; }); }
function openPopover(popId, anchor) {
  closeAllPopovers();
  const pop = $(popId); pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = document.documentElement.clientWidth;
  pop.style.top = (r.bottom + 6) + "px";
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
  if (!cap || !cap.html) return false;
  await chrome.storage.session.remove("margin.pendingCapture");
  if (now() - (cap.at || 0) > 15000) return false; // stale (e.g. browser restarted) — drop it

  const locked = !state.settings.follow; // locked = the note stays put regardless of tab
  let target = locked ? (activeNote() || (lastActiveId && state.notes.find((n) => n.id === lastActiveId)) || null) : null;
  if (!target) target = captureTargetNote(cap); // unlocked, or nothing open: resolve by the capture's page
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
<p>Type <code>/</code> anywhere for the element grid, or hit <strong>＋</strong> in the toolbar. Partial names work — <code>/cod</code> + <kbd>Enter</kbd> drops a code block, <code>/ban</code> a callout. Arrows move, <kbd>Enter</kbd> or <kbd>Tab</kbd> inserts.</p>
<p>Available: Title / Heading / Subheading, bullet · numbered · checklist, quote, divider, callout, toggle, code, image (uploaded &amp; downscaled, stored locally), link card (pulls a page's title/description/image), and table.</p>
<h2>Text styling</h2>
<ul>
<li>The <strong>style menu</strong> previews each option in its real style.</li>
<li><strong>B / I / U / S</strong>, text color, and a ClickUp-style <strong>badge</strong> (select text → pick a color).</li>
<li><strong>Text size</strong> — the sizer beside the style menu (Small / Regular / Large / Supersize) scales the whole note evenly. It's a sticky setting, not per-selection formatting.</li>
<li><strong>Checklist</strong>: hollow circles with a live count at the top; click a circle to check it — the line goes muted and struck through.</li>
</ul>
<h2>Margin Numbers</h2>
<p>From a note's <strong>⋯</strong> menu, switch on <strong>Margin Numbers</strong> to number every block down a faint left gutter — top-level blocks <code>1, 2, 3</code>, with list items and table rows as <code>12.1, 12.2</code>. They're a live positional reference, not a permanent ID, so they renumber as you write. Per-note, off by default.</p>
<h2>Keyboard (mirrors Google Docs)</h2>
<ul>
<li>Title / Heading / Subheading — <kbd>⌥⌘ / Alt+Ctrl + 1 / 2 / 3</kbd></li>
<li>Body text — <kbd>⌥⌘ / Alt+Ctrl + 0</kbd></li>
<li>Bulleted / numbered / checklist — <kbd>⌘/Ctrl + Shift + 8 / 7 / 9</kbd></li>
<li>Indent / outdent — <kbd>Tab</kbd> / <kbd>⇧Tab</kbd> in a list, or <kbd>⌘/Ctrl + ]</kbd> / <kbd>[</kbd> anywhere</li>
<li>Link selected text — <kbd>⌘/Ctrl + K</kbd></li>
<li>New note — <kbd>⌘/Ctrl + Enter</kbd> · Save now — <kbd>⌘/Ctrl + S</kbd></li>
</ul>
<h2>The lock &amp; page notes</h2>
<p>The <strong>lock</strong> (top-right) controls whether the note tracks your tabs:</p>
<ul>
<li><strong>🔒 Locked</strong> <em>(default)</em> — the note stays put no matter which tab you're on.</li>
<li><strong>🔓 Unlocked</strong> — the panel follows the active tab, surfacing that page's note as you move.</li>
</ul>
<p>Notes are matched <strong>per page</strong>, so each Claude chat or Google Doc keeps its own. Empty notes are never saved, so this stays clutter-free. New notes auto-title as <code>Site · Page · Jun 28 3:30a</code>.</p>
<p>A note remembers <strong>every page it's drawn from</strong> — its sources. Capture from another page into a note and that page joins the note's set; unlocked, the note then surfaces on <em>any</em> of those pages. The exact source URLs are kept (for provenance) but stay out of the way until you ask for them.</p>
<p>Right-click any selection on a page → <strong>Save selection to Margin</strong> drops it as a sourced quote into that page's note.</p>
<h2>Privacy</h2>
<p>Notes live locally via <code>chrome.storage.local</code> and never leave your machine. Broad host access exists only so link cards can fetch a URL's preview; no scripts run on pages.</p>
`;
const CHANGELOG_HTML = `
<div class="ver"><span class="ver-tag">v0.7.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>A note is a set of pages now</strong> — every note remembers the <strong>full URL(s)</strong> it was drawn from (its provenance), matched per page so it still surfaces where you'd expect. Your existing notes carry over automatically.</li>
<li><strong>Capture spans pages</strong> — saving a selection into a locked note records that page on the note, so one note can gather from many pages. Unlocked, it'll surface on any of them.</li>
<li><em>Groundwork for merging notes and a per-note info panel (URLs · created · updated), both landing next.</em></li>
</ul>
<div class="ver"><span class="ver-tag">v0.6.0</span><span class="ver-date">Jun 29, 2026</span></div>
<ul>
<li><strong>Margin Numbers</strong> — a per-note toggle (note ⋯ menu) that numbers each block down a faint left gutter, legal-style: top-level blocks <code>1, 2, 3</code>, and list items / table rows as <code>12.1, 12.2</code>. A whisper-quiet alternating row tint shows each number's span. Positional only — it renumbers live.</li>
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
<li><strong>In-app Guide &amp; Version log</strong> — this screen, from the ⋯ menu.</li>
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

  $("open-browser").innerHTML = ICON.home;
  $("app-menu-btn").innerHTML = ICON.gear;
  $("app-menu-btn-2").innerHTML = ICON.gear;
  $("open-browser").addEventListener("click", showBrowser);
  const openAppMenu = (e) => { e.stopPropagation(); closeAllPopovers(); $("note-menu").hidden = true; $("app-menu").hidden = !$("app-menu").hidden; };
  $("app-menu-btn").addEventListener("click", openAppMenu);
  $("app-menu-btn-2").addEventListener("click", openAppMenu);
  $("note-menu-btn").addEventListener("click", (e) => { e.stopPropagation(); closeAllPopovers(); $("app-menu").hidden = true; $("note-menu").hidden = !$("note-menu").hidden; });
  $("back").addEventListener("click", () => { const n = activeNote(); if (n) openNote(n.id); else ensureForActiveTab(); });
  $("info-back").addEventListener("click", () => { const n = activeNote(); if (n) openNote(n.id); else ensureForActiveTab(); });
  document.querySelectorAll("#info-seg .seg-btn").forEach((b) => b.addEventListener("click", () => { infoMode = b.dataset.tab; renderInfo(); }));
  $("new-note").addEventListener("click", newNote);
  $("new-note-2").addEventListener("click", newNote);
  $("lock-toggle").addEventListener("click", () => setFollow(!state.settings.follow));
  $("theme-toggle").addEventListener("click", toggleTheme);

  $("note-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return; $("note-menu").hidden = true;
    ({ copy: copyNote, export: exportNote, pin: togglePin, mnumbers: toggleMarginNumbers, delete: deleteNote }[btn.dataset.act] || (() => {}))();
  });
  $("app-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return; $("app-menu").hidden = true;
    ({ guide: () => openInfo("guide"), changelog: () => openInfo("changelog"), roadmap: () => openInfo("roadmap"), shortcut: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) }[btn.dataset.act] || (() => {}))();
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
  $("style-trigger").addEventListener("click", (e) => { e.stopPropagation(); const open = $("style-menu").hidden; closeAllPopovers(); if (open) { $("style-menu").hidden = false; syncToolbar(); } });
  $("size-trigger").addEventListener("click", (e) => { e.stopPropagation(); const open = $("size-menu").hidden; closeAllPopovers(); if (open) { applyTextSize(); openPopover("size-menu", $("size-trigger")); } });
  // toolbar commands
  document.querySelectorAll('.rt-toolbar [data-cmd]').forEach((b) => b.addEventListener("click", () => exec(b.dataset.cmd)));
  $("checklist-btn").addEventListener("click", makeChecklist);
  $("plus-btn").addEventListener("click", (e) => { e.stopPropagation(); focusEditor(); slashCtx = null; showSlash(""); });
  $("color-btn").addEventListener("click", (e) => { e.stopPropagation(); saveRange(); openPopover("color-pop", $("color-btn")); });

  $("image-input").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) handleImageFile(f); });

  $("search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
  $("select-toggle").addEventListener("click", () => setSelectMode(!state.selectMode));
  $("bulk-all").addEventListener("click", bulkSelectAll);
  $("bulk-delete").addEventListener("click", bulkDelete);

  document.addEventListener("selectionchange", () => { if (document.activeElement === editor) { syncToolbar(); saveCaptureCaret(); updateCounts(); } });
  document.addEventListener("keydown", onKeydown);

  document.addEventListener("click", (e) => {
    const onApp = e.target.closest && (e.target.closest("#app-menu-btn") || e.target.closest("#app-menu-btn-2"));
    const onNote = e.target.closest && e.target.closest("#note-menu-btn");
    if (!$("app-menu").hidden && !$("app-menu").contains(e.target) && !onApp) $("app-menu").hidden = true;
    if (!$("note-menu").hidden && !$("note-menu").contains(e.target) && !onNote) $("note-menu").hidden = true;
    if (!$("slash").hidden && !$("slash").contains(e.target)) hideSlash();
    const inBar = e.target.closest && e.target.closest(".rt-toolbar");
    if (!inBar) ["style-menu","color-pop","size-menu"].forEach((id) => { const p = $(id); if (!p.hidden && !p.contains(e.target)) p.hidden = true; });
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
async function copyNote() { const n = activeNote(); if (!n) return; try { await navigator.clipboard.writeText(editor.innerText || ""); setStatus("Copied ✓"); setTimeout(() => setStatus("Saved"), 1200); } catch { setStatus("Copy failed"); } $("note-menu").hidden = true; }
function exportNote() {
  const n = activeNote(); if (!n) return;
  const doc = `<!doctype html><meta charset="utf-8"><title>${(n.title || "note").replace(/[<>&]/g, "")}</title><h1>${n.title || "Untitled"}</h1>` + sanitizeHtml(n.html || "");
  const blob = new Blob([doc], { type: "text/html" }); const url = URL.createObjectURL(blob);
  const a = elc("a"); a.href = url; a.download = (n.title || "note").replace(/[^\w\-]+/g, "-").slice(0, 40) + ".html"; a.click();
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
