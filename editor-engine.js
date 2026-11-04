/* Margin: editor engine (v0.14)
   ---------------------------------------------------------------------------
   Block formatting (Body / Title / Heading / Subheading / Quote / Code), lists
   (bullet, numbered, checklist), indent, Enter/Backspace inside lists, paste,
   and the editor's undo history.

   Why this exists: document.execCommand's block commands (formatBlock,
   insertUnorderedList, indent) mutate the DOM in ways that don't round-trip.
   Re-applying H1 inside a list item nested <h1><h1><h1><ul>… (so em-based
   heading sizes compounded on every press), bullets wrapped paragraphs as
   <p><ul>…</ul></p>, and a checklist only ever converted one block. This file
   replaces all of that with one predictable model:

     explode → transform → rebuild

   1. The selection is pinned with two marker <span>s (they ride along with the
      content, so any DOM surgery keeps the selection).
   2. The touched top-level blocks are "exploded" into a flat array of LINES.
      A line is one visual line: a paragraph (or one <br>-separated row of it),
      a heading, one row of a quote/code block, or one list item. Lines carry
      kind, list level, checked state, and their inline content as a fragment.
   3. A command just edits line properties (kind/level/heading).
   4. Lines are "rebuilt" into clean, canonical markup: consecutive list lines
      become properly nested <ul>/<ol>/<ul.checklist>, quote/code rows merge
      into one block, everything else is one block per line.

   Every command is idempotent (H1 twice = H1) and lists toggle like Google Docs.
   Native undo can't see these DOM edits, so the editor keeps its own snapshot
   history and owns ⌘Z / ⌘⇧Z.

   Globals used from sidepanel.js (resolved at call time): editor, elc, br,
   para, queueSave, syncToolbar, updateChecklistCounts, checkSpan, cleanStyle,
   sanitizeHtml, STATUS_KEYS, htmlToText; and insertImageFiles / localizeImages
   from images.js.
*/

/* ---------- node classification ---------- */
const ENG_BLOCK = new Set(["P","DIV","H1","H2","H3","H4","H5","H6","BLOCKQUOTE","PRE","UL","OL","LI","TABLE","THEAD","TBODY","TFOOT","TR","TD","TH","HR","DETAILS","SUMMARY"]);
const LIST_KINDS = new Set(["ul", "ol", "check"]);
const TEXT_KIND = { P: "p", DIV: "p", H1: "h1", H2: "h2", H3: "h3", H4: "h3", H5: "h3", H6: "h3", BLOCKQUOTE: "quote", PRE: "pre" };
const KIND_TAG = { p: "P", h1: "H1", h2: "H2", h3: "H3", quote: "BLOCKQUOTE", pre: "PRE" };
const STYLE_KIND = { P: "p", H1: "h1", H2: "h2", H3: "h3", BLOCKQUOTE: "quote", PRE: "pre" };
const PROV_ATTRS = new Set(["data-src", "data-srchost", "title"]);

const isEl = (n) => !!n && n.nodeType === 1;
const isListEl = (n) => isEl(n) && (n.tagName === "UL" || n.tagName === "OL");
const isMarker = (n) => isEl(n) && n.hasAttribute("data-mk");
const isHeadingKind = (k) => k === "h1" || k === "h2" || k === "h3";
function isAtom(n) {
  if (!isEl(n)) return false;
  const t = n.tagName;
  if (t === "HR" || t === "TABLE" || t === "DETAILS" || t === "IMG") return true;
  if (t === "A" && n.classList.contains("link-card")) return true;
  if (t === "DIV" && n.classList.contains("callout")) return true;
  return false;
}
// Block-level for line-splitting purposes. IMG / link cards are inline when they sit inside a paragraph.
function isBlockish(n) { return isEl(n) && ENG_BLOCK.has(n.tagName); }
function isFlowRoot(n) {
  return n === editor || (isEl(n) && (n.classList.contains("callout-body") || n.classList.contains("toggle-body") || n.tagName === "TD" || n.tagName === "TH"));
}
function flowRootOf(n) { while (n && !isFlowRoot(n)) n = n.parentNode; return n && editor.contains(n) ? n : null; }
function topChildOf(root, n) { while (n && n.parentNode !== root) n = n.parentNode; return n; }
function listKindOf(list) { return list.classList.contains("checklist") ? "check" : list.tagName === "OL" ? "ol" : "ul"; }
function isChecklistLi(li) { return isEl(li) && li.tagName === "LI" && isEl(li.parentNode) && li.parentNode.classList.contains("checklist"); }

function fragIsEmpty(f) {
  if (!f) return true;
  if ((f.textContent || "").replace(/​/g, "").trim() !== "") return false;
  return !(f.querySelector && f.querySelector("img,hr,table,.badge,a.link-card"));
}
function endsWithBr(f) { const n = [...f.childNodes].reverse().find((x) => !isMarker(x) && !(x.nodeType === 3 && x.data === "")); return isEl(n) && n.tagName === "BR"; }
function unwrap(el) { const p = el.parentNode; if (!p) return; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); }
function renameEl(el, tag) {
  const n = el.ownerDocument.createElement(tag);
  [...el.attributes].forEach((a) => { try { n.setAttribute(a.name, a.value); } catch (e) {} });
  while (el.firstChild) n.appendChild(el.firstChild);
  el.replaceWith(n); return n;
}

/* ---------- selection markers ---------- */
function mkMarker(k) { const s = document.createElement("span"); s.setAttribute("data-mk", k); return s; }
// Push a boundary that sits *between* blocks down into the adjacent block, so markers always land inside a line.
function normBoundary(node, offset, isStart) {
  for (let g = 0; g < 64 && isEl(node); g++) {
    const kids = node.childNodes;
    let next = null, nOff = 0;
    const cand = isStart ? kids[offset] : kids[offset - 1];
    if (isBlockish(cand) && !isAtom(cand)) { next = cand; nOff = isStart ? 0 : cand.childNodes.length; }
    else if (!cand) {
      const alt = isStart ? kids[offset - 1] : kids[offset];
      if (isBlockish(alt) && !isAtom(alt)) { next = alt; nOff = isStart ? alt.childNodes.length : 0; }
    }
    if (!next) break;
    node = next; offset = nOff;
  }
  return { node, offset };
}
function insertAtBoundary(b, el) {
  const { node, offset } = b;
  if (node.nodeType === 3) {
    if (offset <= 0) node.before(el);
    else if (offset >= node.length) node.after(el);
    else node.splitText(offset).before(el);
  } else node.insertBefore(el, node.childNodes[offset] || null);
}
function placeMarkers() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
  const collapsed = r.collapsed;
  const sB = normBoundary(r.startContainer, r.startOffset, true);
  const eB = collapsed ? null : normBoundary(r.endContainer, r.endOffset, false);
  const ms = mkMarker("s"), me = mkMarker("e");
  if (collapsed) { insertAtBoundary(sB, ms); ms.after(me); }
  else { insertAtBoundary(eB, me); insertAtBoundary(sB, ms); }
  return { ms, me, collapsed };
}
function restoreMarkers(mk) {
  const sel = window.getSelection();
  const r = document.createRange();
  let ok = false;
  if (mk && mk.ms && mk.me && mk.ms.isConnected && mk.me.isConnected && editor.contains(mk.ms)) {
    try { r.setStartBefore(mk.ms); r.setEndBefore(mk.me); ok = true; } catch (e) {}
  }
  const parents = new Set();
  editor.querySelectorAll("[data-mk]").forEach((m) => { parents.add(m.parentNode); m.remove(); });
  parents.forEach((p) => { try { p.normalize(); } catch (e) {} });
  if (!ok) { r.selectNodeContents(editor); r.collapse(false); }
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  sel.removeAllRanges(); sel.addRange(r);
}

