/**
 * FeedCleaner — feed filter.
 *
 * Hides (or replaces with a placeholder) feed/search/sidebar/channel cards
 * for two reasons:
 *   "watched" — the video's ID is in the watched set (Watch Filter)
 *   "repeat"  — the card has already been sighted in the feed at least
 *               repeatThreshold times before (Repeat Video Fixer)
 *
 * Sighting = the card was >= 50% visible in the viewport, counted at most
 * once per video per SPA navigation (IntersectionObserver). Hide decisions
 * use a SNAPSHOT of sighting counts taken at navigation time — otherwise a
 * card would disappear the moment you scroll past it, because its own
 * sighting increments the live count. The snapshot only syncs downward
 * (Reset/Clear) mid-page so un-hiding still works immediately.
 *
 * Runs off a MutationObserver; DOM work is coalesced into
 * requestIdleCallback passes so the main thread is never blocked.
 */

"use strict";

(() => {
  const { store, CARD_SELECTOR, SHELF_SELECTOR, extractCardInfo, extractVideoId } = YTWash;

  const HOST_CLASS = "ytwash-placeholder-host";
  const PLACEHOLDER_CLASS = "ytwash-placeholder";

  // Categorical hides (channel/keyword/duration/mix/live/premiere/shorts)
  // the user overrode with "Show anyway" — page-session only, no storage.
  const sessionReveals = new Set();

  // History is an intentional archive, not a recommendation surface. Keep
  // every card visible there and do not let browsing it affect repeat counts.
  // YouTube keeps the same document while navigating, so this must be checked
  // at execution time rather than only when the content script starts.
  function isHistoryPage() {
    return location.pathname === "/feed/history";
  }

  /* --------------------------- card show/hide --------------------------- */

  function buildPlaceholder(videoId, reason, label) {
    const box = document.createElement("div");
    box.className = PLACEHOLDER_CLASS;

    if (store.settings.showLabel) {
      const labelEl = document.createElement("span");
      labelEl.className = "ytwash-placeholder-label";
      labelEl.textContent = label;
      box.appendChild(labelEl);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ytwash-unwatch";
    button.textContent = reason === "watched" ? "Unwatch" : "Show anyway";
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (reason === "watched" || reason === "repeat") {
        const type = reason === "watched" ? "UNWATCH" : "RESET_SEEN";
        browser.runtime.sendMessage({ type, videoId }).catch(() => {});
        // storage.onChanged → store.refresh() → re-filter restores the card.
      } else {
        // Rule-based hide: reveal for this page session only.
        sessionReveals.add(videoId);
        schedulePass();
      }
    });
    box.appendChild(button);

    return box;
  }

  /** @returns {boolean} true if the card transitioned from visible to hidden */
  function hideCard(card, videoId, reason, label) {
    // Rule-based hides can lack a video ID (nothing to key a placeholder
    // button on) — hard-hide those regardless of placeholder mode.
    const mode = store.settings.placeholderMode && videoId ? "placeholder" : "hard";
    if (
      card.dataset.ytwashState === mode &&
      card.dataset.ytwashId === (videoId || "") &&
      card.dataset.ytwashReason === reason &&
      card.dataset.ytwashLabel === label
    ) {
      return false;
    }

    const wasVisible = !card.dataset.ytwashState;
    showCard(card); // reset any previous mode before applying the new one

    if (mode === "hard") {
      card.style.setProperty("display", "none", "important");
    } else {
      // CSS rule on HOST_CLASS hides every child except our placeholder.
      card.classList.add(HOST_CLASS);
      card.appendChild(buildPlaceholder(videoId, reason, label));
    }
    card.dataset.ytwashState = mode;
    card.dataset.ytwashId = videoId || "";
    card.dataset.ytwashReason = reason;
    card.dataset.ytwashLabel = label;
    return wasVisible;
  }

  function showCard(card) {
    if (!card.dataset.ytwashState) return;
    card.style.removeProperty("display");
    card.classList.remove(HOST_CLASS);
    card.querySelector(`:scope > .${PLACEHOLDER_CLASS}`)?.remove();
    delete card.dataset.ytwashState;
    delete card.dataset.ytwashId;
    delete card.dataset.ytwashReason;
    delete card.dataset.ytwashLabel;
  }

  /* ------------------------ rule matcher compilation --------------------- */

  // Compiled once per settings change, read on every card decision.
  let channelMatchers = []; // lowercase, leading @ stripped
  let keywordMatchers = []; // { re } or { sub } (lowercase substring)

  function compileMatchers() {
    const s = store.settings;
    channelMatchers = (s.blockedChannels || []).map((c) =>
      c.trim().toLowerCase().replace(/^@/, "")
    );
    keywordMatchers = [];
    for (const raw of s.keywordFilters || []) {
      const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
      if (m) {
        try {
          keywordMatchers.push({ re: new RegExp(m[1], m[2]) });
        } catch {
          // Invalid regex: flagged in the settings UI, skipped here.
        }
      } else {
        keywordMatchers.push({ sub: raw.toLowerCase() });
      }
    }
  }

  function matchedChannel(info) {
    if (channelMatchers.length === 0) return false;
    const handle = info.channelHandle ? info.channelHandle.replace(/^@/, "") : null;
    const name = info.channelName ? info.channelName.trim().toLowerCase() : null;
    return channelMatchers.some((entry) => entry === handle || entry === name);
  }

  function matchedKeyword(title) {
    if (!title || keywordMatchers.length === 0) return false;
    const lower = title.toLowerCase();
    return keywordMatchers.some((m) => (m.re ? m.re.test(title) : lower.includes(m.sub)));
  }

  /**
   * Why hide this card, or null to show it. Precedence: watched > repeat >
   * channel > keyword > duration > mix > live > premiere > shorts.
   * Unknown metadata never hides (e.g. no duration badge ≠ "too short").
   */
  function decideCard(info, s) {
    const id = info.videoId;
    if (id && sessionReveals.has(id)) return null;

    if (id && s.watchFilterEnabled && store.watched.has(id)) {
      return { reason: "watched", label: "Already watched" };
    }
    if (id && s.repeatEnabled) {
      const seenCount = seenSnapshot.get(id) ?? 0;
      if (seenCount >= s.repeatThreshold) {
        return {
          reason: "repeat",
          label: `Seen ${seenCount} time${seenCount === 1 ? "" : "s"} already`,
        };
      }
    }
    if (matchedChannel(info)) {
      return {
        reason: "channel",
        label: info.channelName ? `Blocked channel: ${info.channelName}` : "Blocked channel",
      };
    }
    if (matchedKeyword(info.title)) {
      return { reason: "keyword", label: "Hidden by title filter" };
    }
    if (
      s.minDurationSec > 0 &&
      info.durationSec !== null &&
      info.durationSec < s.minDurationSec &&
      !info.isLive
    ) {
      return { reason: "duration", label: "Shorter than your minimum" };
    }
    if (s.hideMixes && info.isMix) return { reason: "mix", label: "Mix hidden" };
    if (s.hideLive && info.isLive) return { reason: "live", label: "Live stream hidden" };
    if (s.hidePremieres && info.isUpcoming) {
      return { reason: "premiere", label: "Premiere hidden" };
    }
    if (s.hideShorts && info.isShort) return { reason: "shorts", label: "Short hidden" };
    return null;
  }

  /* ----------------------- repeat-sighting tracking ---------------------- */

  // Counts as of the last navigation; hide decisions read this, never the
  // live store.seen (see header comment).
  let seenSnapshot = new Map();

  // IDs already counted since the last navigation.
  let countedThisNav = new Set();

  const sightingQueue = new Set();
  let flushTimer = null;

  function flushSightings() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (sightingQueue.size === 0) return;
    const ids = [...sightingQueue];
    sightingQueue.clear();
    browser.runtime.sendMessage({ type: "SEEN_BATCH", ids }).catch(() => {});
  }

  function queueSighting(videoId) {
    sightingQueue.add(videoId);
    if (!flushTimer) flushTimer = setTimeout(flushSightings, 2000);
  }

  const sightingObserver = new IntersectionObserver(
    (entries) => {
      if (isHistoryPage()) return;
      const s = store.settings;
      if (!s.masterEnabled || !s.repeatEnabled) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // "Seen" = half the card is on screen — OR the card covers half
        // the viewport. The second clause matters for cards taller than
        // the viewport (high zoom, small windows), whose intersection
        // ratio can never reach 0.5.
        const rootHeight = entry.rootBounds?.height || window.innerHeight;
        if (entry.intersectionRatio < 0.5 && entry.intersectionRect.height < rootHeight * 0.5) {
          continue;
        }
        const card = entry.target;
        if (card.dataset.ytwashState) continue; // hidden by us ≠ "seen"
        const videoId = extractVideoId(card);
        if (videoId && !countedThisNav.has(videoId)) {
          countedThisNav.add(videoId);
          queueSighting(videoId);
        }
      }
    },
    // Low thresholds exist so oversized cards still produce callbacks the
    // viewport-coverage clause above can accept.
    { threshold: [0.05, 0.25, 0.5] }
  );

  let observedCards = new WeakSet();

  /* ----------------------------- filter pass ---------------------------- */

  function runFilterPass() {
    if (isHistoryPage()) {
      // Restore only elements we changed instead of scanning every History
      // card. This is normally O(0), or O(h) after an SPA transition where h
      // is the number of cards/shelves previously hidden by this extension.
      for (const element of document.querySelectorAll("[data-ytwash-state]")) {
        showCard(element);
      }
      return;
    }

    const s = store.settings;
    const cards = document.querySelectorAll(CARD_SELECTOR);
    let newlyHidden = 0;

    for (const card of cards) {
      if (!observedCards.has(card)) {
        sightingObserver.observe(card);
        observedCards.add(card);
      }

      if (!s.masterEnabled) {
        showCard(card);
        continue;
      }

      // decideCard checks each module's own toggle internally.
      const info = extractCardInfo(card);
      const decision = decideCard(info, s);
      if (decision) {
        if (hideCard(card, info.videoId, decision.reason, decision.label)) {
          newlyHidden++;
        }
      } else {
        // Covers unwatched cards, recycled cards whose href changed, and
        // cards we hid before an Unwatch / Show anyway / settings change.
        showCard(card);
      }
    }

    // Shorts shelves are containers, not per-video cards: always hard-hide,
    // count as one hide each.
    for (const shelf of document.querySelectorAll(SHELF_SELECTOR)) {
      if (s.masterEnabled && s.hideShorts) {
        if (hideCard(shelf, null, "shorts-shelf", "Shorts shelf hidden")) newlyHidden++;
      } else {
        showCard(shelf);
      }
    }

    if (newlyHidden > 0) {
      browser.runtime.sendMessage({ type: "CARDS_HIDDEN", count: newlyHidden }).catch(() => {});
    }
  }

  /* ------------------------ scheduling / observers ---------------------- */

  // Coalesce bursts of mutations into one idle-time pass. YouTube feeds
  // mutate constantly; the observer callback itself only sets a flag.
  let passScheduled = false;
  function schedulePass() {
    if (passScheduled) return;
    passScheduled = true;
    const run = () => {
      passScheduled = false;
      runFilterPass();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 50);
    }
  }

  store.ready().then(() => {
    seenSnapshot = new Map(store.seen);
    compileMatchers();
    schedulePass(); // initial scan (idle-scheduled per performance budget)

    new MutationObserver(schedulePass).observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Re-filter when the watched set, seen counts, or settings change.
    // Mid-page, the snapshot only syncs DECREASES (Reset / Clear All) so
    // fresh sightings never hide a card the user is currently looking at —
    // and a pure-increase update therefore can't change any decision, so
    // it doesn't even earn a re-filter pass (they arrive every ~2s while
    // scrolling in any tab).
    store.onChange((info) => {
      if (!info || info.settingsChanged) compileMatchers();
      let decreased = false;
      for (const [id, count] of seenSnapshot) {
        const live = store.seen.get(id) ?? 0;
        if (live < count) {
          seenSnapshot.set(id, live);
          decreased = true;
        }
      }
      const seenOnly =
        info && info.seenChanged && !info.settingsChanged && !info.watchedChanged;
      if (seenOnly && !decreased) return;
      schedulePass();
    });

    window.addEventListener("yt-navigate-finish", () => {
      flushSightings(); // fire-and-forget; the write may land after us…
      // …so build the new snapshot optimistically: everything counted on
      // the page we're leaving has at least its prior count + 1 by now.
      const next = new Map(store.seen);
      for (const id of countedThisNav) {
        next.set(id, Math.max(next.get(id) ?? 0, (seenSnapshot.get(id) ?? 0) + 1));
      }
      seenSnapshot = next;
      countedThisNav = new Set();
      // Re-observe from scratch: a card YouTube recycles in place while it
      // stays visible emits no new intersection transition, so force fresh
      // initial entries for every card on the new page.
      sightingObserver.disconnect();
      observedCards = new WeakSet();
      schedulePass();
    });

    window.addEventListener("pagehide", flushSightings);
  });
})();
