/**
 * Test-only loader for FeedCleaner content scripts.
 *
 * Runs the REAL extension sources unmodified inside a fresh vm context per
 * environment (classic-script semantics, so the cross-file `YTWash` global
 * works exactly like it does in the browser), backed by a minimal fake DOM
 * that implements only the selector vocabulary the extension actually uses
 * (tag / #id / .class / [attr], [attr=v], [attr*=v], [attr^=v],
 * descendant, `>`, `:scope`).
 *
 * Zero dependencies: Node's built-in test runner + assert only.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentFile = (name) => path.join(ROOT, "content", name);

/* ------------------------------- fake DOM ------------------------------- */

class FakeStyle {
  setProperty(k, v) {
    this[k] = v;
  }
  removeProperty(k) {
    delete this[k];
  }
}

export class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.style = new FakeStyle();
    this._text = "";
  }

  get className() {
    return this.attrs.class || "";
  }
  set className(v) {
    this.attrs.class = String(v);
  }

  get classList() {
    const el = this;
    const read = () => (el.attrs.class || "").split(/\s+/).filter(Boolean);
    return {
      add(...cs) {
        const s = new Set(read());
        for (const c of cs) s.add(c);
        el.attrs.class = [...s].join(" ");
      },
      remove(...cs) {
        const s = new Set(read());
        for (const c of cs) s.delete(c);
        el.attrs.class = [...s].join(" ");
      },
      contains(c) {
        return read().includes(c);
      },
    };
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v);
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }

  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }

  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }

  addEventListener(type, fn) {
    (this._listeners ??= []).push(fn);
  }
  removeEventListener() {}

  querySelector(sel) {
    return querySelectorAll(this, sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    return querySelectorAll(this, sel);
  }
}

/* --------------------------- selector engine ---------------------------- */

function freshCompound() {
  return { tag: null, id: null, classes: [], attrs: [], scope: false };
}