/* ---------- explode: blocks → lines ---------- */
let lineSeq = 0;
function newLine(props) {
  return Object.assign({ kind: "p", frag: null, node: null, level: 0, checked: false, heading: null, attrs: null, origKind: null, src: 0, listId: 0, sel: false, topList: null }, props);
}
function attrsOf(el) { return [...el.attributes].map((a) => [a.name, a.value]); }
function pushText(ctx, line) {
  if (ctx.stash.length) { const f = line.frag; ctx.stash.forEach((m) => f.insertBefore(m, f.firstChild)); ctx.stash = []; }
  ctx.out.push(line);
}
// Drop .check controls and empty inline wrappers left behind by splitting (never markers/images).
function cleanFrag(f) {
  f.querySelectorAll(".check").forEach((c) => c.remove());
  [...f.querySelectorAll("b,strong,i,em,u,s,strike,span,font,code,a")].reverse().forEach((el) => {
    if (isMarker(el) || el.classList.contains("badge")) return;
    if ((el.textContent || "") === "" && !el.querySelector("img,br,[data-mk]")) el.remove();
  });
  return f;
}
// Split an inline-only container into one fragment per <br>-separated row. Range extraction clones
// partially-covered inline wrappers, so "<b>a<br>b</b>" correctly yields "<b>a</b>" and "<b>b</b>".
function splitByBr(c) {
  const out = [];
  for (let g = 0; g < 5000; g++) {
    const b = c.querySelector("br");
    if (!b) break;
    const r = document.createRange(); r.setStart(c, 0); r.setEndBefore(b);
    out.push(cleanFrag(r.extractContents()));
    b.remove();
  }
  const rest = document.createDocumentFragment();
  while (c.firstChild) rest.appendChild(c.firstChild);
  out.push(cleanFrag(rest));
  // "a<br>" renders as ONE line: the last <br> is only a placeholder.
  if (out.length > 1 && fragIsEmpty(out[out.length - 1])) {
    const last = out.pop();
    last.querySelectorAll("[data-mk]").forEach((m) => out[out.length - 1].appendChild(m));
  }
  return out;
}
// A code block's rows can be literal "\n" characters; turn them into <br> so rows split uniformly.
function preNewlinesToBr(pre) {
  pre.querySelectorAll(":scope > code").forEach(unwrap);
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  const texts = []; let t; while ((t = w.nextNode())) if (t.data.includes("\n")) texts.push(t);
  texts.forEach((tn) => {
    const parts = tn.data.split("\n");
    const f = document.createDocumentFragment();
    parts.forEach((p, i) => { if (i) f.appendChild(document.createElement("br")); if (p) f.appendChild(document.createTextNode(p)); });
    tn.replaceWith(f);
  });
}
function explodeChildren(nodes, ctx) {
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const p = document.createElement("p"); run.forEach((n) => p.appendChild(n)); run = [];
    const blank = (p.textContent || "").trim() === "" && !p.querySelector("img,br,.badge");
    if (blank) { p.querySelectorAll("[data-mk]").forEach((m) => ctx.stash.push(m)); return; }
    explodeBlock(p, "p", ctx);
  };
  nodes.forEach((c) => {
    if (c.nodeType === 8) return; // comments
    if (isAtom(c)) { flush(); ctx.out.push(newLine({ kind: "atom", node: c })); return; }
    if (!isBlockish(c)) { run.push(c); return; }
    flush();
    if (isListEl(c)) explodeList(c, 0, ctx, ++lineSeq);
    else if (c.tagName === "LI") explodeLi(c, "ul", 0, ctx, ++lineSeq);
    else if (TEXT_KIND[c.tagName]) explodeBlock(c, TEXT_KIND[c.tagName], ctx);
    else ctx.out.push(newLine({ kind: "atom", node: c })); // stray table parts etc.: leave untouched
  });
  flush();
}
function explodeBlock(el, kind, ctx, inherit) {
  const src = inherit ? inherit.src : ++lineSeq;
  const attrs = inherit ? inherit.attrs : attrsOf(el);
  if (el.tagName === "PRE") preNewlinesToBr(el);
  const hasBlockKids = [...el.childNodes].some(isBlockish);
  const before = ctx.out.length;
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const tmp = document.createElement("div"); run.forEach((n) => tmp.appendChild(n)); run = [];
    const blank = (tmp.textContent || "").trim() === "" && !tmp.querySelector("img,br,.badge");
    if (blank && hasBlockKids) { tmp.querySelectorAll("[data-mk]").forEach((m) => ctx.stash.push(m)); return; }
    splitByBr(tmp).forEach((f) => pushText(ctx, newLine({ kind, frag: f, attrs, origKind: kind, src })));
  };
  [...el.childNodes].forEach((c) => {
    if (!isBlockish(c) && !(isEl(c) && c.classList.contains("callout"))) { run.push(c); return; }
    flush();
    if (isAtom(c)) ctx.out.push(newLine({ kind: "atom", node: c }));
    else if (isListEl(c)) explodeList(c, 0, ctx, ++lineSeq);
    else if (c.tagName === "LI") explodeLi(c, "ul", 0, ctx, ++lineSeq);
    else {
      // A quote/code block's inner paragraphs stay part of the same quote/code block.
      const keep = kind === "quote" || kind === "pre";
      explodeBlock(c, keep ? kind : (TEXT_KIND[c.tagName] || kind), ctx, keep ? { src, attrs } : null);
    }
  });
  flush();
  if (ctx.out.length === before) pushText(ctx, newLine({ kind, frag: document.createDocumentFragment(), attrs, origKind: kind, src }));
}
function explodeList(list, level, ctx, listId) {
  const kind = listKindOf(list);
  [...list.childNodes].forEach((c) => {
    if (isEl(c) && c.tagName === "LI") explodeLi(c, kind, level, ctx, listId);
    else if (isListEl(c)) explodeList(c, level + 1, ctx, listId); // Chrome's <ul><ul> indent shape
    else if (isMarker(c)) ctx.stash.push(c);
    else if (c.nodeType === 3 && !c.data.trim()) return;
    else if (c.nodeType === 1 || c.nodeType === 3) { const li = document.createElement("li"); li.appendChild(c); explodeLi(li, kind, level, ctx, listId); }
  });
}
function explodeLi(li, kind, level, ctx, listId) {
  const checked = li.classList.contains("checked");
  const tmp = document.createElement("div");
  const nested = [];
  let heading = null;
  const hasContent = () => tmp.childNodes.length && ((tmp.textContent || "").trim() !== "" || tmp.querySelector("img"));
  [...li.childNodes].forEach((c) => {
    if (isListEl(c)) { nested.push(c); return; }
    if (isEl(c) && c.classList.contains("check")) { c.remove(); return; }
    if (isBlockish(c) && !isAtom(c)) {
      // <li><p>…</p></li> (Google Docs / Notion paste) or a heading-in-list: keep the text inline.
      if (/^H[1-6]$/.test(c.tagName) && !heading) heading = TEXT_KIND[c.tagName];
      if (hasContent()) tmp.appendChild(document.createElement("br"));
      [...c.childNodes].forEach((k) => { if (isListEl(k)) nested.push(k); else tmp.appendChild(k); });
      return;
    }
    tmp.appendChild(c);
  });
  // "<li>a<br></li>": the last <br> is only a caret placeholder (rebuild re-adds one when needed)
  const lastReal = [...tmp.childNodes].reverse().find((n) => !isMarker(n) && !(n.nodeType === 3 && n.data === ""));
  if (isEl(lastReal) && lastReal.tagName === "BR") lastReal.remove();
  const frag = document.createDocumentFragment(); while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  pushText(ctx, newLine({ kind, frag: cleanFrag(frag), level, checked: kind === "check" && checked, heading, origKind: kind, src: ++lineSeq, listId }));
  nested.forEach((n) => explodeList(n, level + 1, ctx, listId));
}

