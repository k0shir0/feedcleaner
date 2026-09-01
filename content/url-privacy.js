/**
 * FeedCleaner — URL privacy: strips tracking params (si=, feature=, pp=, …)
 * from YouTube links the user copies or shares. Gated on
 * settings.masterEnabled && settings.stripLinks.
 *
 * Two interception points:
 *  1. Text copies anywhere on the page ('copy' event): YouTube URLs inside
 *     the copied selection are cleaned before they reach the clipboard.
 *  2. The share panel: the visible url input is rewritten as soon as it
 *     appears (cosmetic), and its Copy button is intercepted — YouTube's
 *     handler copies from its internal data model, not from the input, so
 *     we overwrite the clipboard with the cleaned URL right after
 *     (clipboardWrite permission keeps that write allowed once the click
 *     gesture has passed).
 *
 * Out of reach by design: the address bar, and copies made outside
 * youtube.com pages.
 */

"use strict";

(() => {
  const { store, cleanUrl } = YTWash;

  // Share dialog internals (verified live 2026-07): the copy-link renderer
  // holds a readonly input#share-url and a #copy-button button renderer.
  const SHARE_INPUT_SELECTOR = "yt-copy-link-renderer input#share-url";
  const SHARE_COPY_BUTTON_SELECTOR = "yt-copy-link-renderer #copy-button";

  const URL_RE = /https?:\/\/[^\s"'<>]+/g;

  function enabled() {
    return store.settings.masterEnabled && store.settings.stripLinks;
  }

  /** Clean every YouTube URL inside a text blob; null if nothing changed. */
  function cleanText(text) {
    let changed = false;
    const out = text.replace(URL_RE, (match) => {
      const cleaned = cleanUrl(match);
      if (cleaned) changed = true;
      return cleaned || match;
    });
    return changed ? out : null;
  }

  /* ------------------------- 1. selection copies ------------------------- */

  document.addEventListener(
    "copy",
    (e) => {
      if (!enabled() || !e.clipboardData) return;
      const selection = document.getSelection();
      const text = selection ? selection.toString() : "";
      const cleaned = text && cleanText(text);
      if (!cleaned) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", cleaned);
    },
    true
  );

  /* --------------------------- 2. share panel ---------------------------- */

  function cleanShareInput() {
    const input = document.querySelector(SHARE_INPUT_SELECTOR);
    if (!input || !input.value) return;
    const cleaned = cleanUrl(input.value);
    if (cleaned) input.value = cleaned;
  }

  // The dialog is created lazily and its input value is set via property
  // (no attribute mutation), so: coalesce body mutations into idle checks
  // for the panel's appearance, and re-clean when the user focuses the
  // input. The Copy interception below is the actual guarantee.
  let checkScheduled = false;
  function scheduleShareCheck() {
    if (checkScheduled || !enabled()) return;
    checkScheduled = true;
    const run = () => {
      checkScheduled = false;
      cleanShareInput();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 50);
    }
  }

  document.addEventListener("focusin", (e) => {
    if (enabled() && e.target instanceof Element && e.target.matches(SHARE_INPUT_SELECTOR)) {
      cleanShareInput();
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      if (!enabled() || !(e.target instanceof Element)) return;
      if (!e.target.closest(SHARE_COPY_BUTTON_SELECTOR)) return;
      const input = document.querySelector(SHARE_INPUT_SELECTOR);
      if (!input || !input.value) return;
      const url = cleanUrl(input.value) || input.value;
      // Let YouTube's own handler write its tracked URL first, then
      // replace it with the clean one.
      setTimeout(() => {
        navigator.clipboard.writeText(url).catch(() => {});
      }, 0);
    },
    true
  );

  store.ready().then(() => {
    new MutationObserver(scheduleShareCheck).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
})();
