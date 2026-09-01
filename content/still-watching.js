/**
 * FeedCleaner — "Are you still watching?" auto-dismisser (opt-in).
 *
 * YouTube and YouTube Music park long/unattended playback behind a
 * confirmation dialog:
 *   YouTube:       <yt-confirm-dialog-renderer>  "Video paused. Continue watching?"
 *   YouTube Music: <ytmusic-you-there-renderer>  "Are you still there?"
 *
 * Mechanism (researched 2026-08 against YouTubeNonStop's implementation
 * and the live DOM):
 *   1. The page announces the dialog with a `yt-popup-opened` CustomEvent
 *      on `document`, whose detail.nodeName names the dialog renderer.
 *   2. Dialogs render into stable custom-element popup containers
 *      (ytd-popup-container / ytmusic-popup-container).
 *   3. The confirmation control carries the stable id #confirm-button.
 *
 * We answer "Yes" exactly as a user would — a single click routed through
 * YouTube's own button pipeline. Nothing is prevented preemptively and no
 * polling timers run; when the toggle is off this module stays inert.
 */

"use strict";

(() => {
  const { store } = YTWash;

  const DIALOG_EVENT_NODE_NAMES = new Set([
    "YT-CONFIRM-DIALOG-RENDERER",
    "YTMUSIC-YOU-THERE-RENDERER",
  ]);
  const DIALOG_SELECTOR = "yt-confirm-dialog-renderer, ytmusic-you-there-renderer";
  // The confirm control is a yt-button-renderer host; its actionable
  // <button> lives inside it. Prefer the inner button — synthetic .click()
  // on the host isn't always forwarded to YouTube's handlers.
  const CONFIRM_INNER_BUTTON_SELECTOR = "#confirm-button button";
  const CONFIRM_FALLBACK_SELECTOR = "#confirm-button";

  const POPUP_CONTAINER_SELECTOR = "ytd-popup-container, ytmusic-popup-container";

  function enabled() {
    return store.settings.masterEnabled && store.settings.stillWatchingEnabled;
  }

  /** Answer the dialog's confirm control, if the dialog is still mounted. */
  function dismissYouThereDialog() {
    const dialog = document.querySelector(DIALOG_SELECTOR);
    if (!dialog) return;
    const button =
      dialog.querySelector(CONFIRM_INNER_BUTTON_SELECTOR) ||
      dialog.querySelector(CONFIRM_FALLBACK_SELECTOR);
    if (!button) {
      // Selector drift — leave the dialog alone rather than clicking blind.
      console.warn("[FeedCleaner] still-watching dialog has no #confirm-button");
      return;
    }
    button.click();
  }

  // Primary path: YouTube announces the popup before its contents settle.
  document.addEventListener("yt-popup-opened", (e) => {
    if (!enabled()) return;
    const nodeName = e && e.detail && e.detail.nodeName;
    if (!nodeName || !DIALOG_EVENT_NODE_NAMES.has(String(nodeName).toUpperCase())) return;
    dismissYouThereDialog();
  });

  // Fallback path: watch the popup containers themselves so the feature
  // survives a rename of the announcement event or its detail shape.
  // Scoped to the containers (not document.body) — these dialogs can only
  // appear there, keeping the observer cheap.
  let checkScheduled = false;
  function scheduleDialogCheck() {
    if (checkScheduled || !enabled()) return;
    checkScheduled = true;
    const run = () => {
      checkScheduled = false;
      if (!enabled()) return;
      dismissYouThereDialog();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 50);
    }
  }

  store.ready().then(() => {
    const containers = document.querySelectorAll(POPUP_CONTAINER_SELECTOR);
    const targets = containers.length > 0 ? containers : [document.body];
    for (const target of targets) {
      new MutationObserver(scheduleDialogCheck).observe(target, { childList: true });
    }
  });
})();
