"use strict";

const $ = (id) => document.getElementById(id);
const MAX_LIST_ROWS = 200;

const BOOL_SETTINGS = [
  "placeholderMode",
  "showLabel",
  "repeatEnabled",
  "stripLinks",
  "beaconBlockEnabled",
  "stillWatchingEnabled",
  "hideShorts",
  "hideMixes",
  "hideLive",
  "hidePremieres",
];

let watchedIds = [];
let currentSettings = {};

/* ------------------------------- rendering ------------------------------ */

async function loadState() {
  const [{ settings }, { watchedIds: ids }] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_STATE" }),
    browser.runtime.sendMessage({ type: "GET_WATCHED_IDS" }),
  ]);
  watchedIds = ids;
  currentSettings = settings;

  $("threshold").value = String(Math.round(settings.threshold * 100));
  $("thresholdValue").textContent = `${Math.round(settings.threshold * 100)}%`;
  for (const id of BOOL_SETTINGS) $(id).checked = settings[id];
  $("repeatThreshold").value = String(settings.repeatThreshold);
  $("repeatThresholdValue").textContent = formatTimes(settings.repeatThreshold);
  $("purgeDays").value = String(settings.purgeDays);
  $("minDurationSec").value = String(settings.minDurationSec);

  // Don't clobber the textarea mid-edit.
  if (document.activeElement !== $("keywordInput")) {
    $("keywordInput").value = (settings.keywordFilters || []).join("\n");
  }

  renderChannelList();
  renderList();
}

function renderChannelList() {
  const list = $("channelList");
  list.textContent = "";
  for (const channel of currentSettings.blockedChannels || []) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.textContent = channel;
    li.appendChild(name);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      const next = (currentSettings.blockedChannels || []).filter((c) => c !== channel);
      browser.runtime.sendMessage({ type: "SET_SETTINGS", settings: { blockedChannels: next } });
    });
    li.appendChild(del);

    list.appendChild(li);
  }
}

function renderList() {
  const query = $("search").value.trim().toLowerCase();
  const matches = query ? watchedIds.filter((id) => id.toLowerCase().includes(query)) : watchedIds;

  $("watchedCount").textContent = `(${watchedIds.length})`;

  const list = $("watchedList");
  list.textContent = "";
  for (const id of matches.slice(0, MAX_LIST_ROWS)) {
    const li = document.createElement("li");

    const link = document.createElement("a");
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = id;
    li.appendChild(link);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "UNWATCH", videoId: id });
      // storage.onChanged listener below re-renders.
    });
    li.appendChild(del);

    list.appendChild(li);
  }

  const note = $("listNote");
  if (watchedIds.length === 0) {
    note.textContent = "No watched videos recorded yet.";
  } else if (matches.length > MAX_LIST_ROWS) {
    note.textContent = `Showing ${MAX_LIST_ROWS} of ${matches.length} matches — refine your search.`;
  } else if (query) {
    note.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}.`;
  } else {
    note.textContent = "";
  }
}

function formatTimes(n) {
  return `${n} time${n === 1 ? "" : "s"}`;
}

/* ------------------------------- settings ------------------------------- */

$("repeatThreshold").addEventListener("input", () => {
  $("repeatThresholdValue").textContent = formatTimes(Number($("repeatThreshold").value));
});

$("repeatThreshold").addEventListener("change", () => {
  browser.runtime.sendMessage({
    type: "SET_SETTINGS",
    settings: { repeatThreshold: Number($("repeatThreshold").value) },
  });
});

$("clearSeen").addEventListener("click", async () => {
  if (!confirm("Forget all sighting counts? Videos will only be hidden again after they reappear.")) return;
  await browser.runtime.sendMessage({ type: "CLEAR_SEEN" });
});

$("threshold").addEventListener("input", () => {
  $("thresholdValue").textContent = `${$("threshold").value}%`;
});

$("threshold").addEventListener("change", () => {
  browser.runtime.sendMessage({
    type: "SET_SETTINGS",
    settings: { threshold: Number($("threshold").value) / 100 },
  });
});

for (const id of BOOL_SETTINGS) {
  $(id).addEventListener("change", (e) => {
    browser.runtime.sendMessage({ type: "SET_SETTINGS", settings: { [id]: e.target.checked } });
  });
}

for (const id of ["purgeDays", "minDurationSec"]) {
  $(id).addEventListener("change", (e) => {
    const value = Number(e.target.value);
    if (Number.isFinite(value)) {
      browser.runtime.sendMessage({ type: "SET_SETTINGS", settings: { [id]: value } });
    }
  });
}

/* ------------------------- channel & title filters ---------------------- */

function addChannel() {
  const entry = $("channelInput").value.trim();
  if (!entry) return;
  $("channelInput").value = "";
  const next = [...(currentSettings.blockedChannels || []), entry];
  browser.runtime.sendMessage({ type: "SET_SETTINGS", settings: { blockedChannels: next } });
}

$("addChannel").addEventListener("click", addChannel);
$("channelInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addChannel();
  }
});

$("saveKeywords").addEventListener("click", async () => {
  const lines = $("keywordInput")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const invalid = [];
  for (const line of lines) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    if (!m) continue;
    try {
      new RegExp(m[1], m[2]);
    } catch {
      invalid.push(line);
    }
  }

  await browser.runtime.sendMessage({ type: "SET_SETTINGS", settings: { keywordFilters: lines } });
  $("keywordStatus").textContent = invalid.length
    ? `Saved — but ${invalid.length} invalid regex line${invalid.length === 1 ? "" : "s"} will be ignored: ${invalid.join(", ")}`
    : `Saved ${lines.length} filter${lines.length === 1 ? "" : "s"}.`;
});

/* ----------------------------- list actions ----------------------------- */

$("search").addEventListener("input", renderList);

$("clearAll").addEventListener("click", async () => {
  if (watchedIds.length === 0) return;
  if (!confirm(`Delete all ${watchedIds.length} watched video IDs? This cannot be undone.`)) return;
  await browser.runtime.sendMessage({ type: "CLEAR_WATCHED" });
});

$("exportBtn").addEventListener("click", async () => {
  const payload = await browser.runtime.sendMessage({ type: "GET_BACKUP" });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `feedcleaner-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-importing the same file
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    alert(`Import failed: not valid JSON (${err.message}).`);
    return;
  }

  const mode = $("importReplace").checked ? "replace" : "merge";

  // Full backup (0.3.0+).
  if (parsed && parsed.format === "feedcleaner/backup") {
    const result = await browser.runtime.sendMessage({ type: "IMPORT_BACKUP", data: parsed, mode });
    if (result.error) {
      alert(`Import failed: ${result.error}`);
    } else {
      alert(
        `Backup imported: ${result.settingsApplied} settings applied, ` +
          `${result.watchedCount} watched videos, ${result.seenCount} sighting counts.`
      );
    }
    return;
  }

  // Legacy watched-list file: a bare ID array or { watchedIds: [...] }.
  const ids = Array.isArray(parsed) ? parsed : parsed && parsed.watchedIds;
  if (!Array.isArray(ids)) {
    alert("Import failed: not a FeedCleaner backup or watched-list file.");
    return;
  }
  const result = await browser.runtime.sendMessage({ type: "IMPORT_WATCHED", ids, mode });
  if (result.error) {
    alert(`Import failed: ${result.error}`);
  } else {
    alert(
      `Imported ${result.imported} IDs (${result.skipped} invalid entries skipped). ` +
        `List now has ${result.watchedCount} videos.`
    );
  }
});

/* ------------------------------ live updates ---------------------------- */

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.watched || changes.settings)) loadState();
});

loadState();
