/**
 * Feature #2 tests: the "Are you still watching?" auto-dismisser, driven
 * against the REAL content/still-watching.js module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFeedEnvironment, FakeElement } from "./helpers.mjs";

/** Build a YouTube-shaped confirm dialog inside a popup container. */
function buildDialog({ host = "yt-confirm-dialog-renderer", withButton = true } = {}) {
  const container = new FakeElement("ytd-popup-container");
  const dialog = new FakeElement(host);
  container.appendChild(dialog);
  if (withButton) {
    const buttonRenderer = new FakeElement("yt-button-renderer");
    buttonRenderer.setAttribute("id", "confirm-button");
    const inner = new FakeElement("button");
    inner.setAttribute("id", "inner-btn"); // marker to assert THIS was clicked
    let clicked = 0;
    // FakeElement has no .click(); emulate DOM activation semantics.
    inner.click = function () {
      clicked++;
    };
    inner.getClickCount = () => clicked;
    buttonRenderer.appendChild(inner);
    dialog.appendChild(buttonRenderer);
    return { container, dialog, buttonRenderer, confirmButton: inner };
  }
  return { container, dialog };
}

function firePopupOpened(document, nodeName) {
  const listeners = document._listeners["yt-popup-opened"] || [];
  for (const fn of listeners) fn({ detail: { nodeName } });
}

test("feature OFF (default): yt-popup-opened for the dialog does nothing", async () => {
  const env = loadFeedEnvironment({
    settings: { stillWatchingEnabled: false },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const { container, confirmButton } = buildDialog();
  env.document.body.appendChild(container);
  await new Promise((r) => setTimeout(r, 0));

  firePopupOpened(env.document, "YT-CONFIRM-DIALOG-RENDERER");
  assert.equal(confirmButton.getClickCount(), 0);
});

test("feature ON: event path clicks #confirm-button on YouTube dialogs", async () => {
  const env = loadFeedEnvironment({
    settings: { stillWatchingEnabled: true },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const { container, confirmButton } = buildDialog();
  env.document.body.appendChild(container);
  // Let store.ready().then(...) wire things up.
  await new Promise((r) => setTimeout(r, 0));

  firePopupOpened(env.document, "YT-CONFIRM-DIALOG-RENDERER");
  assert.equal(confirmButton.getClickCount(), 1);
});

test("feature ON: also answers YouTube Music's you-there renderer", async () => {
  const env = loadFeedEnvironment({
    settings: { stillWatchingEnabled: true },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const { container, confirmButton } = buildDialog({ host: "ytmusic-you-there-renderer" });
  env.document.body.appendChild(container);
  await new Promise((r) => setTimeout(r, 0));

  firePopupOpened(env.document, "YTMUSIC-YOU-THERE-RENDERER");
  assert.equal(confirmButton.getClickCount(), 1);
});

test("unrelated popups are never dismissed", async () => {
  const env = loadFeedEnvironment({
    settings: { stillWatchingEnabled: true },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const { container, confirmButton } = buildDialog();
  env.document.body.appendChild(container);
  await new Promise((r) => setTimeout(r, 0));

  // Share sheet, menus, etc. — different renderers entirely.
  firePopupOpened(env.document, "YT-SHARE-SHEET-RENDERER");
  firePopupOpened(env.document, "YTD-MENU-RENDERER");
  assert.equal(confirmButton.getClickCount(), 0);
});

test("master switch off disables dismissal even when the feature is on", async () => {
  const env = loadFeedEnvironment({
    settings: { masterEnabled: false, stillWatchingEnabled: true },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const { container, confirmButton } = buildDialog();
  env.document.body.appendChild(container);
  await new Promise((r) => setTimeout(r, 0));

  firePopupOpened(env.document, "YT-CONFIRM-DIALOG-RENDERER");
  assert.equal(confirmButton.getClickCount(), 0);
});

test("dialog without #confirm-button is left alone (selector-drift safety)", async () => {
  const env = loadFeedEnvironment({
    settings: { stillWatchingEnabled: true },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const { container, dialog } = buildDialog({ withButton: false });
  env.document.body.appendChild(container);
  await new Promise((r) => setTimeout(r, 0));

  // Must not throw.
  firePopupOpened(env.document, "YT-CONFIRM-DIALOG-RENDERER");
  assert.equal(dialog.children.length, 0);
});
