/* Margin: images (v0.14)
   ---------------------------------------------------------------------------
   IN:  paste (screenshots, "Copy image", files), drag & drop (Finder / desktop
        files, images dragged straight off a web page), the Image block, and the
        right-click "Save image to Margin" capture. Every image is stored INSIDE
        the note as a data URL: a remote image is fetched and kept locally, so a
        screenshot of a success toast or a reference shot survives the page
        changing or disappearing.
   OUT: hover an image → Copy (PNG to the clipboard) / Download. Click an image to
        select it, then ⌘/Ctrl+C copies the picture itself. Drag an image out of
        the panel onto the desktop or a folder to save it as a file. Right-click →
        Chrome's own "Save image as…" / "Copy image" work as well.

   Storage note: images are downscaled to IMG_MAX on the long edge. Screenshots
   (PNG) stay lossless unless that gets heavy, then fall back to high-quality
   WebP; photos go to JPEG. GIFs and SVGs are kept untouched (animation/vector).
*/

const IMG_MAX = 2400;               // long-edge cap (keeps retina screenshots crisp)
const IMG_PNG_BUDGET = 3_500_000;   // data-URL chars before a PNG falls back to WebP
const IMG_RAW_MAX = 8_000_000;      // GIF / SVG kept as-is up to this size
const IMG_STATUS_MS = 1600;

function readAsDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}
function loadImageEl(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("decode")); im.src = src; });
}
// Blob → compact, durable data URL.
async function blobToStoredDataUrl(blob) {
  const type = (blob.type || "").toLowerCase();
  if ((type === "image/gif" || type === "image/svg+xml") && blob.size <= IMG_RAW_MAX) return readAsDataURL(blob);
  let src, w, h, draw;
  try {
    const bmp = await createImageBitmap(blob);
    w = bmp.width; h = bmp.height; draw = (ctx, cw, ch) => ctx.drawImage(bmp, 0, 0, cw, ch);
  } catch (e) {
    src = await readAsDataURL(blob);
    const im = await loadImageEl(src);
    w = im.naturalWidth; h = im.naturalHeight; draw = (ctx, cw, ch) => ctx.drawImage(im, 0, 0, cw, ch);
  }
  if (!w || !h) throw new Error("empty image");
  const s = Math.min(1, IMG_MAX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const ctx = c.getContext("2d"); draw(ctx, cw, ch);
  const lossless = !type || /png|webp|bmp|x-icon|vnd\.microsoft\.icon|avif/.test(type);
  if (lossless) {
    const png = c.toDataURL("image/png");
    if (png.length <= IMG_PNG_BUDGET) return png;
    return c.toDataURL("image/webp", 0.92);
  }
  return c.toDataURL("image/jpeg", 0.88);
}
// Extension pages with host permission can read cross-origin image bytes (no CORS taint).
async function fetchImageBlob(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { credentials: "omit", signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("http " + res.status);
    const blob = await res.blob();
    if (blob.type && !/^image\//.test(blob.type)) throw new Error("not an image");
    return blob;
  } finally { clearTimeout(t); }
}
function altFromName(name) {
  const base = (name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();
  if (!base || /^image$/i.test(base)) return "Image";
  return base.slice(0, 120);
}
function makeImg(src, alt) { const im = document.createElement("img"); im.src = src; im.alt = alt || "Image"; return im; }
function imgStatus(msg, kind) { setStatus(msg, kind || "saved"); setTimeout(() => setStatus("Saved"), IMG_STATUS_MS); }
function imageLines(imgs) { return imgs.map((im) => newLine({ kind: "atom", node: im, sel: true })); }

// Files (paste / drop / picker) → images at the caret.
async function insertImageFiles(files) {
  const list = [...files].filter((f) => /^image\//.test(f.type));
  if (!list.length) return;
  imgStatus(list.length > 1 ? `Adding ${list.length} images…` : "Adding image…", "saving");
  const imgs = [];
  for (const f of list) {
    try {
      const alt = f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? altFromName(f.name) : "Screenshot";
      imgs.push(makeImg(await blobToStoredDataUrl(f), alt));
    } catch (e) {}
  }
  if (!imgs.length) { imgStatus("Couldn't read that image", "error"); return; }
  insertLinesAtCaret(imageLines(imgs));
  imgStatus(imgs.length > 1 ? `${imgs.length} images added` : "Image added");
}
// Remote image URL(s) → a local copy at the caret (falls back to a linked image if the site refuses).
async function insertImageUrls(urls) {
  const imgs = [];
  for (const u of urls) {
    let alt = "Image"; try { alt = altFromName(decodeURIComponent(new URL(u).pathname.split("/").pop() || "")); } catch (e) {}
    try { imgs.push(makeImg(await blobToStoredDataUrl(await fetchImageBlob(u)), alt)); }
    catch (e) { imgs.push(makeImg(u, alt)); }
  }
  if (imgs.length) insertLinesAtCaret(imageLines(imgs));
  const remote = imgs.filter((im) => /^https?:/i.test(im.getAttribute("src") || "")).length;
  if (remote) imgStatus("Saved as a link: that site blocked a local copy", "error");
  else imgStatus(imgs.length > 1 ? `${imgs.length} images saved` : "Image saved");
}
// After HTML with <img src="https://…"> is inserted, swap each for a stored copy in place.
async function localizeImages(imgs) {
  let changed = false;
  await Promise.all(imgs.map(async (stale) => {
    const src = stale.getAttribute("src") || "";
    if (!/^https?:/i.test(src)) return;
    // the inserted node is a clone of `stale`; find the live one by src
    const live = [...editor.querySelectorAll("img")].find((im) => im.getAttribute("src") === src);
    try {
      const data = await blobToStoredDataUrl(await fetchImageBlob(src));
      editor.querySelectorAll("img").forEach((im) => { if (im.getAttribute("src") === src) { im.src = data; changed = true; } });
    } catch (e) { if (live) live.dataset.remote = "1"; }
  }));
  if (changed) { queueSave(); histCommit(); }
}
// Same, for an HTML string that isn't in the editor yet (captures into a closed note).
async function localizeHtml(html) {
  const d = document.createElement("div"); d.innerHTML = html;
  await Promise.all([...d.querySelectorAll("img")].map(async (im) => {
    const src = im.getAttribute("src") || "";
    if (!/^https?:/i.test(src)) return;
    try { im.src = await blobToStoredDataUrl(await fetchImageBlob(src)); } catch (e) {}
  }));
  return d.innerHTML;
}

/* ---------- getting images OUT ---------- */
function imgMime(src) { const m = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(src || ""); return m ? m[1].toLowerCase() : "image/png"; }
const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" };
function imgFileName(img) {
  const n = activeNote();
  const base = ((img.alt && img.alt !== "Image" ? img.alt : "") || (n && n.title) || "margin-image").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "margin-image";
  const src = img.getAttribute("src") || "";
  let ext = MIME_EXT[imgMime(src)] || "png";
  if (/^https?:/i.test(src)) { const m = /\.(png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/i.exec(src); ext = m ? m[1].toLowerCase().replace("jpeg", "jpg") : "png"; }
  return `${base}.${ext}`;
}
async function imgBlob(img) {
  const src = img.getAttribute("src") || "";
  if (/^https?:/i.test(src)) return fetchImageBlob(src);
  return (await fetch(src)).blob();
}
// Most apps only accept PNG from the clipboard: re-encode anything else.
async function imgPngBlob(img) {
  const blob = await imgBlob(img);
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/png"));
}
async function copyImage(img) {
  try {
    // Pass the promise straight to ClipboardItem so the user-activation window isn't lost while encoding.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": imgPngBlob(img) })]);
    imgStatus("Image copied");
  } catch (e) { imgStatus("Couldn't copy the image", "error"); }
}
async function downloadImage(img) {
  try {
    const src = img.getAttribute("src") || "";
    const href = /^https?:/i.test(src) ? URL.createObjectURL(await fetchImageBlob(src)) : src;
    const a = document.createElement("a"); a.href = href; a.download = imgFileName(img); document.body.appendChild(a); a.click(); a.remove();
    if (href !== src) setTimeout(() => URL.revokeObjectURL(href), 4000);
  } catch (e) { imgStatus("Couldn't download the image", "error"); }
}
function editorImgFrom(t) { return t && t.tagName === "IMG" && editor.contains(t) && !t.closest("a.link-card") ? t : null; }
function selectedImage() {
  const s = window.getSelection(); if (!s.rangeCount) return null;
  const r = s.getRangeAt(0); if (!editor.contains(r.commonAncestorContainer)) return null;
  const c = r.cloneContents();
  if ((c.textContent || "").trim() !== "" || c.querySelectorAll("img").length !== 1) return null;
  const imgs = [...editor.querySelectorAll("img")].filter((im) => r.intersectsNode(im) && !im.closest("a.link-card"));
  return imgs.length === 1 ? imgs[0] : null;
}

/* ---------- hover tools ---------- */
let imgToolsFor = null, imgToolsHide = null;
function positionImgTools() {
  const tools = $("img-tools"); if (!tools || !imgToolsFor) return;
  if (!imgToolsFor.isConnected) { hideImgTools(true); return; }
  const host = $("view-editor").getBoundingClientRect(), r = imgToolsFor.getBoundingClientRect(), ed = editor.getBoundingClientRect();
  // hide while the image is scrolled out of the editor viewport
  if (r.bottom < ed.top + 24 || r.top > ed.bottom - 24) { tools.hidden = true; return; }
  tools.hidden = false;
  tools.style.top = Math.max(ed.top, r.top) - host.top + 8 + "px";
  tools.style.left = Math.min(r.right, ed.right - 8) - host.left - tools.offsetWidth - 8 + "px";
}
function showImgTools(img) {
  clearTimeout(imgToolsHide);
  imgToolsFor = img;
  positionImgTools();
}
function hideImgTools(now) {
  clearTimeout(imgToolsHide);
  const go = () => { const t = $("img-tools"); if (t) t.hidden = true; imgToolsFor = null; };
  if (now) go(); else imgToolsHide = setTimeout(go, 220);
}

/* ---------- drag & drop ---------- */
let internalDrag = false;
const URL_IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:$|[?#])/i;
function dropRangeAt(x, y) {
  let r = null;
  if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
  if (!r || !editor.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); }
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function htmlImageSrcs(html) {
  const d = new DOMParser().parseFromString(html || "", "text/html");
  const text = (d.body.textContent || "").trim();
  return { text, srcs: [...d.querySelectorAll("img")].map((im) => im.getAttribute("src") || "").filter((s) => /^(https?:|data:image\/)/i.test(s)) };
}
async function handleExternalDrop(dt) {
  const files = [...(dt.files || [])].filter((f) => /^image\//.test(f.type));
  if (files.length) return insertImageFiles(files);
  const html = dt.getData("text/html"), uris = (dt.getData("text/uri-list") || "").split(/\r?\n/).filter((u) => u && !u.startsWith("#"));
  const { text, srcs } = htmlImageSrcs(html);
  // an image dragged off a page: its HTML is just <img> (maybe wrapped in a link)
  if (srcs.length && !text) {
    const data = srcs.filter((s) => /^data:image\//i.test(s));
    if (data.length) insertLinesAtCaret(imageLines(data.map((s) => makeImg(s, "Image"))));
    const remote = srcs.filter((s) => /^https?:/i.test(s));
    if (remote.length) await insertImageUrls(remote);
    return;
  }
  if (!html && uris.length && uris.every((u) => URL_IMG_RE.test(u))) return insertImageUrls(uris);
  if (html && html.trim()) return insertHtmlAtCaret(html);
  const plain = dt.getData("text/plain");
  if (plain) return insertTextAtCaret(plain);
}

function bindImages() {
  const view = $("view-editor");
  editor.addEventListener("mouseover", (e) => { const im = editorImgFrom(e.target); if (im) showImgTools(im); });
  editor.addEventListener("mouseout", (e) => { if (editorImgFrom(e.target) && !(e.relatedTarget && $("img-tools").contains(e.relatedTarget))) hideImgTools(); });
  $("img-tools").addEventListener("mouseenter", () => clearTimeout(imgToolsHide));
  $("img-tools").addEventListener("mouseleave", () => hideImgTools());
  $("img-tools").addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection
  $("img-tools").addEventListener("click", (e) => {
    const b = e.target.closest("[data-img-act]"); if (!b || !imgToolsFor) return;
    e.stopPropagation();
    if (b.dataset.imgAct === "copy") copyImage(imgToolsFor);
    else if (b.dataset.imgAct === "download") downloadImage(imgToolsFor);
  });
  editor.addEventListener("scroll", () => { if (imgToolsFor) positionImgTools(); });
  window.addEventListener("resize", () => { if (imgToolsFor) positionImgTools(); });
  editor.addEventListener("input", () => { if (imgToolsFor && !imgToolsFor.isConnected) hideImgTools(true); });

  // click an image → select it as an object (so ⌘C / Delete act on the image)
  editor.addEventListener("click", (e) => {
    const im = editorImgFrom(e.target); if (!im) return;
    const r = document.createRange(); r.selectNode(im);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  // ⌘C / ⌘X on a lone selected image puts the picture itself on the clipboard
  const copyLike = (e, cut) => {
    const im = selectedImage(); if (!im) return;
    e.preventDefault();
    e.clipboardData.setData("text/html", `<img src="${im.getAttribute("src")}" alt="${(im.alt || "").replace(/"/g, "&quot;")}">`);
    copyImage(im);
    if (cut) { histFlush(); document.execCommand("delete"); histCommit(); queueSave(); }
  };
  editor.addEventListener("copy", (e) => copyLike(e, false));
  editor.addEventListener("cut", (e) => copyLike(e, true));

  // drag OUT: hand the OS a real file (DownloadURL) plus URL/HTML for web targets
  editor.addEventListener("dragstart", (e) => {
    internalDrag = true;
    const im = editorImgFrom(e.target); if (!im) return;
    const src = im.getAttribute("src") || "";
    const mime = /^https?:/i.test(src) ? "image/png" : imgMime(src);
    try {
      e.dataTransfer.setData("DownloadURL", `${mime}:${imgFileName(im)}:${src}`);
      if (/^https?:/i.test(src)) e.dataTransfer.setData("text/uri-list", src);
      e.dataTransfer.setData("text/html", `<img src="${src}" alt="${(im.alt || "").replace(/"/g, "&quot;")}">`);
      e.dataTransfer.effectAllowed = "copyMove";
    } catch (err) {}
    hideImgTools(true);
  });
  document.addEventListener("dragend", () => { internalDrag = false; view.classList.remove("drop-on"); });

  // drop IN
  const accepts = (dt) => dt && [...dt.types].some((t) => t === "Files" || t === "text/html" || t === "text/uri-list" || t === "text/plain");
  view.addEventListener("dragover", (e) => {
    if (internalDrag || !accepts(e.dataTransfer)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    view.classList.add("drop-on");
  });
  view.addEventListener("dragleave", (e) => { if (!view.contains(e.relatedTarget)) view.classList.remove("drop-on"); });
  view.addEventListener("drop", (e) => {
    view.classList.remove("drop-on");
    if (internalDrag) { // moving content inside the note: let the browser move it, then tidy
      setTimeout(() => { normalizeLive(); updateChecklistCounts(); queueSave(); histCommit(); }, 0);
      return;
    }
    e.preventDefault();
    if (editor.contains(e.target) || e.target === editor) dropRangeAt(e.clientX, e.clientY);
    else { const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); const s = window.getSelection(); editor.focus({ preventScroll: true }); s.removeAllRanges(); s.addRange(r); }
    handleExternalDrop(e.dataTransfer);
  });
  // never let a stray file drop navigate the whole panel away from the app
  document.addEventListener("dragover", (e) => { if (!view.contains(e.target) && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => { if (!view.contains(e.target)) e.preventDefault(); });
}