/* ---------- selection membership ---------- */
function atLineEdge(frag, marker, which) {
  const r = document.createRange();
  if (which === "end") { r.setStartAfter(marker); r.setEnd(frag, frag.childNodes.length); }
  else { r.setStart(frag, 0); r.setEndBefore(marker); }
  const c = r.cloneContents();
  return (c.textContent || "") === "" && !c.querySelector("img");
}
function markSelection(lines, mk) {
  let inSel = false;
  lines.forEach((L) => {
    const holder = L.kind === "atom" ? L.node : L.frag;
    const hs = holder.contains(mk.ms), he = holder.contains(mk.me);
    let s = inSel;
    // A drag that merely touches the very end of one line / start of the next doesn't select that line.
    if (hs) { s = true; inSel = true; if (!mk.collapsed && !he && L.kind !== "atom" && atLineEdge(L.frag, mk.ms, "end")) s = false; }
    if (he) { if (!mk.collapsed && !hs && L.kind !== "atom" && atLineEdge(L.frag, mk.me, "start")) s = false; inSel = false; }
    L.sel = s;
  });
}

/* ---------- rebuild: lines → blocks ---------- */
function makeListEl(kind) { const l = document.createElement(kind === "ol" ? "ol" : "ul"); if (kind === "check") l.className = "checklist"; return l; }
function buildLi(L) {
  const li = document.createElement("li");
  if (L.kind === "check") { li.appendChild(checkSpan()); if (L.checked) li.classList.add("checked"); }
  const empty = fragIsEmpty(L.frag) || endsWithBr(L.frag);
  const host = L.heading ? li.appendChild(document.createElement(L.heading.toUpperCase())) : li;
  host.appendChild(L.frag);
  if (empty) host.appendChild(document.createElement("br"));
  return li;
}
function buildLists(run) {
  const tops = [], stack = [];
  const base = run[0].level || 0;
  let prev = null;
  run.forEach((L) => {
    let lvl = Math.max(0, (L.level || 0) - base);
    const maxLvl = stack.length ? stack[stack.length - 1].lvl + 1 : 0;
    if (lvl > maxLvl) lvl = maxLvl;
    // Two unrelated lists that happen to sit back to back stay separate unless this edit touched them.
    if (lvl === 0 && prev && L.listId !== prev.listId && !L.sel && !prev.sel) stack.length = 0;
    while (stack.length) {
      const t = stack[stack.length - 1];
      if (t.lvl > lvl || (t.lvl === lvl && t.kind !== L.kind)) stack.pop(); else break;
    }
    if (!stack.length || stack[stack.length - 1].lvl < lvl) {
      const list = makeListEl(L.kind);
      if (stack.length) { const p = stack[stack.length - 1]; (p.lastLi || p.list).appendChild(list); }
      else tops.push(list);
      stack.push({ list, kind: L.kind, lvl, lastLi: null });
    }
    const top = stack[stack.length - 1];
    const li = buildLi(L); top.list.appendChild(li); top.lastLi = li;
    L.level = lvl; L.topList = tops[tops.length - 1]; prev = L;
  });
  return tops;
}
function canMerge(a, b) {
  if (a.kind !== b.kind || b.kind === "atom" || LIST_KINDS.has(b.kind)) return false;
  if (a.src === b.src && a.kind === a.origKind && b.kind === b.origKind) return true;
  if ((a.kind === "quote" || a.kind === "pre") && (a.src === b.src || (a.sel && b.sel))) return true;
  return false;
}
function buildText(group) {
  const first = group[0], kind = first.kind;
  const el = document.createElement(KIND_TAG[kind] || "P");
  const attrs = (first.attrs || []).filter(([n]) => first.kind === first.origKind || PROV_ATTRS.has(n));
  attrs.forEach(([n, v]) => { try { el.setAttribute(n, v); } catch (e) {} });
  const host = kind === "pre" ? el.appendChild(document.createElement("code")) : el;
  let lastEmpty = false;
  group.forEach((L, k) => {
    lastEmpty = fragIsEmpty(L.frag);
    if (k) host.appendChild(document.createElement("br"));
    host.appendChild(L.frag);
  });
  if (lastEmpty) host.appendChild(document.createElement("br"));
  return el;
}
function rebuild(lines) {
  const out = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    if (L.kind === "atom") { out.appendChild(L.node); i++; continue; }
    if (LIST_KINDS.has(L.kind)) {
      let j = i; while (j < lines.length && LIST_KINDS.has(lines[j].kind)) j++;
      buildLists(lines.slice(i, j)).forEach((el) => out.appendChild(el));
      i = j; continue;
    }
    let j = i + 1; while (j < lines.length && canMerge(lines[j - 1], lines[j])) j++;
    out.appendChild(buildText(lines.slice(i, j)));
    i = j;
  }
  return out;
}
// A list a command just created/changed joins a same-kind list directly above or below it (like Docs).
function listSig(el) { return isListEl(el) ? el.tagName + (el.classList.contains("checklist") ? ".c" : "") : null; }
function sibEl(n, dir) { let s = dir < 0 ? n.previousSibling : n.nextSibling; while (s && s.nodeType === 3 && !s.data.trim()) s = dir < 0 ? s.previousSibling : s.nextSibling; return s; }
function mergeNeighborLists(first, last, lines) {
  const touched = (list) => lines.some((l) => l.sel && l.topList === list);
  if (first && isListEl(first) && touched(first)) {
    const prev = sibEl(first, -1);
    if (prev && listSig(prev) === listSig(first)) {
      while (first.firstChild) prev.appendChild(first.firstChild);
      if (last === first) last = prev;
      lines.forEach((l) => { if (l.topList === first) l.topList = prev; });
      first.remove();
    }
  }
  if (last && isListEl(last) && touched(last)) {
    const next = sibEl(last, 1);
    if (next && listSig(next) === listSig(last)) { while (next.firstChild) last.appendChild(next.firstChild); next.remove(); }
  }
}

