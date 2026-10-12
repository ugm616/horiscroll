/* ============================================================
 * Ox Alpha — Options Page
 * allowedSites = per-site allowlist used when Global mode is OFF.
 * Speaks the real background API: GET_STATE, ADD_SITE,
 * REMOVE_SITE, SET_SETTING.
 * ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const siteInput = $("siteInput");
  const addForm = $("addForm");
  const siteList = $("siteList");
  const countEl = $("count");
  const emptyEl = $("empty");
  const errEl = $("err");
  const statusEl = $("status");
  const shiftWheel = $("shiftWheel");
  const showBar = $("showBar");
  const saveBehavior = $("saveBehavior");

  let settings = null;

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
    statusEl.textContent = msg;
    statusEl.className = `status ${ok ? "ok" : "err"}`;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { statusEl.textContent = ""; }, 2200);
  }

  // ---------- Validate domain input ----------
  // Background stores full hostnames (extractDomain keeps www),
  // and matches subdomains via endsWith("." + d) — so a plain
  // "example.com" here covers www.example.com automatically.
  function normalizeHost(raw) {
    const s = raw.trim().toLowerCase();
    if (!s) return "";
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return "";
    return s;
  }

  // ---------- Render ----------
  function render() {
    siteList.textContent = "";
    const sites = settings.allowedSites || [];

    countEl.textContent = sites.length ? `(${sites.length})` : "";
    emptyEl.style.display = sites.length ? "none" : "block";

    for (const site of sites) {
      const li = document.createElement("li");
      li.className = "site-item";

      const name = document.createElement("span");
      name.className = "site-name";
      name.textContent = site;

      const open = document.createElement("button");
      open.className = "icon-btn";
      open.title = `Open ${site}`;
      open.textContent = "↗";
      open.addEventListener("click", () =>
        chrome.tabs.create({ url: `https://${site}` })
      );

      const del = document.createElement("button");
      del.className = "icon-btn danger";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Remove ${site}`);
      del.addEventListener("click", async () => {
        // REMOVE_SITE takes the exact stored domain string
        await send({ type: "REMOVE_SITE", domain: site });
        settings = await send({ type: "GET_STATE" }) || settings;
        render();
        flash(`Removed ${site}`);
      });

      li.append(name, open, del);
      siteList.appendChild(li);
    }
  }

  // ---------- Load ----------
  async function load() {
    const res = await send({ type: "GET_STATE" });
    settings = res?.settings ||
      { globalEnabled: false, allowedSites: [], showFloatingBar: true, shiftWheel: true };

    shiftWheel.checked = settings.shiftWheel !== false;
    showBar.checked = settings.showFloatingBar !== false;
    render();
  }

    // ---------- Events ----------
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";

    const host = normalizeHost(siteInput.value);
    if (!host) {
      errEl.textContent = "Enter a valid domain, e.g. example.com";
      return;
    }
    if ((izes to full hostname (keeps www),
    // so "example.com" may be stored as "www.example.com" — re-fetch.
    const res = await send({ type: "ADD_SITE", domain: host });
    if (res?.ok) {
      settings = await send({ type: "GET_STATE" }) || settings;
      settings = settings.settings || settings;
      siteInput.value = "";
      render();
      flash(`Added ${host} ✓`);
    } else {
      errEl.textContent = res?.error || "Could not add site.";
    }
  });

  saveBehavior.addEventListener("click", async () => {
    // SET_SETTING is per-key — no stale-blob overwrites.
    await send({ type: "SET_SETTING", key: "shiftWheel", value: shiftWheel.checked });
    await send({ type: "SET_SETTING", key: "showFloatingBar", value: showBar.checked });
    flash("Behavior saved ✓");
  });

  load();
})();