function addToCompound(compound, token) {
  let m;
  if (token === ":scope") {
    compound.scope = true;
  } else if ((m = /^#([\w-]+)$/.exec(token))) {
    compound.id = m[1];
  } else if ((m = /^\.([\w-]+)$/.exec(token))) {
    compound.classes.push(m[1]);
  } else if ((m = /^\[([^\]~=^$*|]+)(?:([~^$*|]?=)(.*))?\]$/.exec(token))) {
    const value = m[3] === undefined ? null : m[3].replace(/^["']|["']$/g, "");
    compound.attrs.push({ name: m[1], op: m[2] || null, value });
  } else if (/^[A-Za-z][\w-]*$/.test(token) && compound.tag === null) {
    compound.tag = token.toLowerCase();
  } else {
    throw new Error(`unsupported selector token: ${token}`);
  }
}

function parseSequence(s) {
  const tokens = s.match(/:scope|>|[^\s>]+/g) || [];
  const seq = [];
  let compound = freshCompound();
  let pendingCombinator = null;
  for (const token of tokens) {
    if (token === ">") {
      pendingCombinator = ">";
      continue;
    }
    // A whitespace-free token can itself be a full compound
    // ("ytd-rich-shelf-renderer[is-shorts]") — decompose it into pieces.
    const parts = token.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:scope|[A-Za-z][\w-]*/g) || [];
    if (parts.join("") !== token) throw new Error(`unsupported selector token: ${token}`);
    if (hasContent(compound)) {
      seq.push({ combinator: seq.length === 0 ? null : pendingCombinator || " ", compound });
      compound = freshCompound();
      pendingCombinator = null;
    }
    for (const part of parts) addToCompound(compound, part);
  }
  if (hasContent(compound)) {
    seq.push({ combinator: seq.length === 0 ? null : pendingCombinator || " ", compound });
  }
  return seq;
}

function hasContent(c) {
  return c.tag !== null || c.id !== null || c.classes.length > 0 || c.attrs.length > 0 || c.scope;
}

function parseSelectorList(sel) {
  return sel.split(",").map((s) => s.trim()).filter(Boolean).map(parseSequence);
}

function attrValue(el, name) {
  if (name in el.attrs) return el.attrs[name];
  // data-* attributes read through dataset in this fake DOM, mirroring the
  // real platform (production code writes card.dataset.ytwashState).
  if (name.startsWith("data-")) {
    const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    return el.dataset[key];
  }
  return undefined;
}

function matchCompound(el, compound, scope) {
  if (compound.scope && el !== scope) return false;
  if (compound.tag && el.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && el.attrs.id !== compound.id) return false;
  for (const c of compound.classes) if (!el.classList.contains(c)) return false;
  for (const a of compound.attrs) {
    const v = attrValue(el, a.name);
    if (v === undefined) return false;
    if (a.op === "=" && String(v) !== a.value) return false;
    if (a.op === "*=" && !String(v).includes(a.value)) return false;
    if (a.op === "^=" && !String(v).startsWith(a.value)) return false;
  }
  return true;
}

function matchSequence(el, seq, scope) {
  let node = el;
  for (let i = seq.length - 1; i >= 0; i--) {
    const { combinator, compound } = seq[i];
    if (!matchCompound(node, compound, scope)) return false;
    if (i > 0) {
      if (combinator === ">") {
        node = node.parentNode;
        if (!node) return false;
      } else {
        // Descendant: climb until some ancestor matches the previous
        // compound; backtracking across alternatives is out of scope for
        // the selectors this codebase uses.
        let ancestor = node.parentNode;
        while (ancestor && !(ancestor.tagName && matchCompound(ancestor, seq[i - 1].compound, scope))) {
          ancestor = ancestor.parentNode;
        }
        if (!ancestor) return false;
        node = ancestor;
      }
    }
  }
  return true;
}

export function querySelectorAll(root, selector) {
  const alternatives = parseSelectorList(selector);
  const results = [];
  const walk = (el) => {
    for (const child of [...el.children]) {
      if (alternatives.some((seq) => matchSequence(child, seq, root))) results.push(child);
      walk(child);
    }
  };
  walk(root);
  return results;
}

/* ----------------------------- fake browser ----------------------------- */

export function makeBrowser(sendImpl) {
  const sent = [];
  const impl = sendImpl || ((msg) => {
    sent.push(msg);
    return Promise.resolve({});
  });
  const sendMessage = (msg) => impl(msg);
  sendMessage._sent = sent;
  return {
    runtime: {
      sendMessage,
      onMessage: { addListener() {} },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };
}

/* ------------------------------ environment ----------------------------- */

/**
 * Load content/shared.js (+ optionally youtube-feed.js) into a FRESH vm
 * context with fake browser/DOM globals, apply the given initial store
 * state, and return handles to everything the tests need.
 */
export function loadFeedEnvironment({
  settings = {},
  watched = [],
  seen = {}, // { videoId: count } or { videoId: [count, ts] }
  pathname = "/",
  loadFeedModule = true,
  extraModules = [], // e.g. ["still-watching.js"] — loaded after state is applied
  sendMessageImpl,
} = {}) {
  const document = makeDocument();
  const window = {
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
  };
  // Real timers, but the 30 s fallback poll must never keep Node alive.
  const setIntervalUnrefed = (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  };
  const setTimeoutUnrefed = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  };
  const browser = makeBrowser(sendMessageImpl);

  const sandbox = {
    console,
    document,
    window,
    location: { pathname, href: "https://www.youtube.com/", origin: "https://www.youtube.com" },
    browser,
    // WHATWG globals are per-context in Node's vm — inject what the
    // extension code uses (cleanUrl's `new URL`, URLSearchParams).
    URL,
    URLSearchParams,
    // Test-hook flag consumed by youtube-feed.js (exposes decision internals).
    __FEEDCLEANER_TEST__: true,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    setInterval: setIntervalUnrefed,
    clearInterval,
    // Idle-callback fallbacks use setTimeout(..., 50); unref them so pending
    // passes from one test can't leak async activity into the next.
    setTimeoutUnrefed,
    requestIdleCallback: undefined, // exercise the setTimeout fallback path
  };
  vm.createContext(sandbox);

  const run = (file) =>
    vm.runInContext(readFileSync(contentFile(file), "utf8"), sandbox, { filename: `content/${file}` });

  run("shared.js");
  // `const YTWash` is lexically scoped inside the context's script realm and
  // never lands on the global object — re-export it explicitly.
  vm.runInContext("globalThis.__YTWash__ = YTWash;", sandbox, { filename: "export-ytwash.js" });
  const YTWash = sandbox.__YTWash__;
  const store = YTWash.store;

  const applyState = () => {
    store.settings = { ...store.settings, ...settings };
    store.watched = new Set(watched);
    store.seen = normalizeSeen(seen);
  };

  if (loadFeedModule) {
    // Pre-satisfy ready() BEFORE the feed module loads, so its
    // store.ready().then(init) chain runs against known state instead of
    // wiring the polling/messaging machinery.
    applyState();
    store._ready = Promise.resolve();
    run("youtube-feed.js");
  } else {
    applyState();
  }

  if (extraModules.length > 0) {
    store._ready = Promise.resolve();
    for (const file of extraModules) {
      vm.runInContext(readFileSync(contentFile(file), "utf8"), sandbox, {
        filename: `content/${file}`,
      });
    }
  }

  return { YTWash, store, api: sandbox.__FEEDCLEANER_TEST_API__ ?? null, browser, document, window, sandbox };
}

/** Load ONLY shared.js with full store wiring (for cold-start retry tests). */
export function loadStoreEnvironment({ sendMessageImpl } = {}) {
  const { YTWash, browser, document, sandbox } = loadFeedEnvironment({
    loadFeedModule: false,
    sendMessageImpl,
  });
  return { store: YTWash.store, browser, document, sandbox, YTWash };
}

function normalizeSeen(seen) {
  const m = new Map();
  const entries =
    seen instanceof Map ? [...seen.entries()] : Object.entries(seen ?? {});
  for (const [id, v] of entries) m.set(id, Array.isArray(v) ? v[0] : v);
  return m;
}

export function makeDocument() {
  const body = new FakeElement("body");
  return {
    body,
    documentElement: new FakeElement("html"),
    createElement: (tag) => new FakeElement(tag),
    querySelector: (sel) => querySelectorAll(body, sel)[0] ?? null,
    querySelectorAll: (sel) => querySelectorAll(body, sel),
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
  };
}

/** Build a realistic classic-shape feed card for filtering tests. */
export function makeCard({
  id = "dQw4w9WgXcQ",
  href,
  title = "Some Video Title",
  channelName = "Example Channel",
  channelHref = "/@examplechannel",
  duration = "4:20",
  badgeText,
} = {}) {
  const card = new FakeElement("ytd-rich-item-renderer");
  const anchor = new FakeElement("a");
  anchor.setAttribute("href", href ?? `/watch?v=${id}`);
  card.appendChild(anchor);

  const titleEl = new FakeElement("div");
  titleEl.setAttribute("id", "video-title");
  titleEl.textContent = title;
  card.appendChild(titleEl);

  const chanWrap = new FakeElement("ytd-channel-name");
  const chanLink = new FakeElement("a");
  chanLink.setAttribute("href", channelHref);
  chanLink.textContent = channelName;
  chanWrap.appendChild(chanLink);
  card.appendChild(chanWrap);

  const badge = new FakeElement("ytd-thumbnail-overlay-time-status-renderer");
  badge.textContent = badgeText ?? duration;
  card.appendChild(badge);

  return card;
}
