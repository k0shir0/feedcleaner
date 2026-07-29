/**
 * FeedCleaner — background event page (Firefox MV3).
 *
 * Owns ALL writes to browser.storage. Content scripts, popup, and settings
 * communicate exclusively via runtime messages handled here.
 *
 * Firefox note: this is an event-driven background script, not a persistent
 * page and not a Chrome-style service worker. It can be suspended between
 * events, so no in-memory state is authoritative — every handler re-reads
 * storage. The session counter lives in storage.session so it survives
 * suspension but resets when the browser closes.
 */

"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  masterEnabled: true,
  watchFilterEnabled: true,
  adBlockerEnabled: false, // Module B — not implemented yet, always false
  threshold: 0.8, // watched when currentTime/duration >= threshold
  placeholderMode: true, // true = placeholder card, false = hard-hide
  showLabel: true, // "Already watched" label on placeholder cards
  repeatEnabled: true, // Repeat Video Fixer: hide cards seen too often
  repeatThreshold: 1, // hide after this many prior feed sightings
  stripLinks: true, // strip tracking params from copied/shared YT links
  purgeDays: 0, // auto-forget watched/seen entries older than N days; 0 = never
  beaconBlockEnabled: false, // opt-in: enable the yt-beacons DNR ruleset
  hideShorts: false, // hide Shorts shelves and /shorts/ cards
  hideMixes: false, // hide Mix / algorithmic radio cards
  hideLive: false, // hide live-stream cards
  hidePremieres: false, // hide premiere/upcoming cards
  minDurationSec: 0, // hide videos shorter than this; 0 = off
  blockedChannels: Object.freeze([]), // channel handles/names to hide
  keywordFilters: Object.freeze([]), // title filters; /…/flags = regex
});

// Repeat Video Fixer sighting counts: { videoId: [count, lastSeenMs] }.
// Pruned by last-seen date so the map can't grow without bound.
const MAX_SEEN_ENTRIES = 20_000;
const SEEN_PRUNE_TO = 15_000;

// YouTube video IDs are 11 chars today; accept 6–20 [A-Za-z0-9_-] to be
// tolerant of format drift without accepting garbage.
const VIDEO_ID_RE = /^[\w-]{6,20}$/;

// Serializes read-modify-write cycles on storage.local so concurrent
// messages (e.g. several YouTube tabs) can't clobber each other. Only one
// background instance runs at a time, so an in-memory chain is sufficient.
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const result = writeQueue.then(fn);
  // Keep the chain alive even if fn rejects.
  writeQueue = result.catch(() => {});
  return result;
}

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

// Watched videos: { videoId: watchedAtMs }. Was a bare ID array before
// 0.3.0; onInstalled migrates old data (timestamps enable purgeDays).
async function getWatched() {
  const { watched } = await browser.storage.local.get("watched");
  return watched && typeof watched === "object" ? watched : {};
}

async function getSeenCounts() {
  const { seenCounts } = await browser.storage.local.get("seenCounts");
  return seenCounts && typeof seenCounts === "object" ? seenCounts : {};
}

async function getHiddenCount() {
  const { hiddenCount } = await browser.storage.session.get("hiddenCount");
  return typeof hiddenCount === "number" ? hiddenCount : 0;
}

/** De-dupe, trim, and cap a user-supplied string list. */
function sanitizeStringList(value, { maxLength, maxEntries }) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const list = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim();
    if (!entry || entry.length > maxLength) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(entry);
    if (list.length >= maxEntries) break;
  }
  return list;
}

