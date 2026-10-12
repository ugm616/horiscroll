// Ox Alpha — background service worker (MV3)

const DEBUG = false;
const log = (...a) => { if (DEBUG) console.log("[OxAlpha BG]", ...a); };

// ---- Defaults ----
const DEFAULTS = {
  globalEnabled: false,
  allowedSites: [],
  showFloatingBar: true,
  shiftWheel: true
};

// ---- Install / upgrade ----
chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.sync.get(DEFAULTS);
  // Merge in any missing keys (safe upgrade)
  await chrome.storage.sync.set({ ...DEFAULTS, ...cur });
  log("Installed/updated:", details.reason);
});

// ---- Helpers ----
function extractDomain(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function isSiteEnabled(url) {
  const s = await getSettings();
  if (s.globalEnabled) return true;
  const domain = extractDomain(url);
  if (!domain) return false;
  return s.allowedSites.some(
    (d) => domain === d || domain.endsWith("." + d)
  );
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE": {
          const url = msg.url || sender.tab?.url || "";
          const settings = await getSettings();
          sendResponse({
            settings,
            siteEnabled: await isSiteEnabled(url),
            domain: extractDomain(url)
          });
          break;
        }

        case "TOGGLE_GLOBAL": {
          await chrome.storage.sync.set({ globalEnabled: !!msg.value });
          await notifyAllTabs();
          sendResponse({ ok: true });
          break;
        }

        case "ADD_SITE": {
          const domain = extractDomain(msg.url || "");
          if (!domain) return sendResponse({ ok: false, error: "Invalid URL" });
          const { allowedSites = [] } = await chrome.storage.sync.get("allowedSites");
          if (!allowedSites.includes(domain)) {
            allowedSites.push(domain);
            await chrome.storage.sync.set({ allowedSites, globalEnabled: false });
            await notifyAllTabs();
          }
          sendResponse({ ok: true, domain });
          break;
        }

        case "REMOVE_SITE": {
          const { allowedSites = [] } = await chrome.storage.sync.get("allowedSites");
          const next = allowedSites.filter((d) => d !== msg.domain);
          await chrome.storage.sync.set({ allowedSites: next });
          await notifyAllTabs();
          sendResponse({ ok: true });
          break;
        }

        case "SET_SETTING": {
          await chrome.storage.sync.set({ [msg.key]: msg.value });
          await notifyAllTabs();
          sendResponse({ ok: true });
          break;
        }

        case "IMPORT_SETTINGS": {
          const data = msg.data || {};
          const clean = {
            globalEnabled: !!data.globalEnabled,
            allowedSites: Array.isArray(data.allowedSites)
              ? data.allowedSites.filter((d) => typeof d === "string" && d.length < 300)
              : [],
            showFloatingBar: data.showFloatingBar !== false,
            shiftWheel: data.shiftWheel !== false
          };
          await chrome.storage.sync.set(clean);
          await notifyAllTabs();
          sendResponse({ ok: true });
          break;
        }

        case "ENSURE_INJECTED": {
          // On-demand injection (used after toggles)
          if (sender.tab && sender.tab.id) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: sender.tab.id },
                files: ["content.js"]
              });
            } catch (e) {
              // Restricted page (chrome://, Web Store, etc.) — ignore
              log("Injection skipped:", e.message);
            }
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (e) {
      log("Message error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async sendResponse
});

// Tell tabs to re-evaluate their enabled state
async function notifyAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: "SETTINGS_CHANGED" }).catch(() => {});
    }
  } catch (e) {
    log("notifyAllTabs failed:", e);
  }
}
