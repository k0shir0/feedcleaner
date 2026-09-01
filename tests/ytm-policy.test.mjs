/**
 * YouTube Music host-policy tests.
 *
 * Policy (user directive): music.youtube.com gets PRIVACY FEATURES ONLY —
 * FeedCleaner must never hide video cards there and must never record watch
 * progress there. These tests pin that contract against the REAL modules:
 *
 *  - youtube-feed.js must be structurally inert on YTM (no test hook, no
 *    hiding, no sighting reports) even when a card matches EVERY hide rule;
 *  - the same card IS hidden on www.youtube.com (guards the rig against a
 *    vacuous pass);
 *  - still-watching.js (a privacy feature) stays fully active on YTM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFeedEnvironment, FakeElement, makeCard } from "./helpers.mjs";

const BLOCKABLE_SETTINGS = {
  watchFilterEnabled: true,
  repeatEnabled: true,
  keywordFilters: ["Some Video"],
};

/** A card that matches watched + repeat + keyword simultaneously. */
function blockableCard() {
  return makeCard({ id: "dQw4w9WgXcQ", title: "Some Video Title" });
}

function firePopupOpened(document, nodeName) {
  const listeners = document._listeners["yt-popup-opened"] || [];
  for (const fn of listeners) fn({ detail: { nodeName } });
}

test("policy flag: true on music.youtube.com, false on www.youtube.com", () => {
  const ytm = loadFeedEnvironment({ hostname: "music.youtube.com", loadFeedModule: false });
  const yt = loadFeedEnvironment({ hostname: "www.youtube.com", loadFeedModule: false });
  assert.equal(ytm.YTWash.IS_YOUTUBE_MUSIC, true);
  assert.equal(yt.YTWash.IS_YOUTUBE_MUSIC, false);
});

test("YTM: feed filtering never activates, even against a fully blockable card", async () => {
  const env = loadFeedEnvironment({
    hostname: "music.youtube.com",
    settings: BLOCKABLE_SETTINGS,
    watched: ["dQw4w9WgXcQ"],
    seen: { dQw4w9WgXcQ: 5 },
  });
  const card = blockableCard();
  env.document.body.appendChild(card);

  // Allow the module's initial filter pass (idle-callback fallback fires at
  // ~50 ms) to run — if any filtering were armed, it would act on this card.
  await new Promise((r) => setTimeout(r, 150));

  // Module exited before wiring anything: no test hook, untouched card,
  // zero messages to the background (no CARDS_HIDDEN / SEEN_BATCH).
  assert.equal(env.api, null);
  assert.equal(card.dataset.ytwashState, undefined);
  assert.equal(env.browser.runtime.sendMessage._sent.length, 0);
});

test("control (www.youtube.com): the identical setup DOES hide the card", async () => {
  const env = loadFeedEnvironment({
    hostname: "www.youtube.com",
    settings: BLOCKABLE_SETTINGS,
    watched: ["dQw4w9WgXcQ"],
    seen: { dQw4w9WgXcQ: 5 },
  });
  const card = blockableCard();
  env.document.body.appendChild(card);
  await new Promise((r) => setTimeout(r, 150));

  // Precedence puts "watched" first; placeholderMode defaults to true.
  assert.equal(env.api !== null, true);
  assert.equal(card.dataset.ytwashState, "placeholder");
  assert.ok(card.dataset.ytwashReason === "watched" || card.dataset.ytwashReason === "repeat");
});

test("YTM: still-watching dismisser (privacy feature) remains active", async () => {
  const env = loadFeedEnvironment({
    hostname: "music.youtube.com",
    settings: { stillWatchingEnabled: true },
    loadFeedModule: false,
    extraModules: ["still-watching.js"],
  });
  const container = new FakeElement("ytmusic-popup-container");
  const dialog = new FakeElement("ytmusic-you-there-renderer");
  container.appendChild(dialog);
  const buttonRenderer = new FakeElement("yt-button-renderer");
  buttonRenderer.setAttribute("id", "confirm-button");
  const inner = new FakeElement("button");
  let clicked = 0;
  inner.click = function () {
    clicked++;
  };
  buttonRenderer.appendChild(inner);
  dialog.appendChild(buttonRenderer);
  env.document.body.appendChild(container);
  await new Promise((r) => setTimeout(r, 0));

  firePopupOpened(env.document, "YTMUSIC-YOU-THERE-RENDERER");
  assert.equal(clicked, 1);
});

test("YTM: URL-privacy utility stays available (cleanUrl strips tracking)", () => {
  const env = loadFeedEnvironment({ hostname: "music.youtube.com", loadFeedModule: false });
  const cleaned = env.YTWash.cleanUrl(
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xJq8kR&utm_source=share"
  );
  assert.equal(cleaned, "https://music.youtube.com/watch?v=dQw4w9WgXcQ");
});
