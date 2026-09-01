/**
 * Telemetry-beacon ruleset tests: pins dnr/yt-beacons.json against the
 * documented privacy contract — blocks verified telemetry endpoints from
 * BOTH YouTube hosts, never touches watch-time reporting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const rules = JSON.parse(readFileSync(path.join(ROOT, "dnr", "yt-beacons.json"), "utf8"));

test("ruleset parses and every rule is a well-formed block rule scoped to both hosts", () => {
  assert.ok(Array.isArray(rules) && rules.length > 0);
  const ids = new Set();
  for (const rule of rules) {
    assert.equal(rule.action.type, "block", rule.id);
    assert.equal(rule.priority, 1);
    assert.ok(typeof rule.condition.urlFilter === "string" && rule.condition.urlFilter.length > 0);
    assert.deepEqual(
      [...rule.condition.initiatorDomains].sort(),
      ["music.youtube.com", "youtube.com"],
      `rule ${rule.id} must be scoped to exactly youtube.com + music.youtube.com`
    );
    assert.ok(Array.isArray(rule.condition.resourceTypes) && rule.condition.resourceTypes.length > 0);
    ids.add(rule.id);
  }
  assert.equal(ids.size, rules.length, "rule ids must be unique");
});

test("blocks the verified telemetry endpoints", () => {
  const blocked = rules.map((r) => r.condition.urlFilter).join("\n");
  for (const endpoint of [
    "log_event",
    "api/stats/qoe",
    "api/stats/atr",
    "ptracking",
    "gen_204",
    "play.google.com/log",
  ]) {
    assert.ok(blocked.includes(endpoint), `missing endpoint: ${endpoint}`);
  }
});

test("watch-time reporting is deliberately NOT blocked (history stays intact)", () => {
  const blocked = rules.map((r) => r.condition.urlFilter).join("\n");
  assert.ok(!blocked.includes("watchtime"), "must not block api/stats/watchtime");
  assert.ok(!blocked.includes("api/stats/watch"));
});
