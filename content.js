/* ============================================================
 * Ox Alpha Scroll — Content ScriptManifest V3)
 * Universal Horizontal Scroll Extension for Chrome & Edge
 *
 * - Stays idle unless the current site is enabled.
 * - Detects horizontally scrollable containers.
 * - Exposes overflow hidden overflow-x: auto !important.
 * - Shift + Mouse Wheel → horizontal scrolling (only when Shift held).
 * - Floating scrollbar synced with active/hovered container.
 * - Highlight tool for debugging (autos after 10s).
 * - MutationObserver with debounce for dynamic SPA content.
 * - Defensive: never throws visible errors on webpages.
 * ============================================================ */
(() => {
  "use strict";

  const DEBUG = false;
 const log = (...a) => { if (DEBUG) console.log("[OxAlpha]", ...a); };

  // Guard against duplicate injection (chrome.scripting can re-inject)
  if (window.__oxAlphaLoaded) return;
  window.__oxAlphaLoaded = true;

  // ---------------- State ----------------
  const DEFAULT_SETTINGS = {
    globalEnabled: false,
    allowedSites: [],
    showFloatingBar: true,
    shiftWheel: true
  };

  let settings = { ...DEFAULT_SETTINGS };
  let siteEnabled = false;
  let active = false;

  let candidates = [];            // ranked scroll container elements
  let currentTarget = null;       // container the floating bar follows
  let floatingBar = null;         // root UI element
  let floating = null;

  let mutationObserver = null;
  let rescanTimer null;
  let syncRAF = 0;
  const syncedListeners = new WeakSet();
  const trackedTargets = new WeakSet();

  const RESCAN_DEBOUNCE_MS = 300;
  const HIGHLIGHT_DURATION_MS = 10000;
  const MIN_CONTAINER_WIDTH = 60;
  const MIN_OVERFLOW = 8;

  // ---------------- Utilities ----------------
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function throttle(fn, ms) {
    let last = 0, t = null, lastArgs = null;
    return function (...args) {
      const now = Date.now();
      lastArgs = args;
      if (now - last >= ms) {
        last = now;
        fn.apply(this, args);
      } else if (!t) {
        t = setTimeout(() => {
          t = null;
          last = Date.now();
          fn.apply(this, lastArgs);
        }, ms - (now - last));
      }
    };
  }

  function safe(fn) {
    try { return fn(); } catch (e) { log("safe caught:", e); return undefined; }
  }

  function isElementInShadow(el) {
    // Walk up through shadow roots — we support shadow DOM via composed queries
    return el.getRootNode && el.getRootNode() !== document;
  }

  // Deep querySelectorAll that pierces open shadow roots
  function deepQueryAll(root) {
    const out = [];
    try {
      const walk = (node) => {
        if (!node) return;
        if (node.querySelectorAll) {
          for (const el of node.querySelectorAll("*")) {
            out.push(el);
            if (el.shadowRoot) walk(el.shadowRoot          }
        }
      };
      walk(root);
    } catch (e) {
      log("deepQueryAll error", e);
    }
    return out;
  }

  // ---------------- Detection ----------------
  isScrollCandidate(el) {
    try {
      if (!(el instanceof Element)) return false;
      if (el === document.documentElement || el === document.body) return false;
      if (el === floatingBar || floatingBar?.contains(el)) return false;

      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;

      const ox = cs.overflowX;
      if (ox !== "auto" && ox !== "scroll" && ox !== "hidden" && ox !== "clip") return false;

      if (el.scrollWidth <= el.clientWidth + MIN_OVERFLOW) return false;
      if (el.clientWidth < MIN_CONTAINER_WIDTH || el.clientHeight < 12) return false;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      return true;
    } catch {
      return false;
    }
  }

  function scanScrollables() {
    return safe(() => {
      const found = [];

      // Main document
      for (const el of deepQueryAll(document)) {
        if (isScrollCandidate(el)) {
          found.push({ el, overflow: el.scrollWidth - el.clientWidth });
        }
      }

      // Same-origin iframes (best effort)
      try {
        for (const frame of document.querySelectorAll("iframe")) {
          let doc = null;
          try { doc = frame.contentDocument; } catch { /* cross-origin */ }
          if (doc) {
            for (const el of deepQueryAll(doc)) {
              if (isScrollCandidate(el)) {
                found.push({ el, overflow: el.scrollWidth - el.clientWidth });
              }
            }
          }
        }
      } catch { /* ignore */ }

      // Rank by overflow amount (largest first)
      found.sort((a, b) => b.overflow - a.overflow);
      candidates found.map((f) => f.el);

      // Expose hidden overflow + attach scroll sync
      for (const el of candidates) {
        const cs = getComputedStyle(el);
        if (cs.overflow === "hidden" || cs.overflowX === "clip") {
          el.style.setProperty("overflow-x", "auto", "important");
        }
        if (!syncedListeners.has(el)) {
          syncedListeners.add(el);
          el.addEventListener("scroll", throttledSyncFromTarget, { passive: true });
        }
      }

      if (!currentTarget || !candidates.includes(currentTarget)) {
        currentTarget = pickBestTarget();
      }
      log("scanScrollables:", candidates.length, "candidates");
      updateFloatingBar();
    });
  }

  function pickBestTarget() {
    if (!candidates.length) return null;
    const vh = window.innerHeight;
    let best = null, bestScore = -1;
    for (const el of candidates) {
      const rect = safe(() => el.getBoundingClientRect());
      if (!rect) continue;
      if (rect.width < 100 || rect.bottom < 0 || rect.top > vh) continue;
      // Score: prefers wide, on-screen containers with big overflow
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const overflow = el.scrollWidth - el.clientWidth;
      const score = visibleWidth + overflow * 0.5;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best || candidates[0] || null;
  }

  // ---------------- Force scrolling ----------------
  function exposeHiddenOverflow() {
 safe(() => {
      for (const el of candidates) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === "hidden" || cs.overflowX === "clip") {
          el.style.setProperty("overflow-x", "auto", "important");
        }
      }
    });
  }

  // ---------------- Shift + Wheel ----------------
  function installWheelHandler() {
    // Capture phase so we behave consistently even inside nested scroll areas
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  }

  function onWheel(e) {
    if (!active || !settings.shiftWheel) return;
    if (!e.shiftKey) return;               // Normal scrolling untouched
    if (e.deltaX !== 0) return;            // Device already scrolls horizontally

    const target = findNearestScrollable(e.target) || currentTarget || pickBestTarget();
    if (!target) return;

    safe(() => {
      e.preventDefault();                  // ONLY when Shift is held
      const before = target.scrollLeft;
      target.scrollLeft = clamp(before + e.deltaY, 0, target.scrollWidth - target.clientWidth);
      if (target.scrollLeft !== before) {
        log("Shift+Wheel:", before, "→", target.scrollLeft);
        if (target === currentTarget) scheduleSyncUI();
      }
    });
  }

  function findNearestScrollable(startEl) {
    let el = startEl instanceof Element ? startEl : null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollCandidate(el)) return el;
      // Cross shadow boundaries upward
      el = elNode?.().host || el.parentElement || null;
    }
    return null;
  }

  // ---------------- Hover tracking (active container follows cursor) ----------------
  function installHoverTracker() {
    document.addEventListener("mousemove", throttled(onMouseMove, 120), { passive: true, capture: true });
  }

  function onMouseMove(e) {
    if (!active) return;
    const el = findNearestScrollable(e.target);
    if (el && el !== currentTarget) {
      currentTarget = el;
      log("Active target (hover):", el.tagName, el.className);
      scheduleSyncUI();
    }
  }

  // ---------------- Floating Scrollbar ----------------
  function installFloatingBar() {
    safe(() => {
      if (floatingBar) return;
      floatingBar = document.createElement("div");
      floatingBar.className = "oxalpha-hscrollbar";
      floatingBar.setAttribute("role", "scrollbar");
      floatingBar.setAttribute("aria-orientation", "horizontal");
      floatingBar.setAttribute("aria-label", "Horizontal scroll control");

      floatingThumb = document.createElement("div");
      floatingThumb.className = "oxalpha-hscrollbar-thumb";
      floatingThumb.setAttribute("role", "presentation");
      floatingBar.appendChild(floatingThumb);
      document.documentElement.appendChild(floatingBar);

      // Thumb drag
      let dragging = false;
      let dragStartX = 0, dragStartScroll = 0;

      floatingThumb.addEventListener("pointerdown", (e) => {
        if (!currentTarget) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartScroll = currentTarget.scrollLeft;
        floatingThumb.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      floatingThumb.addEventListener("pointermove", (e) => {
        if (!dragging || !currentTarget) return;
        const track = floatingBar.getBoundingClientRect();
        const maxScroll = currentTarget.scrollWidth - currentTarget.clientWidth;
        const scrollableTrack = track.width - thumbWidth();
        if (scrollableTrack <= 0) return;
        currentTarget.scrollLeft = clamp(
          dragStartScroll + ((e.clientX - dragStartX) / scrollableTrack) * maxScroll,
          0, maxScroll
        );
        scheduleSyncUI();
      });
      const endDrag = () => { dragging = false; };
      floatingThumb.addEventListener("pointerup", endDrag);
      floatingThumb.addEventListener("pointercancel", endDrag);

      // Track click → page jump
      floatingBar.addEventListener("pointerdown", (e) => {
        if (e.target === floatingThumb || !currentTarget) return;
        const track = floatingBar.getBoundingClientRect();
        const maxScroll = currentTarget.scrollWidth - currentTarget.clientWidth;
        const ratio = clamp((e.clientX - track.left) / track.width, 0, 1);
        currentTarget.scrollLeft = ratio * maxScroll;
        scheduleSyncUI();
      });

      // Keyboard support
      floatingThumb.tabIndex = 0;
      floatingThumb.addEventListener("keydown", (e) => {
        if (!currentTarget) return;
        const step = currentTarget.clientWidth * 0.1;
        if (e.key === "ArrowRight") { currentTarget.scrollLeft += step; e.preventDefault(); }
        else if (e.key === "ArrowLeft") { currentTarget.scrollLeft -= step; e.preventDefault(); }
        else if (e.key === "Home") { currentTarget.scrollLeft = 0; e.preventDefault(); }
        else if (e.key === "End") { currentTarget.scrollLeft = currentTargetWidth; e.preventDefault(); }
        scheduleSyncUI();
      });

      scheduleSyncUI();
    });
  }

  function removeFloatingBar() {
    safe(() => {
      floatingBar?.remove();
      floating = null;
      floatingThumb = null;
    });
  }

  function thumbWidth() {
    if (!currentTarget || !floatingBar) return 40;
    const ratio = currentTarget.clientWidth / currentTarget.scrollWidth;
    return clamp(floatingBar.clientWidth * ratio, 30, floatingBar.clientWidth);
  }

  function scheduleSyncUI() {
    if (syncRAF) return;
    syncRAF = requestAnimationFrame(syncUI);
  }

  function syncUI() {
    syncRAF = 0;
    safe(() => {
      if (!floatingBar || !floatingThumb) return;

      const target = currentTarget;
      if (!target || !document.contains(target)) {
        // Target vanished (virtualized DOM) — re-pick
        currentTarget = pickBestTarget();
        if (!currentTarget) { floatingBar.classList.remove("visible"); return; }
        return;
      }

      const maxScroll = target.scrollWidth - target.clientWidth;
      if (maxScroll <= MIN_OVERFLOW) {
        floatingBar.classList.remove("visible");
        return;
      }

      floatingBar.classList.add("visible");

      // Size thumb proportionally
      const tw = thumbWidth();
      floatingThumb.style.width = tw + "px";

      // Position thumb
 const ratio = clamp(target.scrollLeft / maxScroll, 0, 1);
      const trackWidth = floatingBar.clientWidth;
      floatingThumb.style.left = (ratio * (trackWidth - tw)) + "px";

      // Accessibility attributes
      floatingBar.setAttribute("aria-valuenow", String(Math.round(target.scrollLeft)));
      floatingBar.setAttribute("aria-valuemin", "0");
      floatingBar.setAttribute("aria-valuemax", String(maxScroll));
    });
  }

  const throttledSyncFromTarget = throttle(() => {
    if (DEBUG) log("Sync from target scroll");
    scheduleSyncUI();
  }, 16);

  // Sync when the page (window) scrolls horizontally too
  window.addEventListener("scroll", throttledSyncFromTarget, { passive: true });

  // ---------------- Highlight Tool ----------------
  function highlightScrollables() {
    safe(() => {
      clearHighlights();
      scanScrollables();
      let count = 0;

      for (const el of candidates) {
        if (!(el instanceof Element) || !document.contains(el)) continue;
        el.classList.add("oxalpha-highlight");
        highlightTimer && clearTimeout(highlightTimer);
      }
      count = candidates.length;

      // Banner showing result count
      const banner = document.createElement("div");
      banner.className = "oxalpha-highlight-banner";
      banner.textContent = `Ox Alpha: ${count} horizontal scroll area 1 ? "" : "s"} detected`;
      document.documentElement.appendChild(banner);

      highlightTimer = setTimeout(() => {
        clearHighlights();
        banner.remove();
      }, HIGHLIGHT_DURATION_MS);

      log("Highlighted", count, "areas");
    });
  }

  function clearHighlights() {
    safe(() => {
      for (const el of candidates) {
        try { el.classList.remove("oxalpha-highlight"); } catch { /* detached */ }
      }
      document.querySelectorAll(".oxalpha-highlight-banner").forEach((b) => b.remove());
    });
  }

  // ---------------- MutationObserver (SPA / dynamic content) ----------------
  function installObserver() {
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver(() => throttledRescan());
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
  }

  const throttledRescan = throttle(() => {
    if (!active) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      safe(() => {
        scanScrollables();
        exposeHiddenOverflow();
      });
    }, RESCAN_DEBOUNCE_MS);
  }, 150);

  function rescan() {
    safe
      scanScrollables();
      exposeHiddenOverflow();
      if (settings.showFloatingBar && !floatingBar) installFloatingBar();
      scheduleSyncUI();
    });
  }

  // ---------------- Page lifecycle ----------------
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && active) {
      safe(() => {
        // Containers may have changed while tab was hidden
        rescan();
      });
    }
  });

  window.addEventListener("pagehide", () => {
    safe(() => {
      if (mutationObserver) mutationObserver.disconnect();
      removeFloatingBar();
    });
  });

  // ---------------- Boot ----------------
  init();

  // Expose a tiny debug handle (harmless, useful for support)
  window.__oxAlphaDebug = {
    get state() {
      return {
        active,
        siteEnabled,
        settings,
        candidateCount: candidates.length,
        currentTarget: currentTarget ? `currentTarget.tagName.{currentTarget.tagName}.currentTarget.tagName.{currentTarget.className}` : null
      };
    },
    highlight: highlightScrollables,
    rescan
  };
})();