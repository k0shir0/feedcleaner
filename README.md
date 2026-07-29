# FeedCleaner

A privacy-focused Firefox (Manifest V3) extension:

- **Watched Video Filter** *(implemented)*: tracks videos you've
  watched, (or videos you have seen already on the youtube home page more than a certain amount of time) past a configurable threshold (default 80%) and hides their cards
  from the home feed, search results, watch-page sidebar, and channel pages, but you can configure the extension to show a placeholder instead of the repeat video.
- **Repeat Video Fixer** *(implemented)*: counts how often a card has been
  in your viewport (≥50% visible, once per page visit) and hides videos that
  keep reappearing unwatched — after 1 prior sighting by default,
  configurable 1–10 in settings. Hide decisions use sighting counts
  snapshotted at navigation time, so a card never vanishes while you're
  looking at it.
- **Link cleaner** *(implemented, on by default, toggleable)*: strips
  tracking parameters (`si=`, `feature=`, `pp=`, …) from YouTube links you
  copy on the page and from the share dialog. Functional params (`v`, `t`,
  `list`) are never touched.
- **Feed cleanup filters** *(implemented, all off by default)*: hide Shorts
  (shelves + cards), Mix/algorithmic playlist cards, live streams,
  premieres, videos shorter than N seconds, blocked channels
  (handle or display name), and title keyword/regex matches. Rule-hidden
  cards get a placeholder with a per-page-session "Show anyway".
- **Auto-purge** *(off by default)*: forget watched/seen entries older than
  N days (1–365) so the dedupe list can't grow forever.
- **Telemetry-beacon blocker** *(opt-in, off by default)*: a small static
  declarativeNetRequest ruleset ([dnr/yt-beacons.json](dnr/yt-beacons.json))
  blocks YouTube's playback/interaction telemetry (log_event, qoe, atr,
  ptracking, gen_204…). Watch-history reporting (`api/stats/watchtime`) is
  deliberately NOT blocked so your own YouTube history keeps working.
- **Module B — Ad / Tracker Blocker** *(designed, not active)*: static
  declarativeNetRequest rules generated from bundled filter lists at build
  time. See [docs/module-b-design.md](docs/module-b-design.md).

Zero telemetry. Zero runtime network requests. All data in
`browser.storage.local`, exportable/importable as a single JSON backup
(settings + watched list with dates + sighting counts).



## **The extension in action on the youtube home page**
<img width="1712" height="970" alt="image" src="https://github.com/user-attachments/assets/330fbdcc-68f8-4666-89d9-6d76fa6b4852" />

## **Even blocks shorts** 
<img width="1732" height="968" alt="image" src="https://github.com/user-attachments/assets/4e771367-623e-4ed0-a371-a4c58c3b5295" />

## **Example with no placeholder banners** 
<img width="1732" height="966" alt="image" src="https://github.com/user-attachments/assets/ec6b23d4-ca7f-4ae3-9731-40089ae7d96f" />



## Developer stuff below.

## Install (temporary, for development)

1. Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Pick `manifest.json` in this folder.

Or with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```
npx web-ext run --source-dir .
npx web-ext lint --source-dir .
npx web-ext build --source-dir .
```

Packaging is configured in `web-ext-config.mjs`: development-only files
(`filter-lists/`, `build/`, `docs/`, README, LICENSE) are excluded from the
built zip, per Mozilla's no-unused-files policy.

## Permissions — why each one is requested

| Permission | Why |
|---|---|
| `storage` | Watched-video map and settings in `storage.local`; the session hidden-counter in `storage.session`. |
| `clipboardWrite` | The share dialog's Copy button copies from YouTube's internal data model, not the visible input — this lets the link cleaner overwrite the clipboard with the cleaned URL right after. Only used inside that click flow. |
| `declarativeNetRequest` | The opt-in telemetry-beacon ruleset (`dnr/yt-beacons.json`, 8 static rules scoped to youtube.com initiators, disabled by default). No dynamic rules, no other sites. |

Content scripts run only on `*://www.youtube.com/*` and `*://m.youtube.com/*`
via `content_scripts.matches` — this needs no separate host permission grant.
Not requested: `tabs`, `webRequest`, host permissions, or anything else.

## Architecture

```
content/shared.js          all YouTube DOM assumptions (selectors, ID parsing,
                           card metadata extraction, URL cleaning)
content/url-privacy.js     copy/share tracking-param stripping
content/youtube-player.js  timeupdate watch tracking + SPA nav re-attachment
content/youtube-feed.js    MutationObserver → idle-batched card filtering
background/service-worker.js  message hub; the ONLY writer of storage;
                           auto-purge; DNR ruleset toggle
dnr/yt-beacons.json        opt-in telemetry-blocking ruleset (static, packaged)
popup/, settings/          UI; talk to background via messages
build/convert-filters.js   build-time ABP/uBO → DNR converter (Module B)
```

