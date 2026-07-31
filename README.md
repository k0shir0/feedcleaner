# FeedCleaner

Devlog:
Feed Cleaner is now PUBLIC on Firefox!!! You can download directly from Firefox here:
https://addons.mozilla.org/en-US/firefox/addon/feedcleaner/



- **Watched Video Filter**: tracks videos you've watched, or
  videos you have repeatedly seen in the YouTube home feed, then hides their
  cards after a configurable threshold (default 80%). It filters the home
  feed, search results, watch-page sidebar, and channel pages, but always
  leaves the YouTube History page untouched. You can configure a placeholder
  instead of hiding repeat videos outright.
- **Repeat Video Fixer**: counts how often a card has been
  in your viewport (≥50% visible, once per page visit) and hides videos that
  keep reappearing unwatched — after 1 prior sighting by default,
  configurable 1–10 in settings. Hide decisions use sighting counts
  snapshotted at navigation time, so a card never vanishes while you're
  looking at it.
- **Link cleaner**: strips
  tracking parameters (`si=`, `feature=`, `pp=`, …) from YouTube links you
  copy on the page and from the share dialog. Functional params (`v`, `t`,
  `list`) are never touched.
- **Feed cleanup filters**: hide Shorts
  (shelves + cards), Mix/algorithmic playlist cards, live streams,
  premieres, videos shorter than N seconds, blocked channels
  (handle or display name), and title keyword/regex matches. Rule-hidden
  cards get a placeholder with a per-page-session "Show anyway".
- **Auto-purge**: forget watched/seen entries older than
  N days (1–365) so the dedupe list can't grow forever.
- **Telemetry-beacon blocker** *(opt-in, off by default)*: a small static
  declarativeNetRequest ruleset ([dnr/yt-beacons.json](dnr/yt-beacons.json))
  blocks YouTube's playback/interaction telemetry (log_event, qoe, atr,
  ptracking, gen_204…). Watch-history reporting (`api/stats/watchtime`) is
  deliberately NOT blocked so your own YouTube history keeps working.

Zero telemetry. Zero runtime network requests. All data in
`browser.storage.local`, exportable/importable as a single JSON backup
(settings + watched list with dates + sighting counts).



## **The extension in action on the youtube home page**
<img width="1712" height="970" alt="image" src="https://github.com/user-attachments/assets/330fbdcc-68f8-4666-89d9-6d76fa6b4852" />

## **Even blocks shorts** 
<img width="1732" height="968" alt="image" src="https://github.com/user-attachments/assets/4e771367-623e-4ed0-a371-a4c58c3b5295" />

## **Example with no placeholder banners** 
<img width="1732" height="966" alt="image" src="https://github.com/user-attachments/assets/ec6b23d4-ca7f-4ae3-9731-40089ae7d96f" />





## Permissions — why each one is requested

| Permission | Why |
|---|---|
| `storage` | Watched-video map and settings in `storage.local`; the session hidden-counter in `storage.session`. |
| `clipboardWrite` | The share dialog's Copy button copies from YouTube's internal data model, not the visible input — this lets the link cleaner overwrite the clipboard with the cleaned URL right after. Only used inside that click flow. |
| `declarativeNetRequest` | The opt-in telemetry-beacon ruleset (`dnr/yt-beacons.json`, 8 static rules scoped to youtube.com initiators, disabled by default). No dynamic rules, no other sites. |

Content scripts run only on `*://www.youtube.com/*` via
`content_scripts.matches` — this needs no separate host permission grant.
Not requested: `tabs`, `webRequest`, host permissions, or anything else.

`m.youtube.com` is deliberately **not** matched. The mobile site builds its
feed from `ytm-*` custom elements and this codebase only knows the desktop
`ytd-*` / `yt-lockup-view-model` shapes, so injecting there bought nothing
but an extra origin. Supporting mobile means adding mobile selectors to
`content/shared.js` first, then re-adding the match — not the other way
round.

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
