/**
 * FeedCleaner E2E — real Firefox (stock, headless), extension installed for
 * real, driven through Mozilla's reference automation stack.
 *
 * Transport: geckodriver (devDependency; binary auto-cached to the OS temp
 * dir on first run). geckodriver speaks Marionette natively and exposes the
 * chrome-privileged bits this suite needs: add-on installation
 * (moz:addon/install), chrome-context script evaluation (to resolve the
 * moz-extension:// UUID), and normal page control.
 *
 * The suite drives the REAL user paths:
 *   - settings are changed by operating the actual settings-page controls
 *     (as a normal top-level document — Fission-safe, no chrome-context DOM
 *     reach-in), so every change flows UI event -> browser.runtime.sendMessage
 *     -> background handler -> storage.onChanged -> running content scripts;
 *   - effects are asserted in live YouTube / YouTube Music tabs.
 *
 * Covers:
 *   1. Bug #1 regression — blocking starts on an already-open tab with the
 *      popup never opened (pure storage-push initialization).
 *   2. Filter ON/OFF round-trip restores the feed exactly.
 *   3. YTM host policy — a catch-all title filter hides NOTHING on
 *      music.youtube.com (privacy-only there).
 *   4. Beacon DNR ruleset blocks/unblocks a telemetry endpoint live, with
 *      the request initiated FROM YouTube Music (proves initiatorDomains
 *      coverage for both hosts).
 *
 * Usage: node e2e/run.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const GECKODRIVER =
  process.env.GECKODRIVER_PATH ?? path.join(os.tmpdir(), "geckodriver-0.37.1.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(name, fn, { timeoutMs = 30000, intervalMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${name}) timed out: ${lastErr ?? "?"}`);
}

/** Tiny WebDriver HTTP client over geckodriver's local REST endpoint. */
class Driver {
  async req(method, path_, body) {
    const res = await fetch(this.base + path_, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.value && data.value.error)) {
      throw new Error(`${method} ${path_}: ${JSON.stringify(data.value ?? data).slice(0, 250)}`);
    }
    return data.value;
  }
  cmd(method, path_, body) {
    // Firefox-specific commands live under /moz/ (context, addon/install…).
    return this.req(method, `/session/${this.id}${path_}`, body);
  }

  /** Switch between "content" and "chrome" script contexts. */
  setContext(context) {
    return this.cmd("POST", "/moz/context", { context });
  }

  async start({ firefoxArgs, marionettePort, driverPort }) {
    // Launch Firefox OURSELVES (so we control privileged flags), then attach
    // geckodriver to the running instance (--connect-existing). geckodriver
    // 0.37+ refuses "-remote-allow-system-access" inside capabilities, but
    // chrome-context automation needs exactly that flag set on the browser.
    const base = `http://127.0.0.1:${driverPort}`;
    this.base = base;
    this.firefox = spawn(FIREFOX_BIN, firefoxArgs, { stdio: ["ignore", "ignore", "pipe"] });
    this.firefox.stderr.on("data", () => {});

    await waitFor("marionette up", async () => {
      await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port: marionettePort }, () => {
          s.destroy();
          resolve();
        });
        s.once("error", reject);
      });
    }, { timeoutMs: 45000 });

    this.child = spawn(GECKODRIVER, [
      "--port", String(driverPort),
      "--connect-existing",
      "--marionette-port", String(marionettePort),
    ], { stdio: "ignore" });

    await waitFor("geckodriver up", async () => {
      const res = await fetch(`${base}/status`);
      if (!res.ok) throw new Error("not up");
      return true;
    }, { timeoutMs: 20000 });

    const value = await this.req("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          acceptInsecureCerts: true,
        },
      },
    });
    this.id = value.sessionId;
    // Generous script timeout for async page scripts.
    await this.cmd("POST", "/timeouts", { script: 30000 });
    return this;
  }

  stop() {
    try {
      if (this.id) this.req("DELETE", `/session/${this.id}`).catch(() => {});
    } catch {}
    setTimeout(() => {
      try {
        this.child.kill();
      } catch {}
      try {
        this.firefox.kill();
      } catch {}
    }, 400);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ---- launch ---------------------------------------------------------------
if (!fs.existsSync(GECKODRIVER)) {
  console.error(`geckodriver binary not found at ${GECKODRIVER}`);
  console.error(`Run: node --input-type=module -e "import('geckodriver').then(m=>m.download())"`);
  process.exit(2);
}

const driverPort = await freePort();
const marionettePort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "feedcleaner-e2e-"));
fs.writeFileSync(
  path.join(profile, "user.js"),
  [
    `user_pref("marionette.port", ${marionettePort});`,
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("datareporting.healthreport.uploadEnabled", false);',
    "",
  ].join("\n")
);

const FIREFOX_BIN =
  process.env.FIREFOX_BIN ?? "C:/Program Files/Mozilla Firefox/firefox.exe";
const drv = await new Driver().start({
  firefoxArgs: [
    "-headless",
    "-no-remote",
    "-profile",
    profile,
    "-marionette",
    "-remote-allow-system-access",
  ],
  marionettePort,
  driverPort,
});
let exitCode = 1;