/* ---------- the block-op driver ---------- */
function commonFlowRoot(a, b) {
  if (!a || !b) return a || b;
  if (a === b || a.contains(b)) return a;
  if (b.contains(a)) return b;
  let n = a.parentNode; while (n && !(isFlowRoot(n) && n.contains(b))) n = n.parentNode;
  return n || editor;
}
function regionNodes(root, a, b) {
  // widen to whole loose-inline runs so a bare text line at the root is treated as one line
  const inline = (n) => n && !isBlockish(n) && !isAtom(n);
  while (inline(a) && inline(a.previousSibling)) a = a.previousSibling;
  while (inline(b) && inline(b.nextSibling)) b = b.nextSibling;
  const nodes = []; for (let n = a; n; n = n.nextSibling) { nodes.push(n); if (n === b) break; }
  return nodes;
}
// Explode the blocks under the selection, let `op` edit the selected lines, rebuild in place.
function blockOp(op) {
  histFlush();
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  const mk = placeMarkers();
  if (!mk) return false;
  try {
    const root = commonFlowRoot(flowRootOf(mk.ms), flowRootOf(mk.me));
    if (!root) return false;
    const a = topChildOf(root, mk.ms), b = topChildOf(root, mk.me);
    if (!a || !b) return false;
    const nodes = regionNodes(root, a, b);
    const anchor = nodes[nodes.length - 1].nextSibling;
    nodes.forEach((n) => n.remove());
    const ctx = { out: [], stash: [] };
    explodeChildren(nodes, ctx);
    if (ctx.stash.length) {
      const host = [...ctx.out].reverse().find((l) => l.kind !== "atom");
      if (host) ctx.stash.forEach((m) => host.frag.appendChild(m));
      else { const f = document.createDocumentFragment(); ctx.stash.forEach((m) => f.appendChild(m)); ctx.out.push(newLine({ kind: "p", frag: f, origKind: "p", src: ++lineSeq })); }
    }
    markSelection(ctx.out, mk);
    op(ctx.out.filter((l) => l.sel && l.kind !== "atom"), ctx.out);
    const lines = splitSoftBreaks(ctx.out);
    const frag = rebuild(lines);
    const first = frag.firstChild, last = frag.lastChild;
    root.insertBefore(frag, anchor);
    mergeNeighborLists(first, last, lines);
    ensureTypingRoom(root);
  } finally {
    restoreMarkers(mk);
  }
  afterStructuralEdit();
  return true;
}
// A line whose kind changed and that holds soft breaks becomes one line per row: this is what turns
// "alpha⏎beta⏎gamma" (one crammed item) into three checklist items.
function splitSoftBreaks(lines) {
  const out = [];
  lines.forEach((L) => {
    if (L.kind !== "atom" && L.sel && L.kind !== L.origKind && L.frag.querySelector("br")) {
      const tmp = document.createElement("div"); tmp.appendChild(L.frag);
      splitByBr(tmp).forEach((f, i) => out.push(Object.assign({}, L, { frag: f, src: i ? ++lineSeq : L.src })));
    } else out.push(L);
  });
  return out;
}
function ensureTypingRoom(root) {
  if (!root.firstChild) { root.appendChild(para()); return; }
  let last = root.lastChild; while (last && last.nodeType === 3 && !last.data.trim()) last = last.previousSibling;
  if (root === editor && isAtom(last)) root.appendChild(para());
}
function afterStructuralEdit() {
  updateChecklistCounts();
  queueSave();
  syncToolbar();
  histCommit();
}

/* ---------- commands ---------- */
function setBlockStyle(tag) {
  const kind = STYLE_KIND[tag] || "p";
  return blockOp((sel) => sel.forEach((L) => {
    if (LIST_KINDS.has(L.kind)) {
      // Headings inside a list keep the bullet and take the heading's scale (#8);
      // Body strips it back. Quote / Code lift the line out of the list.
      if (isHeadingKind(kind)) L.heading = kind;
      else if (kind === "p") L.heading = null;
      else { L.kind = kind; L.heading = null; L.level = 0; }
    } else L.kind = kind;
  }));
}
function toggleList(kind) {
  return blockOp((sel) => {
    if (!sel.length) return;
    const allOn = sel.every((L) => L.kind === kind);
    sel.forEach((L) => {
      if (allOn) { L.kind = L.heading || "p"; L.heading = null; L.level = 0; L.checked = false; return; }
      if (LIST_KINDS.has(L.kind)) { L.checked = L.kind === "check" && kind === "check" && L.checked; L.kind = kind; return; }
      L.heading = isHeadingKind(L.kind) ? L.kind : null;
      L.kind = kind; L.level = 0; L.checked = false;
    });
  });
}
function indentLines(delta) {
  return blockOp((sel) => sel.forEach((L) => {
    if (!LIST_KINDS.has(L.kind)) return;
    L.level = Math.min(8, (L.level || 0) + delta);
    if (L.level < 0) { L.kind = L.heading || "p"; L.heading = null; L.level = 0; L.checked = false; }
  }));
}

/* ---------- caret context ---------- */
function selRange() { const s = window.getSelection(); return s.rangeCount && editor.contains(s.anchorNode) ? s.getRangeAt(0) : null; }
function closestIn(n, pred) { while (n && n !== editor) { if (pred(n)) return n; n = n.parentNode; } return null; }
function liContentEnd(li) { const k = [...li.childNodes].findIndex(isListEl); return k < 0 ? li.childNodes.length : k; }
function caretAtStart(container, r) {
  const t = document.createRange(); t.setStart(container, 0); t.setEnd(r.startContainer, r.startOffset);
  const c = t.cloneContents(); return (c.textContent || "") === "" && !c.querySelector("img");
}
function caretAtEnd(container, r, endOffset) {
  const t = document.createRange(); t.setStart(r.endContainer, r.endOffset); t.setEnd(container, endOffset == null ? container.childNodes.length : endOffset);
  const c = t.cloneContents(); return (c.textContent || "") === "" && !c.querySelector("img");
}
// The list kind + heading the caret sits in (for toolbar state).
function caretLineInfo() {
  const r = selRange(); if (!r) return null;
  const li = closestIn(r.startContainer, (n) => isEl(n) && n.tagName === "LI");
  if (li && isListEl(li.parentNode)) {
    const h = closestIn(r.startContainer, (n) => isEl(n) && /^H[1-3]$/.test(n.tagName) && li.contains(n));
    return { list: listKindOf(li.parentNode), block: h ? h.tagName : "P" };
  }
  const blk = closestIn(r.startContainer, (n) => isEl(n) && /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE)$/.test(n.tagName) && !n.classList.contains("callout") && !n.classList.contains("callout-body") && !n.classList.contains("toggle-body"));
  let tag = blk ? blk.tagName : "P";
  if (/^H[4-6]$/.test(tag)) tag = "H3";
  if (tag === "DIV") tag = "P";
  const q = closestIn(r.startContainer, (n) => isEl(n) && (n.tagName === "BLOCKQUOTE" || n.tagName === "PRE"));
  if (q) tag = q.tagName;
  return { list: null, block: tag };
}