function sanitizeSettings(patch) {
  const clean = {};
  for (const key of [
    "masterEnabled",
    "watchFilterEnabled",
    "placeholderMode",
    "showLabel",
    "repeatEnabled",
    "stripLinks",
    "beaconBlockEnabled",
    "hideShorts",
    "hideMixes",
    "hideLive",
    "hidePremieres",
  ]) {
    if (typeof patch[key] === "boolean") clean[key] = patch[key];
  }
  if (typeof patch.threshold === "number" && Number.isFinite(patch.threshold)) {
    clean.threshold = Math.min(1, Math.max(0.5, patch.threshold));
  }
  if (typeof patch.repeatThreshold === "number" && Number.isFinite(patch.repeatThreshold)) {
    // Bounds must match the settings-page range input (1–10).
    clean.repeatThreshold = Math.min(10, Math.max(1, Math.round(patch.repeatThreshold)));
  }
  if (typeof patch.purgeDays === "number" && Number.isFinite(patch.purgeDays)) {
    clean.purgeDays = Math.min(365, Math.max(0, Math.round(patch.purgeDays)));
  }
  if (typeof patch.minDurationSec === "number" && Number.isFinite(patch.minDurationSec)) {
    clean.minDurationSec = Math.min(3600, Math.max(0, Math.round(patch.minDurationSec)));
  }
  const channels = sanitizeStringList(patch.blockedChannels, { maxLength: 100, maxEntries: 1000 });
  if (channels) clean.blockedChannels = channels;
  const keywords = sanitizeStringList(patch.keywordFilters, { maxLength: 200, maxEntries: 500 });
  if (keywords) clean.keywordFilters = keywords;
  // adBlockerEnabled is intentionally not settable until Module B ships.
  return clean;
}

/**
 * Enable/disable the static yt-beacons declarativeNetRequest ruleset
 * (dnr/yt-beacons.json, declared disabled in the manifest). Idempotent.
 */
async function applyBeaconRuleset(enabled) {
  try {
    await browser.declarativeNetRequest.updateEnabledRulesets(
      enabled ? { enableRulesetIds: ["yt-beacons"] } : { disableRulesetIds: ["yt-beacons"] }
    );
  } catch (e) {
    console.warn("[FeedCleaner] beacon ruleset toggle failed", e);
  }
}