try {
  // ---- install the extension --------------------------------------------
  const addonId = await drv.req(
    "POST",
    `/session/${drv.id}/moz/addon/install`,
    { path: ROOT.replace(/\\/g, "/"), temporary: true }
  );
  console.log("addon installed:", addonId);
  if (!String(addonId).includes("feedcleaner")) throw new Error("unexpected addon id");

  // ---- chrome context + resolve moz-extension:// base --------------------
  await drv.setContext("chrome");
  const uuidRes = await waitFor("extension uuid", async () => {
    const r = await drv.cmd("POST", "/execute/sync", {
      script: `
        const raw = Services.prefs.getStringPref("extensions.webextensions.uuids", "{}");
        const map = JSON.parse(raw);
        const id = Object.keys(map).find((k) => k.includes("feedcleaner"));
        if (!id) { throw new Error("no uuid yet"); }
        return "moz-extension://" + map[id];
      `,
      args: [],
    });
    if (!String(r).startsWith("moz-extension://")) throw new Error(String(r));
    return r;
  }, { timeoutMs: 20000 });
  const EXT = uuidRes;
  console.log("ext base:", EXT);

  // ---- tab + eval helpers -------------------------------------------------
  /**
   * Chrome-scope eval (system principal). Only used for privileged lookups
   * (opening tabs); NEVER for reaching into content DOM — with Fission the
   * parent process has no contentDocument for out-of-process tabs.
   */
  const execChrome = async (script, args = []) => {
    await drv.setContext("chrome");
    return drv.cmd("POST", "/execute/sync", { script, args });
  };

  const handles = () => drv.cmd("GET", "/window/handles");

  async function switchTo(handle) {
    await drv.cmd("POST", "/window", { handle });
  }

  async function urlOf(handle) {
    await switchTo(handle);
    return String(await drv.cmd("GET", "/url"));
  }

  /** First tab whose URL starts with urlPrefix. */
  async function findTab(urlPrefix) {
    return waitFor(`tab ${urlPrefix}`, async () => {
      for (const h of await handles()) {
        try {
          if ((await urlOf(h)).startsWith(urlPrefix)) return h;
        } catch {}
      }
      throw new Error("not found yet");
    }, { timeoutMs: 15000, intervalMs: 400 });
  }

  let knownHandles = new Set(await handles());

  async function openTab(urlStr) {
    // Try the WebDriver way first.
    try {
      const { handle } = await drv.cmd("POST", "/window/new", { type: "tab" });
      await switchTo(handle);
      await drv.cmd("POST", "/url", { url: urlStr });
    } catch {
      await execChrome(
        `Services.wm.getMostRecentWindow("navigator:browser").openWebLinkIn(arguments[0], "tab");`,
        [urlStr]
      );
      await waitFor(`new tab for ${urlStr}`, async () => {
        const hs = await handles();
        const fresh = hs.find((h) => !knownHandles.has(h));
        if (!fresh) throw new Error("no new handle");
        knownHandles = new Set(hs);
        await switchTo(fresh);
        return fresh;
      });
    }
    await waitFor(`page load ${urlStr}`, async () => {
      const cur = String(await drv.cmd("GET", "/url"));
      if (!cur.startsWith(urlStr.split("?")[0])) throw new Error(cur);
      return cur;
    });
  }

  /**
   * Sync page-scope eval in a SPECIFIC tab (content context). This is how we
   * drive the settings page too — it is just a normal document to WebDriver.
   */
  async function evalIn(handle, script, args = []) {
    await switchTo(handle);
    await drv.setContext("content");
    return drv.cmd("POST", "/execute/sync", { script, args });
  }

  // ======================================================================
  // Tab A: youtube.com search results (signed-out friendly surface)
  // ======================================================================
  await drv.setContext("content");
  await drv.cmd("POST", "/url", {
    url: "https://www.youtube.com/results?search_query=lo+fi+hip+hop",
  });
  const ytHandle = await findTab("https://www.youtube.com/results");

  const cardProbe = () =>
    evalIn(
      ytHandle,
      `return (() => ({
        cards: document.querySelectorAll("ytd-video-renderer").length,
        hidden: document.querySelectorAll("[data-ytwash-state]").length,
      }))();`
    );

  await waitFor("yt search renders cards", async () => {
    const p = await cardProbe();
    if (!(p.cards >= 5)) throw new Error(JSON.stringify(p));
    return p;
  }, { timeoutMs: 60000 });
  const ytBefore = await cardProbe();
  record(
    "youtube.com search renders with extension installed, nothing hidden yet",
    ytBefore.cards >= 5 && ytBefore.hidden === 0,
    JSON.stringify(ytBefore)
  );

  // ======================================================================
  // Tab B: the REAL settings page, driven like any normal document
  // ======================================================================
  await openTab(`${EXT}/settings/settings.html`);
  const settingsHandle = await findTab(EXT);

  /** Run a script inside the settings page (content context). */
  const withSettings = (script, args = []) => evalIn(settingsHandle, script, args);

  await waitFor("settings page initialized", async () => {
    // loadState() populates inputs when GET_STATE answers.
    const ready = await withSettings(
      `return document.getElementById("threshold").value !== "";`
    );
    if (!ready) throw new Error("settings not hydrated");
    return true;
  }, { timeoutMs: 30000 });

  /** Save a keyword filter list through the REAL textarea+button. */
  function saveKeywords(lines) {
    return withSettings(
      `
      document.getElementById("keywordInput").value = arguments[0];
      document.getElementById("saveKeywords").click();
      return true;
      `,
      [lines.join("\n")]
    );
  }
  const keywordStatus = () =>
    withSettings(`return document.getElementById("keywordStatus").textContent;`);

  /** Flip a real checkbox on the real settings page. */
  const setCheckbox = (id, want) =>
    withSettings(
      `
      const cb = document.getElementById(arguments[0]);
      if (cb.checked !== arguments[1]) {
        cb.checked = arguments[1];
        cb.dispatchEvent(new Event("change"));
      }
      return cb.checked;
      `,
      [id, want]
    );

  const awaitSave = () =>
    waitFor("save confirmed", async () => {
      const s = await keywordStatus();
      if (!/^Saved/.test(s)) throw new Error(s);
      return s;
    }, { timeoutMs: 15000 });

  // ======================================================================
  // TEST 1+2 (Bug #1): push filtering to the already-open YouTube tab
  // ======================================================================
  await saveKeywords(["a"]); // catch-all: nearly every title contains "a"
  await awaitSave();

  // WITHOUT reloading the YouTube tab. If init is truly event-driven,
  // placeholders appear with zero popup/reload interaction.
  const ytHidden = await waitFor("catch-all filter lands on pre-existing tab", async () => {
    const p = await cardProbe();
    if (!(p.cards > 0 && p.hidden > 0)) throw new Error(JSON.stringify(p));
    return p;
  }, { timeoutMs: 25000 });
  record(
    "BUG #1: blocking starts automatically on an already-open tab (no popup, no reload)",
    ytHidden.hidden > 0,
    `${ytHidden.hidden}/${ytHidden.cards} filtered`
  );

  // ======================================================================
  // TEST 3: turning the filter OFF restores everything
  // ======================================================================
  await saveKeywords([]);
  await awaitSave();
  await waitFor("all cards restored", async () => {
    const p = await cardProbe();
    if (p.hidden !== 0) throw new Error(JSON.stringify(p));
    return p;
  }, { timeoutMs: 25000 });
  record("filter OFF restores every card exactly", true);

  // ======================================================================
  // TEST 4: YTM host policy under a fresh catch-all
  // ======================================================================
  await saveKeywords(["a"]);
  await awaitSave();

  await openTab("https://music.youtube.com/");
  const ytmHandle = await findTab("https://music.youtube.com");
  await sleep(6000); // several idle-pass cycles' worth of mutation handling
  const ytmProbe = await evalIn(ytmHandle, `return (() => ({
    app: !!document.querySelector("ytmusic-app"),
    items: document.querySelectorAll("ytmusic-two-row-item-renderer, ytmusic-responsive-list-item-renderer").length,
    touched: document.querySelectorAll("[data-ytwash-state], .ytwash-placeholder-host").length,
  }))();`);
  record(
    "YTM: catch-all filter hides NOTHING (privacy-only host policy)",
    ytmProbe.app === true && ytmProbe.touched === 0,
    `items=${ytmProbe.items}, touched=${ytmProbe.touched}`
  );

  // ======================================================================
  // TEST 5: beacon ruleset — blocked/unblocked live, initiated from YTM
  // ======================================================================
  const probeBeacon = async () => {
    await switchTo(ytmHandle);
    await drv.setContext("content");
    return drv.cmd("POST", "/execute/async", {
      script: `
        const done = arguments[arguments.length - 1];
        fetch("/generate_204?fc_e2e=1", { cache: "no-store" })
          .then(() => done("allowed"))
          .catch((e) => done("blocked:" + (e.message || "err")));
      `,
      args: [],
    });
  };

  const off1 = await probeBeacon();
  record("beacon endpoint reachable while ruleset disabled", off1 === "allowed", off1);

  await setCheckbox("beaconBlockEnabled", true);
  await sleep(1500); // SET_SETTINGS -> background -> updateEnabledRulesets
  const on = await probeBeacon();
  record(
    "ruleset blocks telemetry endpoint when enabled (from YTM initiator)",
    String(on).startsWith("blocked"),
    on
  );

  await setCheckbox("beaconBlockEnabled", false);
  await sleep(1500);
  const off2 = await probeBeacon();
  record("ruleset unblocks after disable", off2 === "allowed", off2);

  // ---- hygiene: leave settings as we found them ---------------------------
  await saveKeywords([]).catch(() => {});
  await setCheckbox("beaconBlockEnabled", false).catch(() => {});

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.error("HARNESS ERROR:", e);
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n==== E2E SUMMARY: ${pass}/${results.length} passed ====`);
  drv.stop();
  setTimeout(() => process.exit(exitCode), 700);
}