/* ---------- Enter / Backspace / Delete ---------- */
function caretToStartOf(el) {
  let host = el;
  if (isListEl(el)) host = el.querySelector("li") || el;
  if (host.tagName === "LI" || isMergeableBlock(host)) host = contentHost(host);
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); const t = w.nextNode();
  if (t) setCaret(t, 0); else setCaret(host, isChecklistLi(host) ? 1 : 0);
}
function setCaret(node, offset) {
  const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
// Enter inside any list item: split it at the caret (an empty item steps out a level / out of the list).
function listEnter() {
  const r0 = selRange(); if (!r0) return false;
  const li = closestIn(r0.startContainer, (n) => isEl(n) && n.tagName === "LI");
  if (!li || !isListEl(li.parentNode) || !editor.contains(li)) return false;
  histFlush();
  if (!r0.collapsed) document.execCommand("delete");
  const r = selRange(); if (!r) return true;
  const end = liContentEnd(li);
  const contentEmpty = (() => { const t = document.createRange(); t.setStart(li, 0); t.setEnd(li, end); const c = t.cloneContents(); return (c.textContent || "").trim() === "" && !c.querySelector("img"); })();
  if (contentEmpty) { indentLines(-1); return true; }
  const t = document.createRange(); t.setStart(r.startContainer, r.startOffset); t.setEnd(li, end);
  const tail = t.extractContents();
  const nli = document.createElement("li");
  const check = isChecklistLi(li);
  if (check) nli.appendChild(checkSpan());
  nli.appendChild(tail);
  // keep the heading scale on the new item; give empty halves a caret placeholder
  const fill = (host) => { if ((host.textContent || "") === "" && !host.querySelector("img,br")) host.appendChild(document.createElement("br")); };
  const nh = nli.querySelector(":scope > h1, :scope > h2, :scope > h3");
  fill(nh || nli);
  const oh = li.querySelector(":scope > h1, :scope > h2, :scope > h3");
  if (oh) fill(oh); else { const b = document.createRange(); b.setStart(li, 0); b.setEnd(li, liContentEnd(li)); const c = b.cloneContents(); if ((c.textContent || "") === "" && !c.querySelector("img,br")) li.insertBefore(document.createElement("br"), li.childNodes[liContentEnd(li)] || null); }
  // nested children follow the new item (flat-list semantics, like Docs)
  [...li.childNodes].filter(isListEl).forEach((l) => nli.appendChild(l));
  li.after(nli);
  const host = nh || nli;
  let idx = 0; if (host === nli && check) idx = 1;
  // put the caret at the very start of the moved text
  const firstText = (() => { const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!closestIn(n, (x) => x === nli || isListEl(x)) || true) return n; } return null; })();
  if (firstText && host.contains(firstText) && !closestIn(firstText, (x) => isListEl(x) && nli.contains(x) && x !== nli)) setCaret(firstText, 0);
  else setCaret(host, Math.min(idx, host.childNodes.length));
  nli.scrollIntoView({ block: "nearest" });
  afterStructuralEdit();
  return true;
}
// The element whose children are the editable content of a text block / list item.
function contentHost(el) {
  if (el.tagName === "PRE") return el.querySelector(":scope > code") || el;
  if (el.tagName === "LI") return el.querySelector(":scope > h1, :scope > h2, :scope > h3") || el;
  return el;
}
const MERGEABLE = /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE)$/;
function isMergeableBlock(n) { return isEl(n) && MERGEABLE.test(n.tagName) && !n.classList.contains("callout") && ![...n.childNodes].some(isBlockish); }
function deepestLastLi(list) { let li = list.lastElementChild; while (li) { const sub = [...li.children].filter(isListEl).pop(); if (!sub || !sub.lastElementChild) break; li = sub.lastElementChild; } return li; }
// Move `src`'s inline content onto the end of `dst` (both plain text blocks / list items). Doing this
// ourselves (instead of the browser) avoids Chrome's merge spans like <span style="font-size:1.5em">.
function mergeBlocks(dst, src) {
  histFlush();
  const host = contentHost(dst);
  // remove the trailing placeholder <br> (exactly one: "a<br><br>" + "b" must become "a<br>b")
  let tail = host.lastChild; while (tail && tail.nodeType === 3 && tail.data === "") tail = tail.previousSibling;
  if (dst.tagName === "LI") { const e = liContentEnd(dst); tail = host === dst ? dst.childNodes[e - 1] : host.lastChild; }
  if (isEl(tail) && tail.tagName === "BR") tail.remove();
  const caret = mkMarker("s"), caretE = mkMarker("e");
  const insertAt = dst.tagName === "LI" && host === dst ? (dst.childNodes[liContentEnd(dst)] || null) : null;
  host.insertBefore(caret, insertAt); caret.after(caretE);
  const from = contentHost(src);
  const moved = document.createDocumentFragment();
  [...from.childNodes].forEach((c) => {
    if (isEl(c) && c.classList.contains("check")) return;
    if (isListEl(c)) return;
    moved.appendChild(c);
  });
  if (!fragIsEmpty(moved) || moved.querySelector("br") === null) caretE.after(moved);
  const nested = src.tagName === "LI" ? [...src.childNodes].filter(isListEl) : [];
  if (dst.tagName === "LI") nested.forEach((l) => dst.appendChild(l));
  src.remove();
  if ((host.textContent || "") === "" && !host.querySelector("img,br")) host.appendChild(document.createElement("br"));
  restoreMarkers({ ms: caret, me: caretE, collapsed: true });
  afterStructuralEdit();
}
function handleBackspace(e) {
  const r = selRange(); if (!r || !r.collapsed) return false;
  const li = closestIn(r.startContainer, (n) => isEl(n) && n.tagName === "LI");
  if (li && isListEl(li.parentNode)) {
    const host = contentHost(li);
    const t = document.createRange(); t.setStart(host, 0); t.setEnd(r.startContainer, r.startOffset);
    const c = t.cloneContents();
    if ((c.textContent || "") === "" && !c.querySelector("img")) {
      // Backspace at the start of an item: step out one level; at the top level, drop the bullet.
      e.preventDefault(); indentLines(-1); return true;
    }
    return false;
  }
  const root = flowRootOf(r.startContainer); if (!root) return false;
  const blk = topChildOf(root, r.startContainer);
  if (!isMergeableBlock(blk) || !caretAtStart(contentHost(blk), r)) return false;
  const prev = sibEl(blk, -1);
  if (!prev) {
    // First line of a callout / toggle / cell: never merge out of the container. An empty
    // callout or toggle body removes the whole element.
    if (root !== editor) {
      e.preventDefault();
      const only = root.children.length === 1 && fragIsEmpty(blk);
      const box = root.classList.contains("callout-body") ? root.closest(".callout") : root.classList.contains("toggle-body") ? root.closest("details") : null;
      if (only && box) { histFlush(); const p = para(); box.replaceWith(p); setCaret(p, 0); afterStructuralEdit(); }
      return true;
    }
    // first block of the note: Backspace on a heading/quote/code start turns it back into Body
    if (blk.tagName !== "P" && blk.tagName !== "DIV") { e.preventDefault(); setBlockStyle("P"); return true; }
    return false;
  }
  if (isMergeableBlock(prev)) { e.preventDefault(); mergeBlocks(prev, blk); return true; }
  if (isListEl(prev)) { const target = deepestLastLi(prev); if (target) { e.preventDefault(); mergeBlocks(target, blk); return true; } }
  if (isAtom(prev) && fragIsEmpty(blk)) { e.preventDefault(); histFlush(); const next = sibEl(blk, 1); blk.remove(); if (next && isMergeableBlock(next)) setCaret(contentHost(next), 0); else { const p = para(); prev.after(p); setCaret(p, 0); } afterStructuralEdit(); return true; }
  return false;
}
function handleDelete(e) {
  const r = selRange(); if (!r || !r.collapsed) return false;
  if (closestIn(r.startContainer, (n) => isEl(n) && n.tagName === "LI")) return false;
  const root = flowRootOf(r.startContainer); if (!root) return false;
  const blk = topChildOf(root, r.startContainer);
  if (!isMergeableBlock(blk) || !caretAtEnd(contentHost(blk), r)) return false;
  const next = sibEl(blk, 1);
  if (next && isMergeableBlock(next)) { e.preventDefault(); mergeBlocks(blk, next); return true; }
  if (!next && root !== editor) { e.preventDefault(); return true; }
  return false;
}

