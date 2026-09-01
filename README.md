# FeedCleaner is now PUBLISHED! 
Feed Cleaner is now PUBLIC on Firefox!!! You can download directly from Firefox here:
https://addons.mozilla.org/en-US/firefox/addon/feedcleaner/




--- README BELOW --- 
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
  tracking parameters (`si=`, `feature=`, `pp=`, `utm_*`, …) from YouTube
  links you copy on the page and from the share dialog. Functional params
  (`v`, `t`, `list`) are never touched.
- **Feed cleanup filters**: hide Shorts
  (shelves + cards), Mix/algorithmic playlist cards, live streams,
  premieres, videos shorter than N seconds, blocked channels
  (handle or display name), and title keyword/regex matches. Rule-hidden
  cards get a placeholder with a per-page-session "Show anyway".
- **Auto-purge**: forget watched/seen entries older than
  N days (1–365) so the dedupe list can't grow forever.
- **"Are you still watching?" bypass** *(opt-in, off by default)*: answers
  YouTube's "Video paused. Continue watching?" and YouTube Music's
  "Are you still there?" inactivity dialogs by clicking Continue, exactly as
  a user would — no preemptive event tampering. Mind the trade-off: playback
  keeps running when you walk away (bandwidth/battery).
- **Telemetry-beacon blocker** *(opt-in, off by default)*: a small static
  declarativeNetRequest ruleset ([dnr/yt-beacons.json](dnr/yt-beacons.json))
  blocks YouTube's playback/interaction telemetry (log_event, qoe, atr,
  ptracking, gen_204, api/stats/ads…). Watch-history reporting
  (`api/stats/watchtime`) is deliberately NOT blocked so your own YouTube
  history keeps working.

Zero telemetry. Zero runtime network requests. All data in
`browser.storage.local`, exportable/importable as a single JSON backup
(settings + watched list with dates + sighting counts).

## YouTube Music policy

`music.youtube.com` is covered for **privacy features only**:

- **Active there:** link cleaning, the opt-in telemetry-beacon blocker, and
  the "Are you still watching?" bypass.
- **Never active there:** feed filtering and watch tracking. Listening to a
  song on YouTube Music does not mark the matching video watched on YouTube,
  and no card is ever hidden on YouTube Music.
- This is enforced in code (`IS_YOUTUBE_MUSIC` in `content/shared.js`;
  the feed and player modules exit early on that host) rather than by
  trusting desktop selectors to never match YouTube Music markup, and pinned
  by `tests/ytm-policy.test.mjs`.



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
| `declarativeNetRequest` | The opt-in telemetry-beacon ruleset (`dnr/yt-beacons.json`, 9 static rules scoped to youtube.com + music.youtube.com initiators, disabled by default). No dynamic rules, no other sites. |
| `host_permissions` (`youtube.com`) | Scoped strictly to YouTube and YouTube Music domains to allow continuous feed filtering without requiring click-to-run activation. |

### Note on Firefox Permissions ("Always Allow on YouTube")

In modern Firefox (Manifest V3), extensions default to **"Only When Clicked"** for your security until site access is approved.

This means you can use FeedCleaner in two ways:
- **On-Demand**: Click the FeedCleaner icon on your toolbar whenever you visit YouTube to activate filtering for that session.
- **Always-On (Recommended)**: If you want FeedCleaner to automatically filter watched videos the moment YouTube opens without needing a click:
  1. Right-click the FeedCleaner icon on YouTube and select **"Always Allow on www.youtube.com"**, OR
  2. Open the FeedCleaner **Settings** page and click **"Check / Grant Access"**.

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
content/still-watching.js  opt-in "Are you still watching?" auto-dismisser
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
  static, human-readable, and scoped to requests initiated by YouTube's own
  domains (`youtube.com` / `music.youtube.com`).

## License

[MPL-2.0](LICENSE).
