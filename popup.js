/* ============================================================
 * Ox Alpha — Popup
 * globalEnabled = "allow everywhere" mode (per background logic).
 * allowedSites  = allowlist consulted only when global is OFF.
 * ADD_SITE implicitly switches to per-site mode.
 * ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const globalToggle = $("globalToggle");
  const siteToggle = $("siteToggle");
  const shiftWheelToggle = $("shiftWheelToggle");
  const barToggle = $("barToggle");
  const highlightBtn = $("highlightBtn");
  const optionsBtn = $("optionsBtn");
  const siteHost = $("siteHost");
  const siteNote = $("siteNote");
  const status = $("status");

  let currentHost = "";
  let settings = null;
  let savingTimer = null;
  let suppressEvents = true; // don't fire save() during load()

  // ---------- Messaging ----------
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function flash(msg, ok = true) {
    status.textContent = msg;
    status.className = `status ${ok ? "ok" : "err"}`;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { status.textContent = ""; status.className = "status"; }, 2200);
  }

  // ---------- Load ----------
  async function load() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let host = "";
    try { host = new URL(tab.url || "").hostname; } catch { /* non-http page */ }
    currentHost = host;
    siteHost.textContent = host || "unsupported page";

    const res = await send({ type: "GET_STATE" });
    settings = res?.settings ||
      { globalEnabled: false, allowedSites: [], showFloatingBar: true, shiftWheel: true };

    globalToggle.checked = !!settings.globalEnabled;
    shiftWheelToggle.checked = settings.shiftWheel !== false;
    barToggle.checked = settings.showFloatingBar !== false;

    // Background's isSiteEnabled: global ON → everything enabled;
    // global OFF → host (or subdomain) must be in allowedSites.
    const enabledByRule = settings.globalEnabled ||
      (host && (settings.allowedSites || []).some(
        (d) => host === d || host.endsWith("." + d)
      ));

    siteToggle.checked = enabledByRule;
    siteToggle.disabled = !host;

    updateSiteNote(enabledByRule);
    reflectEnabledState();
    suppressEvents = false;

    // Content-script availability check (optional nicety)
    if (host && enabledByRule && tab?.id) {
      try {
        const pong = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
        if (pong?.ok) {
          flash(`pong.countscrollarea{pong.count} scroll areapong.countscrollarea{pong.count === 1 ? "" : "s"} detected`);
        }
      } catch { /* content script not injected on this page */ }
    }
  }

  function updateSiteNote(enabledByRule) {
    if (!currentHost) {
      siteNote.textContent = "This page type can't be controlled.";
    } else if (settings.globalEnabled) {
      siteNote.textContent = enabledByRule
        ? "Global mode: scrolling is on everywhere."
        : "Global mode is on.";
    } else {
      siteNote.textContent = enabledByRule
        ? "Scrolling is active here."
        : "Add this site to the allowlist to activate scrolling.";
    }
  }

  function reflectEnabledState() {
    document.body.classList.toggle("disabled", !settings.globalEnabled);
  }

  // ---------- Save (debounced, per-key API) ----------
  function save() {
    if (suppressEvents) return;
    clearTimeout(savingTimer);
    savingTimer = setTimeout(async () => {
      if (globalToggle.checked !== !!settings.globalEnabled) {
        await send({ type: "TOGGLE_GLOBAL", enabled: globalToggle.checked });
        settings.globalEnabled = globalToggle.checked;
 {
        behavior.showFloatingBar = barToggle.checked;
      }
      for (const [key, value] of Object.entries(behavior)) {
        await send({ type: "SET_SETTING", key, value });
        settings[key] = value;
      }

      // Site toggle maps to ADD_SITE / REMOVE_SITE.
      // ADD_SITE switches to per-site mode (globalEnabled:false) —
      // refresh state afterwards so the UI reflects that.
      if (currentHost) {
        const allowedNow = siteToggle.checked;
        const wasAllowed = (settings.allowedSites || []).some(
          (d) => currentHost === d || currentHost.endsWith("." + d)
        );
        if (allowedNow && !wasAllowed) {
          const r = await send({ type: "ADD_SITE", domain: currentHost });
          if (r?.ok) {
            const s = await send({ type: "GET_STATE" });
            if (s?.settings) settings = s.settings;
            updateSiteNote(true);
          }
        } else if (!allowedNow && wasAllowed) {
          // Remove the closest matching entry (exact or parent domain)
          const list = settings.allowedSites || [];
          const match = list.find((d) => currentHost === d || currentHost.endsWith("." + d));
          if (match) {
            await send({ type: "REMOVE_SITE", domain: match });
            settings.allowedSites = list.filter((d) => d !== match);
          }
        }
      }

      reflectEnabledState();
      flash("Saved ✓");
      // Background broadcasts SETTINGS_CHANGED to tabs on every mutation,
      // so no APPLY_TO_TAB needed here.
    }, 250);
  }

  // ---------- Events ----------
  for (const el of [globalToggle, siteToggle, shiftWheelToggle, barToggle]) {
    el.addEventListener("change", save);
  }

  highlightBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return flash("No active tab", false);
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT" });
      flash(res?.ok ? "Detection running…" : "Open a normal web page first", !!res?.ok);
    } catch {
      flash("Open a normal web page first", false);
    }
  });

  optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("helpLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  load();
})();