/* ---------- live normalization (after every input) ---------- */
function normalizeLive() {
  // every checklist item leads with exactly one check control; stray controls elsewhere go
  editor.querySelectorAll("ul.checklist > li").forEach((li) => {
    const checks = [...li.children].filter((c) => c.classList.contains("check"));
    if (!checks.length) li.insertBefore(checkSpan(), li.firstChild);
    else { if (li.firstChild !== checks[0]) li.insertBefore(checks[0], li.firstChild); checks.slice(1).forEach((c) => c.remove()); }
  });
  editor.querySelectorAll(".check").forEach((c) => { if (!isChecklistLi(c.parentNode)) c.remove(); });
  // a caret parked before the check control types into the wrong place: nudge it past
  const r = selRange();
  if (r && r.collapsed && isChecklistLi(r.startContainer) && r.startOffset === 0) setCaret(r.startContainer, 1);
  // Chrome injects presentational styles (font-size, line-height…) when it merges blocks. The
  // sanitizer strips them on save; strip them live too so what you see is what gets saved.
  editor.querySelectorAll("[style]").forEach((el) => {
    const raw = el.getAttribute("style") || "";
    const clean = cleanStyle(raw);
    const n = (s) => s.split(";").filter((x) => x.trim()).length;
    if (n(clean) !== n(raw)) { if (clean) el.setAttribute("style", clean); else el.removeAttribute("style"); }
  });
  wrapLooseInline();
}
// Text typed straight into an empty editor lands as a bare text node: give it a paragraph.
function wrapLooseInline() {
  const kids = [...editor.childNodes];
  if (!kids.some((n) => (n.nodeType === 3 && n.data.trim()) || (isEl(n) && !isBlockish(n) && !isAtom(n) && n.tagName !== "BR"))) return;
  const s = window.getSelection(); const r = selRange();
  const keep = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
  let p = null;
  kids.forEach((n) => {
    const loose = n.nodeType === 3 ? n.data.trim() !== "" || !!p : isEl(n) && !isBlockish(n) && !isAtom(n);
    if (loose) { if (!p) { p = document.createElement("p"); n.before(p); } p.appendChild(n); }
    else p = null;
  });
  if (keep && keep[0].isConnected) { try { const nr = document.createRange(); nr.setStart(keep[0], keep[1]); nr.setEnd(keep[2], keep[3]); s.removeAllRanges(); s.addRange(nr); } catch (e) {} }
}

/* ---------- undo history (snapshots; native undo can't see block ops) ---------- */
const hist = { stack: [], idx: -1, timer: null, pending: false };
function pathOf(n) { const p = []; while (n && n !== editor) { const par = n.parentNode; if (!par) return null; p.unshift([...par.childNodes].indexOf(n)); n = par; } return n === editor ? p : null; }
function nodeAtPath(path) { let n = editor; for (const i of path || []) { if (!n.childNodes[i]) return null; n = n.childNodes[i]; } return n; }
// Image data URLs are megabytes each; snapshots store a short token per image instead, so a note full
// of screenshots doesn't multiply its weight by the depth of the undo stack.
const histImgByUrl = new Map(), histImgByKey = new Map();
function histPack(html) {
  return html.replace(/src="(data:[^"]{512,})"/g, (m, u) => {
    let k = histImgByUrl.get(u);
    if (!k) { k = "mkimg:" + histImgByUrl.size; histImgByUrl.set(u, k); histImgByKey.set(k, u); }
    return `src="${k}"`;
  });
}
function histUnpack(html) { return html.replace(/src="(mkimg:\d+)"/g, (m, k) => `src="${histImgByKey.get(k) || ""}"`); }
function histSnap() {
  const r = selRange();
  return { html: histPack(editor.innerHTML), sel: r ? { s: pathOf(r.startContainer), so: r.startOffset, e: pathOf(r.endContainer), eo: r.endOffset } : null };
}
function histReset() { clearTimeout(hist.timer); hist.pending = false; histImgByUrl.clear(); histImgByKey.clear(); hist.stack = [histSnap()]; hist.idx = 0; }
function histCommit() {
  clearTimeout(hist.timer); hist.pending = false;
  const s = histSnap(), cur = hist.stack[hist.idx];
  if (cur && cur.html === s.html) { cur.sel = s.sel; return; }
  hist.stack.length = hist.idx + 1;
  hist.stack.push(s);
  if (hist.stack.length > 300) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
}
function histTyping() { hist.pending = true; clearTimeout(hist.timer); hist.timer = setTimeout(histCommit, 650); }
function histFlush() { if (hist.pending) histCommit(); }
function histApply(s) {
  editor.innerHTML = histUnpack(s.html);
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  const sel = window.getSelection();
  try {
    const a = s.sel && nodeAtPath(s.sel.s), b = s.sel && nodeAtPath(s.sel.e);
    const r = document.createRange();
    if (a && b) { r.setStart(a, Math.min(s.sel.so, a.nodeType === 3 ? a.length : a.childNodes.length)); r.setEnd(b, Math.min(s.sel.eo, b.nodeType === 3 ? b.length : b.childNodes.length)); }
    else { r.selectNodeContents(editor); r.collapse(false); }
    sel.removeAllRanges(); sel.addRange(r);
  } catch (e) {}
  updateChecklistCounts(); queueSave(); syncToolbar();
}
function undo() { histFlush(); if (hist.idx <= 0) return; hist.idx--; histApply(hist.stack[hist.idx]); }
function redo() { histFlush(); if (hist.idx >= hist.stack.length - 1) return; hist.idx++; histApply(hist.stack[hist.idx]); }

