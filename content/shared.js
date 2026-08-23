/**
 * FeedCleaner — shared content-script utilities.
 *
 * THE SINGLE POINT OF REPAIR: every assumption about YouTube's DOM lives in
 * this file (card element names, anchor shapes, player element lookup).
 * When YouTube renames an element, fix it here and nowhere else.
 *
 * Loaded before youtube-player.js and youtube-feed.js in the same isolated
 * world (see manifest content_scripts.js order), so `YTWash` is a plain
 * global shared by both.
 */

"use strict";

const YTWash = (() => {
  /**
   * Feed/listing card elements to filter, by surface:
   *  - ytd-rich-item-renderer      home feed, subscriptions
   *  - ytd-video-renderer          search results
   *  - ytd-compact-video-renderer  watch-page sidebar (classic)
   *  - yt-lockup-view-model        watch-page sidebar / collections (2024+)
   *  - ytd-grid-video-renderer     channel pages (classic grid)
   *
   * Deliberately NOT included: anything inside the player itself — the
   * currently playing video is never hidden.
   */
  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "yt-lockup-view-model",
    "ytd-grid-video-renderer",
  ];

  const CARD_SELECTOR = CARD_SELECTORS.join(",");

  // Anchors inside a card that identify its video.
  const CARD_ANCHOR_SELECTOR = 'a[href*="/watch?"], a[href^="/shorts/"], a[href*="youtube.com/shorts/"]';

  // The playing video element on /watch and /shorts pages.
  const PLAYER_VIDEO_SELECTOR = "video.html5-main-video, ytd-player video, #shorts-player video";

  /**
   * Shorts shelf containers, by surface:
   *  - ytd-rich-shelf-renderer[is-shorts]  home feed
   *  - ytd-reel-shelf-renderer             search results, watch page
   *  - grid-shelf-view-model               newer home/channel shelves
   */
  const SHELF_SELECTOR =
    "ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer, grid-shelf-view-model";

  // Title of a card. Classic renderers use #video-title; lockup view-models
  // wrap the title in an h3 (verified live 2026-07).
  const CARD_TITLE_SELECTOR = "#video-title, h3";

  // Channel link in classic renderers (/@handle or /channel/UC…). Lockups
  // show the channel as PLAIN TEXT in their first metadata row instead.
  const CARD_CHANNEL_LINK_SELECTOR = "ytd-channel-name a[href]";
  const LOCKUP_METADATA_TEXT_SELECTOR = ".ytContentMetadataViewModelMetadataText";

  // Duration/status badge on a thumbnail. Both the classic
  // time-status renderer and the lockup badge view-model carry either a
  // "H:MM:SS" duration or a status word like "LIVE".
  const CARD_BADGE_SELECTOR =
    "ytd-thumbnail-overlay-time-status-renderer, yt-thumbnail-badge-view-model";

  // Live/upcoming signals: legacy overlay-style attributes plus the 2026
  // badge-shape markup (aria-label="LIVE", live-styled class ytBadgeShapeL).
  const LIVE_SELECTOR =
    '[overlay-style="LIVE"], badge-shape[aria-label="LIVE"], badge-shape.ytBadgeShapeL';
  const UPCOMING_SELECTOR = '[overlay-style="UPCOMING"]';

  // Mix / algorithmic radio cards: their watch links carry list=RD… (radio
  // playlist) or start_radio=1.
  const MIX_ANCHOR_SELECTOR = 'a[href*="list=RD"], a[href*="start_radio=1"]';

  const VIDEO_ID_RE = /^[\w-]{6,20}$/;

  /**
   * Host policy flag: music.youtube.com gets PRIVACY FEATURES ONLY.
   *
   * FeedCleaner never hides video cards and never records watch progress on
   * YouTube Music — filtering/tracking modules must check this before acting.
   * The privacy modules (url-privacy.js, dnr beacon ruleset, and the
   * still-watching dismisser) deliberately do NOT check it: link cleaning,
   * telemetry blocking, and the inactivity-prompt bypass are wanted on both
   * sites. See README "YouTube Music policy".
   *
   * This makes "no blocking on YTM" explicit instead of relying on YouTube's
   * desktop selectors never drifting onto YTM's markup.
   */
  const IS_YOUTUBE_MUSIC = location.hostname === "music.youtube.com";

  // Query params that only exist to track how a link was shared/reached.
  // Functional params (v, t, list…) are never touched. utm_* are the
  // standard campaign-tracking family (never functional on watch URLs);
  // the rest are YouTube's own share/referral trackers.
  const TRACKING_PARAMS = [
    "si",
    "feature",
    "pp",
    "embeds_referring_euri",
    "embeds_referring_origin",
    "source_ve_path",
    "gclid",
    "fbclid",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
  ];

  /**
   * Strip tracking params from a YouTube/youtu.be URL.
   * @param {string} url absolute URL
   * @returns {string|null} cleaned URL, or null if not a YouTube URL or
   *          nothing needed stripping.
   */
  function cleanUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)) return null;
    let changed = false;
    for (const param of TRACKING_PARAMS) {
      if (u.searchParams.has(param)) {
        u.searchParams.delete(param);
        changed = true;
      }
    }
    return changed ? u.toString() : null;
  }

  /** "1:32" / "1:02:33" → seconds, or null if the text isn't a duration. */
  function parseDurationText(text) {
    const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (!m) return null;
    return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
  }

  /** Extract a video ID from any watch/shorts URL, or null. */
  function parseVideoIdFromUrl(url) {
    let u;
    try {
      u = new URL(url, location.origin);
    } catch {
      return null;
    }
    let id = null;
    if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else if (u.pathname.startsWith("/shorts/")) {
      id = u.pathname.split("/")[2] || null;
    }
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  /** Extract the video ID a feed card points at, or null. */
  function extractVideoId(cardEl) {
    const anchor = cardEl.querySelector(CARD_ANCHOR_SELECTOR);
    return anchor ? parseVideoIdFromUrl(anchor.getAttribute("href")) : null;
  }

  /**
   * Everything the filter pass needs to know about one card, read in a
   * single DOM pass. Absent signals come back null/false — callers must
   * treat "unknown" as "don't hide" (e.g. no duration badge ≠ short video).
   */
  function extractCardInfo(cardEl) {
    const anchor = cardEl.querySelector(CARD_ANCHOR_SELECTOR);
    const href = anchor ? anchor.getAttribute("href") || "" : "";

    const titleEl = cardEl.querySelector(CARD_TITLE_SELECTOR);

    let channelHandle = null;
    let channelName = null;
    const chanLink = cardEl.querySelector(CARD_CHANNEL_LINK_SELECTOR);
    if (chanLink) {
      channelName = chanLink.textContent.trim() || null;
      const chanHref = chanLink.getAttribute("href") || "";
      const m = /^\/(@[\w.-]+)|^\/channel\/(UC[\w-]+)/.exec(chanHref);
      if (m) channelHandle = (m[1] || m[2]).toLowerCase();
    } else {
      // Lockup cards: channel is the first metadata-row text span.
      const metaText = cardEl.querySelector(LOCKUP_METADATA_TEXT_SELECTOR);
      if (metaText) channelName = metaText.textContent.trim() || null;
    }

    let durationSec = null;
    let badgeIsLive = false;
    let badgeIsUpcoming = false;
    for (const badge of cardEl.querySelectorAll(CARD_BADGE_SELECTOR)) {
      const text = badge.textContent.trim();
      if (durationSec === null) durationSec = parseDurationText(text);
      if (/^live$/i.test(text)) badgeIsLive = true;
      if (/^(premieres?|waiting)\b/i.test(text)) badgeIsUpcoming = true;
    }

    return {
      videoId: anchor ? parseVideoIdFromUrl(href) : null,
      title: titleEl ? titleEl.textContent.trim() : null,
      channelHandle,
      channelName,
      durationSec,
      isLive: badgeIsLive || !!cardEl.querySelector(LIVE_SELECTOR),
      isUpcoming: badgeIsUpcoming || !!cardEl.querySelector(UPCOMING_SELECTOR),
      isMix: !!cardEl.querySelector(MIX_ANCHOR_SELECTOR),
      isShort: href.startsWith("/shorts/") || href.includes("youtube.com/shorts/"),
    };
  }

  function findPlayerVideo() {
    return document.querySelector(PLAYER_VIDEO_SELECTOR);
  }

  /* ------------------------------------------------------------------ *
   * Shared state cache: settings + watched-ID set.
   *
   * Content scripts never write storage; they message the background and
   * keep a local cache, refreshed by storage.onChanged (read-only) plus a
   * 30 s fallback poll. Subscribers are notified after each refresh.
   * ------------------------------------------------------------------ */

  const store = {
    // Must mirror DEFAULT_SETTINGS in background/service-worker.js.
    settings: {
      masterEnabled: true,
      watchFilterEnabled: true,
      adBlockerEnabled: false,
      threshold: 0.8,
      placeholderMode: true,
      showLabel: true,
      repeatEnabled: true,
      repeatThreshold: 1,
      stripLinks: true,
      purgeDays: 0,
      beaconBlockEnabled: false,
      stillWatchingEnabled: false,
      hideShorts: false,
      hideMixes: false,
      hideLive: false,
      hidePremieres: false,
      minDurationSec: 0,
      blockedChannels: [],
      keywordFilters: [],
    },
    watched: new Set(),
    seen: new Map(), // videoId → prior feed-sighting count
    _subscribers: new Set(),
    _ready: null,

    onChange(fn) {
      this._subscribers.add(fn);
    },

    /**
     * @param {{settingsChanged:boolean, watchedChanged:boolean,
     *          seenChanged:boolean}} [info] what changed; undefined means
     *          "assume everything" (initial load / fallback poll).
     */
    _notify(info) {
      for (const fn of this._subscribers) {
        try {
          fn(info);
        } catch (e) {
          console.warn("[FeedCleaner] subscriber error", e);
        }
      }
    },

    get enabled() {
      return this.settings.masterEnabled && this.settings.watchFilterEnabled;
    },

    async refresh() {
      const [state, idsResponse] = await Promise.all([
        browser.runtime.sendMessage({ type: "GET_STATE" }),
        browser.runtime.sendMessage({ type: "GET_WATCHED_IDS" }),
      ]);
      if (state && state.settings) this.settings = state.settings;
      if (idsResponse && Array.isArray(idsResponse.watchedIds)) {
        this.watched = new Set(idsResponse.watchedIds);
      }
      if (idsResponse && idsResponse.seenCounts && typeof idsResponse.seenCounts === "object") {
        this.seen = new Map(Object.entries(idsResponse.seenCounts));
      }
      this._notify();
    },

    /**
     * Idempotent init: first refresh + change listener + fallback poll.
     *
     * The initial refresh round-trips to the background event page, which
     * Firefox may still be starting when a YouTube tab loads (cold start).
     * A single failed sendMessage used to leave the cache empty and silent
     * until the next 30 s poll — the "extension only starts after clicking
     * the popup" report (the popup click is what spawns the background).
     * The retry below keeps init event-driven while making the first fetch
     * survive that race; failures stay logged instead of invisible.
     */
    ready() {
      if (!this._ready) {
        // Consume change payloads directly — no message round-trips. The
        // background stays the only writer; this is read-only intake, and
        // it fires every ~2s during scrolling (SEEN_BATCH flushes), so it
        // must be cheap.
        browser.storage.onChanged.addListener((changes, area) => {
          if (area !== "local") return;
          const info = {
            settingsChanged: "settings" in changes,
            watchedChanged: "watched" in changes,
            seenChanged: "seenCounts" in changes,
          };
          if (!info.settingsChanged && !info.watchedChanged && !info.seenChanged) return;

          if (info.settingsChanged && changes.settings.newValue) {
            this.settings = { ...this.settings, ...changes.settings.newValue };
          }
          if (info.watchedChanged) {
            // Raw storage format is { videoId: watchedAtMs }.
            const raw = changes.watched.newValue;
            this.watched = new Set(raw && typeof raw === "object" ? Object.keys(raw) : []);
          }
          if (info.seenChanged) {
            // Raw storage format is { id: [count, lastSeenMs] }.
            const raw = changes.seenCounts.newValue || {};
            const seen = new Map();
            for (const [id, entry] of Object.entries(raw)) {
              seen.set(id, Array.isArray(entry) ? entry[0] : entry);
            }
            this.seen = seen;
          }
          this._notify(info);
        });
        setInterval(() => this.refresh().catch(() => {}), 30_000);
        // Bounded retry for the cold-start race (see comment above): the
        // first fetch can hit a background page that is still starting up.
        // Retries are event-ish (short, finite, backoff) — not a "wait and
        // hope" timer; the moment one attempt succeeds, init completes.
        const RETRY_DELAYS_MS = [250, 1000, 3000];
        this._ready = (async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              await this.refresh();
              return;
            } catch (e) {
              if (attempt >= RETRY_DELAYS_MS.length) {
                console.warn("[FeedCleaner] initial state fetch failed", e);
                return;
              }
              console.warn(
                `[FeedCleaner] initial fetch attempt ${attempt + 1} failed, retrying`,
                e
              );
              await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            }
          }
        })();
      }
      return this._ready;
    },
  };

  return {
    CARD_SELECTOR,
    CARD_SELECTORS,
    SHELF_SELECTOR,
    IS_YOUTUBE_MUSIC,
    parseVideoIdFromUrl,
    extractVideoId,
    extractCardInfo,
    cleanUrl,
    parseDurationText,
    store,
    findPlayerVideo,
  };
})();
