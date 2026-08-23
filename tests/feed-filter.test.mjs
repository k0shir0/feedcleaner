/**
 * Filtering-decision tests: decideCard / hideCard / showCard / placeholder
 * repair, driven against the REAL content scripts via the fake DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFeedEnvironment, makeCard, FakeElement } from "./helpers.mjs";

function env(opts) {
  return loadFeedEnvironment(opts);
}

test("decideCard hides watched videos (watched > all other reasons)", () => {
  const { api, store } = env({ watched: ["dQw4w9WgXcQ"] });
  const info = { videoId: "dQw4w9WgXcQ", title: "x", channelName: "blockedchan", isShort: true };
  const decision = api.decideCard(info, store.settings);
  assert.equal(decision.reason, "watched");
});

test("decideCard never hides when metadata is unknown", () => {
  const { api, store } = env({
    settings: { hideLive: true, hidePremieres: true, hideMixes: true, minDurationSec: 60 },
  });
  // All signals null/false: nothing may trigger.
  const decision = api.decideCard(
    { videoId: "abcdefghijk", title: null, durationSec: null, isLive: false, isUpcoming: false, isMix: false, isShort: false },
    store.settings
  );
  assert.equal(decision, null);
});

test("decideCard respects each categorical rule and its toggle", () => {
  const base = {
    videoId: "abcdefghijk",
    title: "hello",
    channelName: "somechannel",
    durationSec: 30,
    isLive: false,
    isUpcoming: false,
    isMix: false,
    isShort: false,
  };

  // min-duration ON: 30s < 60s → hidden; OFF → shown
  let { api, store } = env({ settings: { minDurationSec: 60 } });
  assert.equal(api.decideCard(base, store.settings).reason, "duration");
  ({ api, store } = env({ settings: { minDurationSec: 0 } }));
  assert.equal(api.decideCard(base, store.settings), null);

  // shorts ON/OFF
  const short = { ...base, isShort: true, durationSec: 20 };
  ({ api, store } = env({ settings: { hideShorts: true } }));
  assert.equal(api.decideCard(short, store.settings).reason, "shorts");
  ({ api, store } = env({ settings: { hideShorts: false } }));
  assert.equal(api.decideCard(short, store.settings), null);

  // live ON/OFF
  const live = { ...base, isLive: true };
  ({ api, store } = env({ settings: { hideLive: true } }));
  assert.equal(api.decideCard(live, store.settings).reason, "live");
});

test("repeat rule uses the navigation snapshot, not live counts", () => {
  const { api } = env({ settings: { repeatEnabled: true, repeatThreshold: 2 }, seen: { abcdefghijk: [5, 0] } });
  api.setSeenSnapshot(new Map([["abcdefghijk", 1]])); // below threshold at nav time
  const decision = api.decideCard({ videoId: "abcdefghijk", title: "t" }, api.getSettings());
  assert.equal(decision, null);
});

test("sessionReveals override every other reason for that ID", () => {
  const { api, store } = env({ watched: ["dQw4w9WgXcQ"] });
  api.getSessionReveals().add("dQw4w9WgXcQ");
  assert.equal(api.decideCard({ videoId: "dQw4w9WgXcQ", title: "t" }, store.settings), null);
});
test("history page: runFilterPass restores hidden cards and hides nothing", () => {
  const doc = env({ watched: ["dQw4w9WgXcQ"] });
  // Re-load with history pathname.
  const hist = loadFeedEnvironment({ watched: ["dQw4w9WgXcQ"], pathname: "/feed/history" });
  const card = makeCard({ id: "dQw4w9WgXcQ" });
  // Pre-hide it as if a previous pass on another page had.
  card.dataset.ytwashState = "hard";
  card.style.display = "none";
  hist.document.body.appendChild(card);
  hist.api.runFilterPass();
  assert.equal(card.dataset.ytwashState, undefined);
  assert.notEqual(card.style.display, "none");
  void doc;
});

test("placeholder hide: host class + placeholder child + dataset state", () => {
  const { api, document } = env({ watched: ["dQw4w9WgXcQ"] });
  const card = makeCard({ id: "dQw4w9WgXcQ" });
  document.body.appendChild(card);
  const changed = api.hideCard(card, "dQw4w9WgXcQ", "watched", "Already watched");
  assert.equal(changed, true);
  assert.equal(card.dataset.ytwashState, "placeholder");
  assert.ok(card.classList.contains("ytwash-placeholder-host"));
  assert.ok(card.querySelector(":scope > .ytwash-placeholder"));
});

test("REGRESSION (Bug #3): missing placeholder child is rebuilt, no empty tile", () => {
  const { api, document } = env({ watched: ["dQw4w9WgXcQ"] });
  const card = makeCard({ id: "dQw4w9WgXcQ" });
  document.body.appendChild(card);
  api.hideCard(card, "dQw4w9WgXcQ", "watched", "Already watched");

  // Simulate YouTube re-rendering the card innards: our placeholder child
  // disappears while dataset state remains "placeholder".
  card.querySelector(":scope > .ytwash-placeholder").remove();

  // Next filter pass must rebuild it instead of trusting the stale guard.
  const changed = api.hideCard(card, "dQw4w9WgXcQ", "watched", "Already watched");
  assert.equal(changed, false); // not a NEW hide…
  assert.ok(card.querySelector(":scope > .ytwash-placeholder")); // …but repaired
});

test("hard-hide mode ignores placeholder repair path (display:none is self-sufficient)", () => {
  const { api, document, store } = env({
    watched: ["dQw4w9WgXcQ"],
    settings: { placeholderMode: false },
  });
  void store;
  const card = makeCard({ id: "dQw4w9WgXcQ" });
  document.body.appendChild(card);
  api.hideCard(card, "dQw4w9WgXcQ", "watched", "Already watched");
  assert.equal(card.dataset.ytwashState, "hard");
  assert.equal(card.style.display, "none");
  // Re-applying same hide: no transition, stays hidden.
  assert.equal(api.hideCard(card, "dQw4w9WgXcQ", "watched", "Already watched"), false);
  assert.equal(card.style.display, "none");
});

test("showCard fully clears state even when placeholder child was already removed externally", () => {
  const { api, document } = env({ watched: ["dQw4w9WgXcQ"] });
  const card = makeCard({ id: "dQw4w9WgXcQ" });
  document.body.appendChild(card);
  api.hideCard(card, "dQw4w9WgXcQ", "watched", "Already watched");
  card.querySelector(":scope > .ytwash-placeholder").remove(); // external re-render
  api.showCard(card);
  assert.equal(card.dataset.ytwashState, undefined);
  assert.ok(!card.classList.contains("ytwash-placeholder-host"));
});

test("rule-based hide without video ID falls back to hard-hide (nothing to key a button on)", () => {
  const { api, document, store } = env({ settings: { hideShorts: true } });
  const shelf = new FakeElement("ytd-rich-shelf-renderer");
  shelf.setAttribute("is-shorts", "");
  document.body.appendChild(shelf);
  api.hideCard(shelf, null, "shorts-shelf", "Shorts shelf hidden");
  assert.equal(shelf.dataset.ytwashState, "hard");
  void store;
});