/* ---------- paste ---------- */
let PASTE_PALETTE = null;
function normColor(c) { const s = document.createElement("span"); s.style.color = c; return s.style.color; }
// Only Margin's own six status inks survive a paste (so colored text copied between notes keeps its
// color). Page inks: #000 from Google Docs, #333 from a blog: would be invisible on the other theme.
function pastePalette() {
  if (PASTE_PALETTE) return PASTE_PALETTE;
  PASTE_PALETTE = new Set();
  [false, true].forEach((dark) => {
    const d = document.createElement("div"); if (dark) d.className = "dark"; d.style.display = "none";
    document.body.appendChild(d);
    const cs = getComputedStyle(d);
    STATUS_KEYS.forEach((k) => { const v = cs.getPropertyValue("--status-" + k).trim(); if (v) PASTE_PALETTE.add(normColor(v)); });
    d.remove();
  });
  return PASTE_PALETTE;
}
const PASTE_BLOCKY = "section,article,header,footer,main,nav,aside,figure,figcaption,address,dl,dt,dd,center,fieldset,legend,caption,hgroup,details:not(.toggle),summary";
// Clean clipboard / dropped HTML into Margin's block vocabulary. Returns a detached <div>.
function cleanPastedHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const body = doc.body;
  // GitHub / markdown task lists: <li><input type=checkbox checked> text → checklist items
  body.querySelectorAll("li input[type=checkbox]").forEach((inp) => {
    const li = inp.closest("li"); if (!li) return;
    if (li.parentElement) li.parentElement.classList.add("checklist");
    if (inp.checked || inp.hasAttribute("checked")) li.classList.add("checked");
    inp.remove();
  });
  // Google Docs wraps the whole clipboard in <b style="font-weight:normal" id="docs-internal-guid-…">
  body.querySelectorAll("b,strong").forEach((b) => { const fw = (b.style.fontWeight || "").trim(); if (fw === "normal" || (+fw && +fw < 600)) unwrap(b); });
  const palette = pastePalette();
  body.querySelectorAll("[style]").forEach((el) => {
    const st = el.style;
    const inHeading = !!el.closest("h1,h2,h3,h4,h5,h6,th");
    const wraps = [];
    const fw = (st.fontWeight || "").trim();
    if (!inHeading && (fw === "bold" || fw === "bolder" || +fw >= 600) && !el.closest("b,strong")) wraps.push("b");
    if (st.fontStyle === "italic" && !el.closest("i,em")) wraps.push("i");
    const td = (st.textDecorationLine || st.textDecoration || "");
    if (/underline/.test(td) && !el.closest("u")) wraps.push("u");
    if (/line-through/.test(td) && !el.closest("s,strike,del")) wraps.push("s");
    wraps.forEach((t) => { const w = doc.createElement(t); while (el.firstChild) w.appendChild(el.firstChild); el.appendChild(w); });
    ["font-weight", "font-style", "text-decoration", "text-decoration-line", "margin-left"].forEach((p) => st.removeProperty(p));
    if (st.color && !palette.has(normColor(st.color))) st.removeProperty("color");
    if (!el.classList.contains("badge")) { st.removeProperty("background-color"); st.removeProperty("background"); }
  });
  body.querySelectorAll("h4,h5,h6").forEach((h) => renameEl(h, "h3"));
  body.querySelectorAll(PASTE_BLOCKY).forEach((el) => { if (el.isConnected) renameEl(el, "div"); });
  // <del>/<ins>/<mark>/<sup>… aren't on the whitelist; keep strikethrough at least
  body.querySelectorAll("del").forEach((el) => renameEl(el, "s"));
  const out = document.createElement("div");
  out.innerHTML = sanitizeHtml(body.innerHTML);
  // wrapper <div>s: unwrap when they hold blocks, otherwise they're a paragraph
  [...out.querySelectorAll("div")].reverse().forEach((d) => {
    if (d.classList.length) return; // callout / toggle / link-card parts copied from Margin
    if ([...d.childNodes].some(isBlockish)) unwrap(d); else renameEl(d, "p");
  });
  [...out.querySelectorAll("p")].reverse().forEach((p) => { if ([...p.childNodes].some(isBlockish)) unwrap(p); });
  out.querySelectorAll("span").forEach((s) => { if (!s.attributes.length) unwrap(s); });
  out.querySelectorAll("font").forEach((f) => { if (!f.getAttribute("style")) unwrap(f); });
  // whitespace-only text between blocks (pretty-printed HTML) is noise
  [...out.childNodes].forEach((n) => { if (n.nodeType === 3 && !n.data.trim()) n.remove(); });
  return out;
}
// A cleaned container is "inline" when it's just a run of text/inline nodes, or one plain paragraph.
function inlineContent(div) {
  const kids = [...div.childNodes].filter((n) => !(n.nodeType === 3 && !n.data.trim()));
  if (!kids.length) return null;
  if (kids.every((n) => !isBlockish(n) && !isAtom(n))) { const f = document.createDocumentFragment(); kids.forEach((n) => f.appendChild(n)); return f; }
  if (kids.length === 1 && kids[0].tagName === "P" && !kids[0].attributes.length) { const f = document.createDocumentFragment(); while (kids[0].firstChild) f.appendChild(kids[0].firstChild); return f; }
  return null;
}
function linesFromContainer(div) {
  const ctx = { out: [], stash: [] };
  explodeChildren([...div.childNodes], ctx);
  ctx.out.forEach((L) => { L.sel = true; L.listId = -1; });
  return ctx.out;
}
// Plain text: one line per row; "- ", "* ", "• ", "1. ", "[ ] " / "- [x] " rows become real list items.
function linesFromText(text) {
  const rows = (text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  rows.forEach((row) => {
    if (!row.trim()) return;
    let m, kind = "p", level = 0, checked = false, body = row;
    const lvl = (ws) => Math.min(6, Math.floor(ws.replace(/\t/g, "  ").length / 2));
    if ((m = /^(\s*)(?:[-*+•◦▪‣]\s+)?\[( |x|X)\]\s+(.*)$/.exec(row))) { kind = "check"; level = lvl(m[1]); checked = m[2] !== " "; body = m[3]; }
    else if ((m = /^(\s*)[-*+•◦▪‣]\s+(.*)$/.exec(row))) { kind = "ul"; level = lvl(m[1]); body = m[2]; }
    else if ((m = /^(\s*)\d{1,3}[.)]\s+(.*)$/.exec(row))) { kind = "ol"; level = lvl(m[1]); body = m[2]; }
    const f = document.createDocumentFragment(); f.appendChild(document.createTextNode(kind === "p" ? row.replace(/\s+$/, "") : body));
    out.push(newLine({ kind, frag: f, level, checked, src: ++lineSeq, sel: true, listId: -1 }));
  });
  return out;
}
function insertInlineFragment(frag) {
  const r = selRange(); if (!r) return;
  const last = frag.lastChild;
  r.insertNode(frag);
  if (last) { const nr = document.createRange(); nr.setStartAfter(last); nr.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(nr); }
}
function insertPlainText(text) { document.execCommand("insertText", false, text); }
// Splice pasted/dropped lines into the line under the caret: the caret's line splits at the caret,
// the first pasted row joins its head and the last joins its tail (Docs semantics). In a list, pasted
// rows become items of that list.
function insertLinesAtCaret(ins, opts) {
  const merge = !(opts && opts.merge === false);
  if (!ins || !ins.length) return false;
  histFlush();
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  if (!selRange()) { const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  if (!window.getSelection().isCollapsed) document.execCommand("delete");
  const mk = placeMarkers(); if (!mk) return false;
  let caretToNext = null;
  try {
    const root = flowRootOf(mk.ms) || editor;
    const a = topChildOf(root, mk.ms);
    const nodes = regionNodes(root, a, a);
    const anchor = nodes[nodes.length - 1].nextSibling;
    nodes.forEach((n) => n.remove());
    const ctx = { out: [], stash: [] };
    explodeChildren(nodes, ctx);
    if (ctx.stash.length) { const f = document.createDocumentFragment(); ctx.stash.forEach((m) => f.appendChild(m)); ctx.out.push(newLine({ kind: "p", frag: f, origKind: "p", src: ++lineSeq })); }
    let idx = ctx.out.findIndex((L) => (L.kind === "atom" ? L.node : L.frag).contains(mk.ms));
    if (idx < 0) idx = ctx.out.length - 1;
    const host = ctx.out[idx];
    let seq;
    if (host.kind === "atom") {
      seq = [host, ...ins];
      const last = ins[ins.length - 1];
      const tail = newLine({ kind: "p", frag: document.createDocumentFragment(), src: ++lineSeq, sel: true });
      tail.frag.append(mkMarker("s"), mkMarker("e"));
      if (last.kind === "atom") seq.push(tail); else { last.frag.append(...tail.frag.childNodes); }
      mk.ms.remove(); mk.me.remove();
    } else {
      // split the host line at the caret
      const hr = document.createRange(); hr.setStart(host.frag, 0); hr.setEndBefore(mk.ms);
      const head = cleanFrag(hr.extractContents());
      mk.ms.remove(); mk.me.remove();
      const tail = host.frag;
      const isList = LIST_KINDS.has(host.kind);
      if (isList) {
        ins.forEach((L) => {
          if (L.kind === "atom") return;
          const wasList = LIST_KINDS.has(L.kind);
          L.heading = L.heading || (isHeadingKind(L.kind) ? L.kind : null);
          L.level = (host.level || 0) + (wasList ? (L.level || 0) : 0);
          if (!(host.kind === "check" && L.kind === "check")) L.checked = false;
          L.kind = host.kind; L.listId = host.listId;
        });
      }
      const headL = Object.assign({}, host, { frag: head, sel: true });
      const tailL = Object.assign({}, host, { frag: tail, sel: true, checked: false, src: ++lineSeq });
      const mergeable = (L) => merge && L && L.kind !== "atom" && (L.kind === "p" || L.kind === host.kind) && !(L.heading && L.heading !== host.heading);
      const mid = ins.slice();
      if (mergeable(mid[0])) headL.frag.append(...mid.shift().frag.childNodes);
      const caretS = mkMarker("s"), caretE = mkMarker("e");
      let lastAtom = false;
      if (mid.length && mergeable(mid[mid.length - 1])) {
        const L = mid.pop(); tailL.frag.insertBefore(caretE, tailL.frag.firstChild); tailL.frag.insertBefore(caretS, caretE);
        const lf = L.frag; tailL.frag.insertBefore(lf, tailL.frag.firstChild);
      } else {
        lastAtom = mid.length && mid[mid.length - 1].kind === "atom";
        // an image dropped at the end of a line that's followed by more content: no blank line after it
        const nextEl = anchor && (anchor.nodeType === 1 ? anchor : sibEl(anchor, 1));
        if (lastAtom && fragIsEmpty(tailL.frag) && idx === ctx.out.length - 1 && nextEl && !isAtom(nextEl)) { lastAtom = false; caretToNext = nextEl; }
        if (!mid.length) { headL.frag.append(caretS, caretE); }
        else if (!fragIsEmpty(tailL.frag) || lastAtom) tailL.frag.insertBefore(caretE, tailL.frag.firstChild), tailL.frag.insertBefore(caretS, caretE);
        else if (caretToNext) { /* caret goes to the following block after rebuild */ }
        else if (!merge) { mid[mid.length - 1].kind === "atom" ? (tailL.frag.append(caretS, caretE), lastAtom = true) : mid[mid.length - 1].frag.append(caretS, caretE); }
        else { mid[mid.length - 1].frag.append(caretS, caretE); }
      }
      seq = [];
      const headEmpty = fragIsEmpty(headL.frag) && !headL.frag.querySelector("[data-mk]");
      if (!headEmpty || (!mid.length && fragIsEmpty(tailL.frag))) seq.push(headL);
      seq.push(...mid);
      const tailHasMk = !!tailL.frag.querySelector("[data-mk]");
      if (!fragIsEmpty(tailL.frag) || tailHasMk || lastAtom) seq.push(tailL);
      if (!seq.length) seq.push(headL);
      mk.ms = caretS; mk.me = caretE;
    }
    const lines = [...ctx.out.slice(0, idx), ...seq, ...ctx.out.slice(idx + 1)];
    const frag = rebuild(lines);
    const first = frag.firstChild, last = frag.lastChild;
    root.insertBefore(frag, anchor);
    mergeNeighborLists(first, last, lines);
    ensureTypingRoom(root);
    if (!mk.ms || !mk.ms.isConnected) { mk.ms = editor.querySelector('[data-mk="s"]'); mk.me = editor.querySelector('[data-mk="e"]'); }
  } finally {
    restoreMarkers(mk);
  }
  if (caretToNext && caretToNext.isConnected) caretToStartOf(caretToNext);
  normalizeLive();
  afterStructuralEdit();
  const sr = selRange(); if (sr) { const el = sr.startContainer.nodeType === 1 ? sr.startContainer : sr.startContainer.parentNode; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }
  return true;
}
function caretInCode() { const r = selRange(); return !!(r && closestIn(r.startContainer, (n) => isEl(n) && (n.tagName === "PRE" || n.tagName === "SUMMARY" || n.classList.contains("link-card")))); }
// Insert already-cleaned HTML at the caret (paste, drop, captures). Remote images are localized after.
// opts.merge === false inserts whole blocks (captures keep their quote/citation/provenance shape).
function insertHtmlAtCaret(html, opts) {
  const div = cleanPastedHtml(html);
  if (caretInCode()) { insertPlainText(div.innerText || div.textContent || ""); return; }
  const imgs = [...div.querySelectorAll("img")];
  const inl = opts && opts.merge === false ? null : inlineContent(div);
  if (inl) { histFlush(); insertInlineFragment(inl); normalizeLive(); afterStructuralEdit(); }
  else insertLinesAtCaret(linesFromContainer(div), opts);
  if (imgs.length && typeof localizeImages === "function") localizeImages(imgs);
}
function insertTextAtCaret(text) {
  if (caretInCode()) { insertPlainText(text); return; }
  const lines = linesFromText(text);
  if (!lines.length) return;
  if (lines.length === 1 && lines[0].kind === "p") { histFlush(); insertPlainText(text.replace(/\r?\n/g, " ").trim()); histCommit(); return; }
  insertLinesAtCaret(lines);
}
function onEditorPaste(e) {
  const dt = e.clipboardData; if (!dt) return;
  e.preventDefault();
  const files = [...(dt.files || [])].filter((f) => /^image\//.test(f.type));
  const html = dt.getData("text/html"), text = dt.getData("text/plain");
  // A copied image / screenshot arrives as a file (often with a stub <img> HTML twin): keep the pixels.
  const htmlIsJustImg = html && !htmlToText(html).trim();
  if (files.length && (!html || htmlIsJustImg) && !text.trim()) { insertImageFiles(files); return; }
  if (files.length && htmlIsJustImg) { insertImageFiles(files); return; }
  if (html && html.trim()) insertHtmlAtCaret(html);
  else if (text) insertTextAtCaret(text);
  else if (files.length) insertImageFiles(files);
}
