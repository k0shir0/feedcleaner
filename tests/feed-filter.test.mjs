/**
 * Filtering-decision tests: decideCard / hideCard / showCard / placeholder
 * repair, driven against the REAL content scripts via the fake DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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

test("channel exemption is opt-in and covers every channel URL and tab", () => {
  for (const pathname of [
    "/@example", "/@example/", "/@example/videos", "/@example/shorts",
    "/@example/streams", "/@example/search", "/channel/UCexample",
    "/channel/UCexample/videos", "/c/example", "/c/example/playlists",
    "/user/example", "/user/example/videos",
  ]) {
    const { api, store } = env({ pathname, watched: ["watched1234"] });
    api.setSeenSnapshot(new Map([["repeated123", 2]]));
    const watched = { videoId: "watched1234" };
    const repeated = { videoId: "repeated123" };
    assert.equal(store.settings.exemptChannelPages, false);
    assert.equal(api.decideCard(watched, store.settings).reason, "watched", pathname);
    assert.equal(api.decideCard(repeated, store.settings).reason, "repeat", pathname);
    store.settings.exemptChannelPages = true;
    assert.equal(api.decideCard(watched, store.settings), null, pathname);
    assert.equal(api.decideCard(repeated, store.settings), null, pathname);
  }
});

test("channel exemption keeps watched and repeat filtering on other surfaces", () => {
  for (const pathname of [
    "/", "/feed/subscriptions", "/results", "/watch", "/shorts/video12345",
    "/playlist", "/channels", "/channel/", "/c/", "/user/",
  ]) {
    const { api, store } = env({
      pathname, watched: ["watched1234"], settings: { exemptChannelPages: true },
    });
    api.setSeenSnapshot(new Map([["repeated123", 2]]));
    assert.equal(api.decideCard({ videoId: "watched1234" }, store.settings).reason, "watched", pathname);
    assert.equal(api.decideCard({ videoId: "repeated123" }, store.settings).reason, "repeat", pathname);
  }
});

test("exempt channel pages still apply each feed cleanup rule", () => {
  for (const [settings, info, reason] of [
    [{ blockedChannels: ["example"] }, { channelName: "Example" }, "channel"],
    [{ keywordFilters: ["hidden"] }, { title: "Hidden video" }, "keyword"],
    [{ minDurationSec: 60 }, { durationSec: 30 }, "duration"],
    [{ hideMixes: true }, { isMix: true }, "mix"],
    [{ hideLive: true }, { isLive: true }, "live"],
    [{ hidePremieres: true }, { isUpcoming: true }, "premiere"],
    [{ hideShorts: true }, { isShort: true }, "shorts"],
  ]) {
    const { api, store } = env({
      pathname: "/@example/videos", watched: ["watched1234"],
      settings: { exemptChannelPages: true, ...settings },
    });
    api.compileMatchers();
    api.setSeenSnapshot(new Map([["watched1234", 2]]));
    assert.equal(api.decideCard({ videoId: "watched1234", ...info }, store.settings).reason, reason);
  }
});

test("channel exemption restores cards on settings changes and SPA navigation in both hide modes", async () => {
  for (const placeholderMode of [true, false]) {
    const { api, store, document, window, sandbox } = env({
      pathname: "/@example/videos", watched: ["watched1234"],
      seen: { repeated123: 2 }, settings: { placeholderMode },
    });
    const cards = [makeCard({ id: "watched1234" }), makeCard({ id: "repeated123" })];
    for (const card of cards) document.body.appendChild(card);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const assertFiltered = () => {
      assert.equal(cards[0].dataset.ytwashReason, "watched");
      assert.equal(cards[1].dataset.ytwashReason, "repeat");
    };
    const assertVisible = () => {
      for (const card of cards) {
        assert.equal(card.dataset.ytwashState, undefined);
        assert.notEqual(card.style.display, "none");
        assert.equal(card.querySelector(":scope > .ytwash-placeholder"), null);
        assert.equal(card.classList.contains("ytwash-placeholder-host"), false);
      }
    };
    await settle();
    assertFiltered();
    store.settings.exemptChannelPages = true;
    store._notify({ settingsChanged: true });
    await settle();
    assertVisible();
    sandbox.location.pathname = "/";
    for (const fn of window._listeners["yt-navigate-finish"]) fn();
    await settle();
    assertFiltered();
    sandbox.location.pathname = "/channel/UCexample/videos";
    for (const fn of window._listeners["yt-navigate-finish"]) fn();
    await settle();
    assertVisible();
    store.settings.exemptChannelPages = false;
    store._notify({ settingsChanged: true });
    await settle();
    assertFiltered();
  }
});

test("exempt channel visits do not add repeat sightings, including after SPA navigation", async () => {
  const { store, document, sandbox, window, browser } = env({
    loadFeedModule: false, pathname: "/@example/videos",
    settings: { exemptChannelPages: true },
  });
  let onSightings;
  sandbox.IntersectionObserver = class {
    constructor(callback) { onSightings = callback; }
    observe() {}
    disconnect() {}
  };
  store._ready = Promise.resolve();
  // Capture the real observer callback without adding a production test hook.
  vm.runInContext(readFileSync(new URL("../content/youtube-feed.js", import.meta.url), "utf8"), sandbox);
  await Promise.resolve();
  const card = makeCard({ id: "channel1234" });
  document.body.appendChild(card);
  const entries = [{ target: card, isIntersecting: true, intersectionRatio: 1 }];
  const navigate = (pathname) => {
    sandbox.location.pathname = pathname;
    for (const fn of window._listeners["yt-navigate-finish"]) fn();
  };
  const flush = () => { for (const fn of window._listeners.pagehide) fn(); };
  const batches = () => browser.runtime.sendMessage._sent.filter((message) => message.type === "SEEN_BATCH");
  onSightings(entries);
  flush();
  assert.equal(batches().length, 0);
  navigate("/");
  onSightings(entries);
  navigate("/@example/videos"); // Flush the legitimate sighting from Home.
  assert.equal(batches().length, 1);
  assert.deepEqual(Array.from(batches()[0].ids), ["channel1234"]);
  onSightings(entries);
  flush();
  assert.equal(batches().length, 1);
  store.settings.exemptChannelPages = false;
  onSightings(entries);
  flush();
  assert.equal(batches().length, 2);
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

test("nested cards: runFilterPass ignores inner lockup when wrapped by outer renderer", () => {
  const { api, document } = env({ watched: ["nested123"] });
  const outer = new FakeElement("ytd-rich-item-renderer");
  const inner = new FakeElement("yt-lockup-view-model");
  const anchor = new FakeElement("a");
  anchor.setAttribute("href", "/watch?v=nested123");
  inner.appendChild(anchor);
  outer.appendChild(inner);
  document.body.appendChild(outer);

  api.runFilterPass();

  // Outer container is hidden/placeholder
  assert.equal(outer.dataset.ytwashState, "placeholder");
  // Inner container is NOT touched (preventing duplicate placeholders / double counting)
  assert.equal(inner.dataset.ytwashState, undefined);
});

test("skeleton card hydration: unhydrated skeleton is not observed until video ID attaches", () => {
  const { api, document, YTWash } = env({ settings: { repeatEnabled: true } });
  const skeleton = new FakeElement("ytd-rich-item-renderer");
  document.body.appendChild(skeleton);

  api.runFilterPass();
  assert.equal(YTWash.extractVideoId(skeleton), null);

  // Now attach anchor (hydration)
  const anchor = new FakeElement("a");
  anchor.setAttribute("href", "/watch?v=hydrated123");
  skeleton.appendChild(anchor);

  api.runFilterPass();
  assert.equal(YTWash.extractVideoId(skeleton), "hydrated123");
});
