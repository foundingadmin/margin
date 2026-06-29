// Margin — background service worker (MV3)
// - Toggle the side panel (open via API, close via the panel's window.close).
// - Right-click "Save selection to Margin" -> rich capture into the host's note.
// - fetchMeta(url): pull Open Graph title/description/image for link cards.

const STORE_KEY = "margin.notes";
const CAPTURE_ID = "margin_capture_selection";
const openPanels = new Map(); // windowId -> Port

/* ---------- helpers (mirrored in sidepanel.js) ---------- */
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; } }
function pageKeyOf(url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return null; } }
function uid() { return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
const TWO_LEVEL = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","co.nz","co.jp","com.br","co.in","com.mx"]);
function siteName(host) {
  if (!host) return "Note";
  const p = host.split(".");
  let label = p.length >= 3 && TWO_LEVEL.has(p.slice(-2).join(".")) ? p[p.length - 3] : (p.length >= 2 ? p[p.length - 2] : p[0]);
  label = label || host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function shortStamp(d = new Date()) {
  const mo = d.toLocaleString(undefined, { month: "short" });
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h < 12 ? "a" : "p"; h = h % 12 || 12;
  return `${mo} ${d.getDate()} ${h}:${m < 10 ? "0" + m : m}${ap}`;
}
const BRAND_WORDS = "Google Docs|Google Sheets|Google Slides|Google Drive|Google Search|Docs|Sheets|Slides|Claude|Notion|Figma|FigJam|GitHub|GitLab|YouTube|LinkedIn|Gmail|Outlook|Reddit|Stack Overflow|Medium|Substack|ClickUp|Slack|Vercel|Linear|Google";
const BRAND_SUFFIX = new RegExp("\\s*[-–—|·:]\\s*(" + BRAND_WORDS + ")\\s*$", "i");
const BRAND_WHOLE = new RegExp("^(" + BRAND_WORDS + ")$", "i");
function pageTag(info) {
  if (!info) return "";
  const url = info.url || "";
  let t = (info.title || "").trim().replace(/^\(\d+\)\s*/, "");
  const site = siteName(hostOf(url));
  for (let i = 0; i < 2; i++) { const n = t.replace(BRAND_SUFFIX, "").trim(); if (n === t) break; t = n; }
  if (site) { const re = new RegExp("\\s*[-–—|·:]\\s*" + site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i"); t = t.replace(re, "").trim(); }
  if (BRAND_WHOLE.test(t)) t = "";
  if (!t || t.toLowerCase() === (site || "").toLowerCase()) {
    try { const seg = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[0] || ""); t = seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : ""; } catch { t = ""; }
  } else { t = t.split(/\s+[-–—|]\s+/)[0].trim() || t; }
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
async function getNotes() { const d = await chrome.storage.local.get(STORE_KEY); return Array.isArray(d[STORE_KEY]) ? d[STORE_KEY] : []; }

/* ---------- install ---------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: CAPTURE_ID, title: "Save selection to Margin", contexts: ["selection"] });
  });
});

/* ---------- panel open tracking + toggle ---------- */
chrome.runtime.onConnect.addListener((port) => {
  const m = /^panel:(-?\d+)$/.exec(port.name || "");
  if (!m) return;
  const wid = Number(m[1]);
  openPanels.set(wid, port);
  port.onDisconnect.addListener(() => { if (openPanels.get(wid) === port) openPanels.delete(wid); });
});
function toggle(windowId) {
  if (windowId == null) return;
  const port = openPanels.get(windowId);
  if (port) { try { port.postMessage({ type: "close" }); } catch (e) {} }
  else chrome.sidePanel.open({ windowId }).catch(() => {});
}
chrome.action.onClicked.addListener((tab) => toggle(tab && tab.windowId));
chrome.commands.onCommand.addListener((command, tab) => { if (command === "toggle_margin") toggle(tab && tab.windowId); });

/* ---------- selection capture ---------- */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CAPTURE_ID) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;
  const url = info.pageUrl || (tab && tab.url) || "";
  const host = hostOf(url);
  const pk = pageKeyOf(url);
  const notes = await getNotes();
  let note = notes.filter((n) => (pk ? n.pageKey === pk : n.host === host && !n.pageKey)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!note) {
    const title = autoTitle(host, pageTag({ url, title: tab && tab.title }));
    note = { id: uid(), title, autoTitle: title, html: "", host: host || null, pageKey: pk || null, pinned: false, ephemeral: false, createdAt: Date.now(), updatedAt: Date.now() };
    notes.unshift(note);
  }
  note.ephemeral = false;
  const inner = text.split("\n").map((l) => escapeHtml(l)).join("<br>");
  const src = `<p class="src"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host || "source")}</a> · ${shortStamp()}</p>`;
  note.html = (note.html && note.html.trim() ? note.html : "") + `<blockquote>${inner}</blockquote>${src}`;
  note.updatedAt = Date.now();
  await chrome.storage.local.set({ [STORE_KEY]: notes, "margin.lastCapture": note.id, "margin.lastCaptureAt": Date.now() });
  if (tab && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

/* ---------- link-card metadata ---------- */
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
}
async function fetchMeta(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", redirect: "follow" });
    clearTimeout(timer);
    const finalUrl = res.url || url;
    const head = (await res.text()).slice(0, 250000);
    const pick = (re) => { const m = head.match(re); return m ? decodeEntities(m[1].trim()) : ""; };
    const meta = (prop) =>
      pick(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', "i")) ||
      pick(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', "i"));
    let title = meta("og:title") || meta("twitter:title") || pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let desc = meta("og:description") || meta("twitter:description") || meta("description");
    let image = meta("og:image:secure_url") || meta("og:image") || meta("twitter:image") || meta("twitter:image:src");
    if (image) { try { image = new URL(image, finalUrl).href; } catch (e) {} }
    const host = hostOf(finalUrl) || "";
    if (desc && desc.length > 200) desc = desc.slice(0, 197).trimEnd() + "…";
    return { url: finalUrl, title: (title || host || url).slice(0, 160), description: desc || "", image: image || "", host };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "fetchMeta" && msg.url) {
    fetchMeta(msg.url).then(sendResponse).catch(() => sendResponse(null));
    return true; // async response
  }
});
