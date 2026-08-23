/**
 * URL-privacy + shared-utility tests: cleanUrl param stripping, ID/duration
 * parsing, and the store's cold-start retry (Bug #1 regression).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFeedEnvironment, loadStoreEnvironment } from "./helpers.mjs";

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

test("REGRESSION (Bug #1): store.ready() retries when the background is unreachable at cold start", async () => {
  let calls = 0;
  const { store } = loadStoreEnvironment({
    sendMessageImpl: () => {
      calls++;
      if (calls <= 2) return Promise.reject(new Error("Could not establish connection"));
      return Promise.resolve({});
    },
  });

  const t0 = Date.now();
  await store.ready(); // must resolve despite the first two failures
  assert.ok(calls >= 3, `expected >=3 attempts after 2 failures, got ${calls}`);
  // Backoff schedule is 250 + 1000 ms before attempt #3 succeeds.
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `retry loop took too long: ${elapsed}ms`);
});

test("REGRESSION (Bug #1): store.ready() recovers after a single failure", async () => {
  let calls = 0;
  const { store } = loadStoreEnvironment({
    sendMessageImpl: () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({});
    },
  });
  await store.ready();
  assert.ok(calls >= 2);
});

test("REGRESSION (Bug #1): store.ready() still resolves when every attempt fails", async () => {
  let calls = 0;
  const { store } = loadStoreEnvironment({
    sendMessageImpl: () => {
      calls++;
      return Promise.reject(new Error("dead background"));
    },
  });
  await store.ready(); // bounded retry exhausts, logs, resolves anyway
  assert.ok(calls >= 4); // initial + 3 retries
});