const handlers = {
  async VIDEO_PROGRESS({ videoId, percent }, sender) {
    // Mozilla add-on policy: data from private browsing sessions must not
    // be retained. Filtering still works there (reads are unaffected);
    // watch history from private tabs is simply never recorded.
    if (sender?.tab?.incognito) return { added: false };
    if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) return { added: false };
    if (typeof percent !== "number" || !Number.isFinite(percent)) return { added: false };

    const settings = await getSettings();
    if (!settings.masterEnabled || !settings.watchFilterEnabled) return { added: false };
    if (percent < settings.threshold) return { added: false };

    return enqueueWrite(async () => {
      const watched = await getWatched();
      if (videoId in watched) return { added: false };
      watched[videoId] = Date.now();
      await browser.storage.local.set({ watched });
      return { added: true };
    });
  },

  async GET_WATCHED_IDS() {
    const [watched, seen] = await Promise.all([getWatched(), getSeenCounts()]);
    const seenCounts = {};
    for (const [id, entry] of Object.entries(seen)) seenCounts[id] = entry[0];
    return { watchedIds: Object.keys(watched), seenCounts };
  },

  async SEEN_BATCH({ ids }, sender) {
    // Same private-browsing rule as VIDEO_PROGRESS: never persist sightings
    // observed in a private window.
    if (sender?.tab?.incognito) return { ok: false };
    if (!Array.isArray(ids)) return { ok: false };
    const valid = ids.filter((id) => typeof id === "string" && VIDEO_ID_RE.test(id));
    if (valid.length === 0) return { ok: true };

    const settings = await getSettings();
    if (!settings.masterEnabled || !settings.repeatEnabled) return { ok: false };

    return enqueueWrite(async () => {
      const seen = await getSeenCounts();
      const now = Date.now();
      for (const id of valid) {
        seen[id] = seen[id] ? [seen[id][0] + 1, now] : [1, now];
      }
      const keys = Object.keys(seen);
      if (keys.length > MAX_SEEN_ENTRIES) {
        keys.sort((a, b) => seen[a][1] - seen[b][1]); // oldest last-seen first
        for (const key of keys.slice(0, keys.length - SEEN_PRUNE_TO)) delete seen[key];
      }
      await browser.storage.local.set({ seenCounts: seen });
      return { ok: true };
    });
  },

  async RESET_SEEN({ videoId }) {
    return enqueueWrite(async () => {
      const seen = await getSeenCounts();
      if (videoId in seen) {
        delete seen[videoId];
        await browser.storage.local.set({ seenCounts: seen });
      }
      return { ok: true };
    });
  },

  async CLEAR_SEEN() {
    return enqueueWrite(async () => {
      await browser.storage.local.set({ seenCounts: {} });
      return { ok: true };
    });
  },

  async GET_STATE() {
    const [settings, watched, hiddenCount] = await Promise.all([
      getSettings(),
      getWatched(),
      getHiddenCount(),
    ]);
    return { settings, watchedCount: Object.keys(watched).length, hiddenCount };
  },

  async SET_SETTINGS({ settings: patch }) {
    if (!patch || typeof patch !== "object") return { settings: await getSettings() };
    const clean = sanitizeSettings(patch);
    return enqueueWrite(async () => {
      const merged = { ...(await getSettings()), ...clean };
      await browser.storage.local.set({ settings: merged });
      if ("beaconBlockEnabled" in clean) applyBeaconRuleset(merged.beaconBlockEnabled);
      return { settings: merged };
    });
  },

  async UNWATCH({ videoId }) {
    return enqueueWrite(async () => {
      const watched = await getWatched();
      const updates = {};
      const removed = videoId in watched;
      if (removed) {
        delete watched[videoId];
        updates.watched = watched;
      }
      // Unwatching means "show me this again" — clear its sighting count
      // too, or the Repeat Fixer instantly re-hides the card.
      const seen = await getSeenCounts();
      if (videoId in seen) {
        delete seen[videoId];
        updates.seenCounts = seen;
      }
      if (Object.keys(updates).length > 0) await browser.storage.local.set(updates);
      return { removed, watchedCount: Object.keys(watched).length };
    });
  },

  async CLEAR_WATCHED() {
    return enqueueWrite(async () => {
      await browser.storage.local.set({ watched: {} });
      return { watchedCount: 0 };
    });
  },

  // Legacy import path: a bare ID array (pre-0.3.0 export files). Imported
  // entries get the import time as their watched date.
  async IMPORT_WATCHED({ ids, mode }) {
    if (!Array.isArray(ids)) return { error: "ids must be an array" };
    const valid = [...new Set(ids.filter((id) => typeof id === "string" && VIDEO_ID_RE.test(id)))];
    return enqueueWrite(async () => {
      const watched = mode === "replace" ? {} : await getWatched();
      const now = Date.now();
      for (const id of valid) {
        if (!(id in watched)) watched[id] = now;
      }
      await browser.storage.local.set({ watched });
      return {
        watchedCount: Object.keys(watched).length,
        imported: valid.length,
        skipped: ids.length - valid.length,
      };
    });
  },

  async GET_BACKUP() {
    const [settings, watched, seenCounts] = await Promise.all([
      getSettings(),
      getWatched(),
      getSeenCounts(),
    ]);
    return {
      format: "feedcleaner/backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      settings,
      watched,
      seenCounts,
    };
  },

  // Unified backup import: settings (sanitized) + watched map + seen counts.
  // mode "replace" swaps the stored data; anything else merges.
  async IMPORT_BACKUP({ data, mode }) {
    if (!data || typeof data !== "object") return { error: "not a backup object" };
    const replace = mode === "replace";
    const now = Date.now();

    const settingsPatch =
      data.settings && typeof data.settings === "object" ? sanitizeSettings(data.settings) : {};

    const validWatched = {};
    if (data.watched && typeof data.watched === "object") {
      for (const [id, ts] of Object.entries(data.watched)) {
        if (!VIDEO_ID_RE.test(id)) continue;
        const t = Number(ts);
        validWatched[id] = Number.isFinite(t) && t > 0 && t <= now ? t : now;
      }
    }

    const validSeen = {};
    if (data.seenCounts && typeof data.seenCounts === "object") {
      for (const [id, entry] of Object.entries(data.seenCounts)) {
        if (!VIDEO_ID_RE.test(id) || !Array.isArray(entry)) continue;
        const count = Math.floor(Number(entry[0]));
        if (!Number.isFinite(count) || count < 1) continue;
        const ts = Number(entry[1]);
        validSeen[id] = [count, Number.isFinite(ts) ? ts : now];
      }
    }

    return enqueueWrite(async () => {
      const settings = { ...(await getSettings()), ...settingsPatch };
      const watched = replace ? validWatched : { ...(await getWatched()), ...validWatched };
      const seenCounts = replace ? validSeen : { ...(await getSeenCounts()), ...validSeen };
      await browser.storage.local.set({ settings, watched, seenCounts });
      applyBeaconRuleset(settings.beaconBlockEnabled);
      return {
        watchedCount: Object.keys(watched).length,
        seenCount: Object.keys(seenCounts).length,
        settingsApplied: Object.keys(settingsPatch).length,
      };
    });
  },

  async CARDS_HIDDEN({ count }) {
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (n === 0) return { hiddenCount: await getHiddenCount() };
    return enqueueWrite(async () => {
      const hiddenCount = (await getHiddenCount()) + n;
      await browser.storage.session.set({ hiddenCount });
      return { hiddenCount };
    });
  },
};

