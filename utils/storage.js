// Shared storage helpers (loaded via <script> in popup/options — no imports needed in MV3 pages)

const DEFAULTS = {
  globalEnabled: false,
  allowedSites: [],
  showFloatingBar: true,
  shiftWheel: true
};

async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

function extractDomain(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

// Simple JSON export/import validation
function validateImport(data) {
  if (!data || typeof data !== "object") return null;
  return {
    globalEnabled: !!data.globalEnabled,
    allowedSites: Array.isArray(data.allowedSites)
      ? [...new Set(data.allowedSites.filter((d) => typeof d === "string" && d.length < 300))]
      : [],
    showFloatingBar: data.showFloatingBar !== false,
    shiftWheel: data.shiftWheel !== false
  };
}
