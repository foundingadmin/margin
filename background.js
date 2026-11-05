// Margin — background service worker (MV3)
// - Toggle the side panel (open via API, close via the panel's window.close).
// - Right-click "Save selection to Margin" -> stash a pendingCapture; the panel inserts it.
// - fetchMeta(url): pull Open Graph title/description/image for link cards.

const CAPTURE_ID = "margin_capture_selection";
const CAPTURE_IMG_ID = "margin_capture_image";
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
    chrome.contextMenus.create({ id: CAPTURE_IMG_ID, title: "Save image to Margin", contexts: ["image"] });
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
    setTimeout(checkForUpdate, 1500); // a deferred self-reload can run once the panel is gone
  });
  checkForUpdate(); // panel just opened: if a newer build is on disk, tell it (never yank it closed)
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
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle_margin") return toggle(tab && tab.windowId);
  if (command === "paste_from_page") return pasteFromPage(tab);
});

/* ---------- paste-from-page (#5) ----------
   A hotkey that pulls the active tab's *live* selection into the currently open note. Unlike
   right-click capture (which makes a visible blockquote + citation), this drops the selection
   as a plain paragraph tagged with provenance (data-src) — a *certain* source, since we read it
   straight off the page the user is on. The panel inserts it into the open note at the caret. */
async function pasteFromPage(tab) {
  if (!tab || tab.id == null) return;
  if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {}); // sync: keep the gesture
  let sel = "";
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { try { return String(window.getSelection() || ""); } catch (e) { return ""; } }
    });
    sel = (res && res.result) || "";
  } catch (e) { sel = ""; } // restricted page (chrome://, web store, PDF viewer) — no access
  const text = sel.replace(/ /g, " ").trim();
  const url = tab.url || "", host = hostOf(url), pk = pageKeyOf(url);
  if (!text) {
    // Nothing selected (or unreadable page): tell the panel so it can show a gentle hint, not insert.
    chrome.storage.session.set({ "margin.pendingCapture": { at: Date.now(), mode: "paste", empty: true } });
    return;
  }
  const inner = text.split(/\r?\n/).map((l) => escapeHtml(l)).join("<br>");
  const tag = host ? ` data-src="${escapeHtml(url)}" data-srchost="${escapeHtml(host)}" title="${escapeHtml(url)}"` : "";
  const html = `<p class="prov"${tag}>${inner}</p>`;
  chrome.storage.session.set({ "margin.pendingCapture": { at: Date.now(), mode: "paste", html, url, host: host || null, pageKey: pk || null, title: tab.title || "" } });
}

/* ---------- selection capture ----------
   The panel owns note targeting now: it knows the open note, the lock state, and the live
   caret. So the worker just opens the panel (synchronously, to keep the gesture) and stashes
   the quote as a pendingCapture; the panel inserts it — into the locked/open note at the
   caret (B4 + B5), else into the page's note. This also removes the panel/worker write race. */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CAPTURE_IMG_ID) return captureImage(info, tab);
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

/* ---------- image capture (right-click a web image) ----------
   Same hand-off as text capture: the worker opens the panel (sync, keeping the gesture) and
   stashes an <img> + citation; the panel fetches the bytes and stores a local copy in the note,
   so the image survives the page changing. mode:"image" tells the panel to localize it. */
function captureImage(info, tab) {
  const src = info.srcUrl || "";
  if (!/^(https?:|data:image\/)/i.test(src)) return;
  if (tab && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const url = info.pageUrl || (tab && tab.url) || "";
  const host = hostOf(url);
  const pk = pageKeyOf(url);
  const name = (() => { try { return decodeURIComponent(new URL(src).pathname.split("/").pop() || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim(); } catch (e) { return ""; } })();
  const cite = url ? `<p class="src"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host || "source")}</a> · ${shortStamp()}</p>` : "";
  const html = `<img src="${escapeHtml(src)}" alt="${escapeHtml(name || "Image")}">${cite}`;
  chrome.storage.session.set({ "margin.pendingCapture": { at: Date.now(), mode: "image", html, url, host: host || null, pageKey: pk || null, title: (tab && tab.title) || "" } });
}

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

/* ---------- self-reload for unpacked (dev) installs ----------
   Margin is loaded unpacked from a git checkout that update-margin.command keeps on main.
   Chrome serves an unpacked extension's files straight from disk, but only re-reads the
   manifest and restarts this worker on an explicit reload. So: read manifest.json from disk,
   and when its version differs from the running one, call chrome.runtime.reload() ourselves.
   - Only for installType "development"; a store install updates through Chrome as usual.
   - Checked on worker start, on panel open/close, and every minute (chrome.alarms).
   - Never while a panel is open (a reload closes it): the panel gets an "update ready"
     notice instead, and the reload happens as soon as it closes, or on "Reload now".
   - Waits for the version on disk to hold steady for a few seconds so a reload can't land
     halfway through a git checkout, and reloads at most once per version (loop guard). */
const UPDATE_ALARM = "margin_update_check";
const RELOAD_GUARD_KEY = "margin.selfReloadedFor"; // chrome.storage.local (session storage is wiped by a reload)
let devInstallP = null;
function isDevInstall() {
  if (!devInstallP) devInstallP = new Promise((resolve) => {
    const fallback = () => resolve(!("update_url" in chrome.runtime.getManifest())); // store installs carry update_url
    try {
      if (!chrome.management || !chrome.management.getSelf) return fallback();
      chrome.management.getSelf((info) => { if (chrome.runtime.lastError || !info) fallback(); else resolve(info.installType === "development"); });
    } catch (e) { fallback(); }
  });
  return devInstallP;
}
async function diskVersion() {
  try {
    const r = await fetch(chrome.runtime.getURL("manifest.json") + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return null;
    const v = (await r.json()).version;
    return typeof v === "string" ? v : null;
  } catch (e) { return null; } // missing or half-written mid-update: try again next tick
}
async function panelIsOpen() {
  if (chrome.runtime.getContexts) {
    try { return (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length > 0; } catch (e) {}
  }
  return openPanels.size > 0; // older Chromium: trust the port map (errs toward "open" = no reload)
}
function tellPanels(version) {
  for (const port of openPanels.values()) { if (port) { try { port.postMessage({ type: "updateReady", version }); } catch (e) {} } }
}
let updateCheck = null;
function checkForUpdate() { return updateCheck || (updateCheck = runUpdateCheck().catch(() => {}).finally(() => { updateCheck = null; })); }
async function runUpdateCheck() {
  if (!(await isDevInstall())) return;
  const running = chrome.runtime.getManifest().version;
  const v = await diskVersion();
  if (!v || v === running) return;
  await new Promise((r) => setTimeout(r, 3000)); // let an in-flight checkout finish
  if ((await diskVersion()) !== v) return;
  if (await panelIsOpen()) { tellPanels(v); return; }
  const guard = (await chrome.storage.local.get(RELOAD_GUARD_KEY))[RELOAD_GUARD_KEY];
  if (guard === v) return; // already reloaded for this version once and it didn't take: don't loop
  await chrome.storage.local.set({ [RELOAD_GUARD_KEY]: v });
  chrome.runtime.reload();
}
isDevInstall().then((dev) => {
  if (!dev) { chrome.alarms && chrome.alarms.clear(UPDATE_ALARM); return; }
  // get-then-create: re-creating on every worker wake would keep pushing the alarm back.
  chrome.alarms.get(UPDATE_ALARM, (a) => { if (!a) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 }); });
  checkForUpdate();
});
if (chrome.alarms) chrome.alarms.onAlarm.addListener((a) => { if (a.name === UPDATE_ALARM) checkForUpdate(); });