Message flow: content scripts send `VIDEO_PROGRESS` / `GET_WATCHED_IDS` /
`CARDS_HIDDEN` / `SEEN_BATCH` / `RESET_SEEN`; UI pages send `GET_STATE` /
`SET_SETTINGS` / `UNWATCH` / `CLEAR_WATCHED` / `IMPORT_WATCHED` /
`CLEAR_SEEN` / `GET_BACKUP` / `IMPORT_BACKUP`. Content scripts cache the
watched-ID set locally and refresh it via read-only `storage.onChanged` plus
a 30 s fallback poll — they never write storage directly.

Storage shapes: `watched` is `{ videoId: watchedAtMs }` (0.3.0 migrated the
old `watchedIds` string array in `onInstalled`; timestamps power the
auto-purge). `seenCounts` is `{ videoId: [count, lastSeenMs] }`.

### Notes that will save you a debugging session

- **YouTube's DOM is a moving target.** Every selector and href-parsing
  assumption lives in `content/shared.js` and nowhere else. When YouTube
  renames `ytd-rich-item-renderer`, fix one file.
- **Shorts loop.** `timeupdate` crosses the threshold on every loop; a
  per-page-session `reported` Set in `youtube-player.js` ensures one
  `VIDEO_PROGRESS` per video.
- **The background gets suspended.** It's an event page: every handler
  re-reads storage, nothing lives in memory, and the session counter is
  read-modify-written to `storage.session` on each increment.
- **A throwing background handler looks like "settings don't save."** Every
  UI reads state through `sendMessage`, so a handler that rejects just leaves
  the popup, the settings page, and the content-script cache sitting on their
  built-in defaults — writes still land in storage, they just can never be
  read back. The dispatcher logs `[FeedCleaner] <TYPE> handler failed`; check
  the background console (`about:debugging` → **Inspect**) before suspecting
  storage itself.

## Build pipeline (Module B)

```
node build/convert-filters.js
```

Reads `filter-lists/sources/*.txt` (ABP/uBO or hosts syntax), writes
`filter-lists/rules.json`, prints a per-list conversion report with per-reason
skip counts. The output is bundled but not loaded — the manifest gains
`declarativeNetRequest` only when Module B ships.

## Firefox vs Chrome MV3 divergences that shaped this code

1. **Background**: Firefox runs event-driven **background scripts**
   (`background.scripts`), not service workers. Chrome needs
   `background.service_worker`. A port would declare both keys.
2. **Namespace & promises**: this code uses Firefox's native promise-based
   `browser.*`. Chrome needs `chrome.*` or the
   `webextension-polyfill` shim.
3. **`browser_specific_settings.gecko.id`** is required for Firefox MV3
   signing/permanent install; Chrome ignores it.
4. **DNR limits**: Firefox guarantees 330,000 static rules; Chrome guarantees
   30,000 per ruleset plus a shared pool. The converter enforces the Firefox
   ceiling.
5. **Blocking webRequest** still works for signed Firefox MV3 extensions as a
   fallback; Chrome MV3 removed it. Module B deliberately targets DNR anyway.
6. **`storage.session`** needs Firefox ≥ 115 and `declarativeNetRequest`
   needs ≥ 113, but `strict_min_version` is **140** — the floor is set by
   `data_collection_permissions`, which Firefox ignores before 140. Mozilla's
   [data-consent guide](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
   recommends pinning the minimum rather than shipping a key older browsers
   silently drop.

## Privacy

- No external requests at runtime — filter lists convert at build time.
- No `eval`, no remote code; CSP locks extension pages to `'self'`.
- Export/Import of the watched list is a local JSON file, no cloud.
- Private browsing leaves no trace: if you enable the extension in private
  windows, filtering still works there, but watch progress and feed
  sightings from private tabs are never recorded (the background drops
  `VIDEO_PROGRESS` / `SEEN_BATCH` from incognito senders).
- Copied/shared YouTube links are cleaned of tracking params by default
  (disclosed in the AMO description; toggle in settings).
- Optional auto-purge forgets watched/seen entries older than N days.
- The telemetry-beacon blocker is opt-in and ships disabled; its ruleset is
  static, human-readable, and scoped to requests initiated by youtube.com.

## License

[MPL-2.0](LICENSE).
