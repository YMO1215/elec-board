import assert from "node:assert/strict";
import { test } from "node:test";

import { civilTwilight, clock, twilightText } from "../js/twilight.js";

// Reference values: api.sunrise-sunset.org civil_twilight_begin/end for 37.52N 126.96E, converted to KST (±1 min).
const REF = {
  "2026-03-20": ["06:09", "19:09"],
  "2026-06-21": ["04:40", "20:27"],
  "2026-09-23": ["05:54", "18:54"],
  "2026-10-14": ["06:12", "18:23"],
  "2026-12-21": ["07:13", "17:46"],
};
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

test("civil twilight matches the reference within a minute", () => {
  for (const [iso, [dawn, dusk]] of Object.entries(REF)) {
    const t = twilightText(iso);
    assert.ok(Math.abs(minutes(t.dawn) - minutes(dawn)) <= 1, `${iso} dawn ${t.dawn} vs ${dawn}`);
    assert.ok(Math.abs(minutes(t.dusk) - minutes(dusk)) <= 1, `${iso} dusk ${t.dusk} vs ${dusk}`);
  }
});

test("clock pads and rounds; no twilight at the pole in midsummer", () => {
  assert.equal(clock(5.4), "00:05");
  assert.equal(clock(371.6), "06:12");
  assert.equal(civilTwilight("2026-06-21", { lat: 89, lon: 0 }), null);
});

test("fetchTwilight converts the API's UTC times to KST and returns null on failure", async () => {
  const { fetchTwilight } = await import("../js/twilight.js");
  const ok = async () => ({ ok: true, json: async () => ({ status: "OK", results: {
    civil_twilight_begin: "2026-10-13T21:12:30+00:00", civil_twilight_end: "2026-10-14T09:23:10+00:00" } }) });
  assert.deepEqual(await fetchTwilight("2026-10-14", undefined, ok), { dawn: "06:13", dusk: "18:23" });
  assert.equal(await fetchTwilight("2026-10-14", undefined, async () => { throw new Error("offline"); }), null);
  assert.equal(await fetchTwilight("2026-10-14", undefined, async () => ({ ok: false })), null);
  assert.equal(await fetchTwilight("2026-10-14", undefined, async () => ({ ok: true, json: async () => ({ status: "INVALID_REQUEST" }) })), null);
});
