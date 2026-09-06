/**
 * URL-privacy + shared-utility tests: cleanUrl param stripping, ID/duration
 * parsing, and the store's cold-start retry (Bug #1 regression).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadFeedEnvironment, loadStoreEnvironment } from "./helpers.mjs";

function loadBackgroundEnvironment(initialStorage = {}) {
  const storage = { ...initialStorage };
  let messageListener;
  const browser = {
    runtime: {
      onMessage: { addListener: (listener) => { messageListener = listener; } },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") return { [keys]: storage[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          return { ...storage };
        },
        set: async (updates) => Object.assign(storage, updates),
        remove: async (key) => { delete storage[key]; },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    declarativeNetRequest: { updateEnabledRulesets: async () => {} },
  };
  const sandbox = { browser, console, Date, Math, Number, Object, Array, Set, Promise };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL("../background/service-worker.js", import.meta.url), "utf8"),
    sandbox,
    { filename: "background/service-worker.js" }
  );
  return { send: (message) => messageListener(message, {}), storage };
}

test("cleanUrl strips tracking params and keeps functional ones", () => {
  const { YTWash } = loadFeedEnvironment();
  const { cleanUrl, parseVideoIdFromUrl, parseDurationText } = YTWash;

  // si= stripped
  assert.equal(
    cleanUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  );
  // feature/pp/source_ve_path stripped, v/t kept
  assert.equal(
    cleanUrl("https://www.youtube.com/watch?v=x&feature=share&t=90&pp=abc&source_ve_path=zz"),
    "https://www.youtube.com/watch?v=x&t=90"
  );
  // youtu.be shape
  assert.equal(cleanUrl("https://youtu.be/dQw4w9WgXcQ?si=q"), "https://youtu.be/dQw4w9WgXcQ");
  // utm_* campaign family stripped (Feature #4)
  assert.equal(
    cleanUrl("https://www.youtube.com/watch?v=abc&utm_source=newsletter&utm_campaign=x"),
    "https://www.youtube.com/watch?v=abc"
  );
  // non-YouTube untouched → null; no params → null
  assert.equal(cleanUrl("https://example.com/?si=a"), null);
  assert.equal(cleanUrl("https://www.youtube.com/watch?v=x"), null);
  // shorts link keeps ID, loses tracker
  assert.equal(
    parseVideoIdFromUrl("https://www.youtube.com/shorts/abcdefghijk?feature=share"),
    "abcdefghijk"
  );
  // duration parsing
  assert.equal(parseDurationText("1:02:33"), 3753);
  assert.equal(parseDurationText("4:20"), 260);
  assert.equal(parseDurationText("LIVE"), null);
});

test("REGRESSION (Bug #1): store.ready() initializes directly from storage.local without background dependency", async () => {
  const { store } = loadFeedEnvironment({
    loadFeedModule: false,
    watched: ["dQw4w9WgXcQ"],
    settings: { threshold: 0.9 },
  });

  await store.ready();
  assert.equal(store.settings.threshold, 0.9);
  assert.ok(store.watched.has("dQw4w9WgXcQ"));
});

test("REGRESSION (Bug #1): store.ready() uses fallback messaging when storage.local is unavailable", async () => {
  let calls = 0;
  const { store, browser } = loadStoreEnvironment({
    sendMessageImpl: (msg) => {
      calls++;
      if (msg.type === "GET_STATE") return Promise.resolve({ settings: { threshold: 0.85 } });
      if (msg.type === "GET_WATCHED_IDS") return Promise.resolve({ watchedIds: ["abc12345678"] });
      return Promise.resolve({});
    },
  });

  // Simulate storage.local.get failure to test fallback
  browser.storage.local.get = () => Promise.reject(new Error("Storage unavailable"));

  await store.ready();
  assert.ok(calls >= 2, "Fallback sendMessage was called");
  assert.equal(store.settings.threshold, 0.85);
  assert.ok(store.watched.has("abc12345678"));
});

test("REGRESSION (Bug #1): store.ready() still resolves even if both storage and messaging fail", async () => {
  const { store, browser } = loadStoreEnvironment({
    sendMessageImpl: () => Promise.reject(new Error("Dead background")),
  });

  browser.storage.local.get = () => Promise.reject(new Error("Dead storage"));

  await store.ready();
  assert.ok(store.settings.masterEnabled);
});

test("SET_SETTINGS preserves manual slider overrides while capping repeat counts", async () => {
  const { send, storage } = loadBackgroundEnvironment();

  const override = await send({
    type: "SET_SETTINGS",
    settings: { threshold: 1.5, repeatThreshold: 25 },
  });
  assert.equal(override.settings.threshold, 1.5);
  assert.equal(override.settings.repeatThreshold, 25);

  const capped = await send({ type: "SET_SETTINGS", settings: { repeatThreshold: 100001 } });
  assert.equal(capped.settings.repeatThreshold, 100000);

  const persisted = await send({ type: "GET_STATE" });
  assert.equal(persisted.settings.threshold, 1.5);
  assert.equal(persisted.settings.repeatThreshold, 100000);
  assert.equal(storage.settings.threshold, 1.5);
});
