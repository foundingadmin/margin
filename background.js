// Margin — background service worker (MV3)
// - Toggle the side panel (open via API, close via the panel's window.close).
// - Right-click "Save selection to Margin" -> stash a pendingCapture; the panel inserts it.
// - fetchMeta(url): pull Open Graph title/description/image for link cards.

const CAPTURE_ID = "margin_capture_selection";
const OPEN_KEY = "margin.openWindows"; // chrome.storage.session: windowIds with the panel open (survives worker sleep)
const openPanels = new Map(); // windowId -> Port (in-memory mirror; the panel reconnects to keep this warm)

// Rehydrate the open-state map when the worker cold-starts. The live port is lost on a
// restart, so these entries carry a null port and fall back to a broadcast close.
chrome.storage.session.get(OPEN_KEY).then((d) => {
  const arr = d && d[OPEN_KEY];
  if (Array.isArray(arr)) arr.forEach((wid) => { if (!openPanels.has(wid)) openPanels.set(wid, null); });
}).catch(() => {});
function persistOpen() { try { chrome.storage.session.set({ [OPEN_KEY]: [...openPanels.keys()] }); } catch (e) {} }

/* ---------- helpers ----------
   Note creation/titling now lives in the panel (it owns capture insertion), so the worker
   only needs URL parsing and HTML escaping for the captured quote. */
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; } }
function pageKeyOf(url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return null; } }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function shortStamp(d = new Date()) {
  const mo = d.toLocaleString(undefined, { month: "short" });
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h < 12 ? "a" : "p"; h = h % 12 || 12;
  return `${mo} ${d.getDate()} ${h}:${m < 10 ? "0" + m : m}${ap}`;
}

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
  persistOpen();
  port.onMessage.addListener(() => {}); // panel pings keep the port (and worker) warm while open
  port.onDisconnect.addListener(() => {
    // Only clear when this exact port dies. If the worker is being torn down the panel
    // reconnects and re-registers, so the map stays accurate while a panel is open.
    if (openPanels.get(wid) === port) { openPanels.delete(wid); persistOpen(); }
  });
});
// The toggle decision must stay synchronous so sidePanel.open() keeps its user-gesture token:
// read the in-memory map (kept warm by the panel's reconnect), never await storage before open().
function toggle(windowId) {
  if (windowId == null) return;
  if (openPanels.has(windowId)) {
    const port = openPanels.get(windowId);
    if (port) { try { port.postMessage({ type: "close" }); } catch (e) {} }
    else { chrome.runtime.sendMessage({ type: "closePanel", windowId }, () => void chrome.runtime.lastError); } // rehydrated entry: no live port
  } else {
    chrome.sidePanel.open({ windowId }).catch(() => {});
  }
}
chrome.action.onClicked.addListener((tab) => toggle(tab && tab.windowId));
chrome.commands.onCommand.addListener((command, tab) => { if (command === "toggle_margin") toggle(tab && tab.windowId); });

/* ---------- selection capture ----------
   The panel owns note targeting now: it knows the open note, the lock state, and the live
   caret. So the worker just opens the panel (synchronously, to keep the gesture) and stashes
   the quote as a pendingCapture; the panel inserts it — into the locked/open note at the
   caret (B4 + B5), else into the page's note. This also removes the panel/worker write race. */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CAPTURE_ID) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;
  if (tab && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {}); // sync: preserve the user gesture
  const url = info.pageUrl || (tab && tab.url) || "";
  const host = hostOf(url);
  const pk = pageKeyOf(url);
  const inner = text.split("\n").map((l) => escapeHtml(l)).join("<br>");
  const src = `<p class="src"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host || "source")}</a> · ${shortStamp()}</p>`;
  const html = `<blockquote>${inner}</blockquote>${src}`;
  chrome.storage.session.set({ "margin.pendingCapture": { at: Date.now(), html, url, host: host || null, pageKey: pk || null, title: (tab && tab.title) || "" } });
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