browser.runtime.onMessage.addListener((message, sender) => {
  const handler = message && handlers[message.type];
  if (!handler) return; // not ours; let other listeners (if any) respond
  return handler(message, sender).catch((e) => {
    // A throwing handler rejects the caller's sendMessage, and every caller
    // awaits it inside a render/refresh path — so the only symptom is a UI
    // that quietly stops updating. 0.3.0 shipped a dead GET_STATE for a full
    // release because of that silence. Name the failing message type here.
    console.error(`[FeedCleaner] ${message.type} handler failed`, e);
    throw e;
  });
});

browser.runtime.onInstalled.addListener(() =>
  enqueueWrite(async () => {
    const { settings, watchedIds, watched } = await browser.storage.local.get([
      "settings",
      "watchedIds",
      "watched",
    ]);
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    const updates = { settings: merged };

    // Pre-0.3.0 migration: bare ID array → { id: watchedAtMs } map, so
    // purgeDays has dates to work with. Old entries get the migration time.
    if (Array.isArray(watchedIds)) {
      const now = Date.now();
      const map = watched && typeof watched === "object" ? { ...watched } : {};
      for (const id of watchedIds) {
        if (!(id in map)) map[id] = now;
      }
      updates.watched = map;
    }

    await browser.storage.local.set(updates);
    if (Array.isArray(watchedIds)) await browser.storage.local.remove("watchedIds");

    // Ruleset state is not persisted with settings — re-sync on every
    // install/update in case they drifted (e.g. restored profile).
    await applyBeaconRuleset(merged.beaconBlockEnabled);
  })
);

/* ------------------------------ auto-purge ------------------------------ */

const PURGE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Drop watched entries and seen counts older than settings.purgeDays.
 * Runs on every background wake-up (event page re-executes top level),
 * throttled to one real pass per 12 h via lastPurgeMs.
 */
async function maybePurge() {
  const settings = await getSettings();
  if (!settings.purgeDays) return;
  const { lastPurgeMs } = await browser.storage.local.get("lastPurgeMs");
  const now = Date.now();
  if (typeof lastPurgeMs === "number" && now - lastPurgeMs < PURGE_CHECK_INTERVAL_MS) return;

  await enqueueWrite(async () => {
    const cutoff = now - settings.purgeDays * DAY_MS;
    const watched = await getWatched();
    const seen = await getSeenCounts();

    const nextWatched = {};
    for (const [id, ts] of Object.entries(watched)) {
      if (Number(ts) >= cutoff) nextWatched[id] = ts;
    }
    const nextSeen = {};
    for (const [id, entry] of Object.entries(seen)) {
      if (Array.isArray(entry) && Number(entry[1]) >= cutoff) nextSeen[id] = entry;
    }

    await browser.storage.local.set({
      watched: nextWatched,
      seenCounts: nextSeen,
      lastPurgeMs: now,
    });
  });
}

maybePurge().catch((e) => console.warn("[FeedCleaner] purge failed", e));
