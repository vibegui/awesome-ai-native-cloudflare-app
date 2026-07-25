import { describe, expect, test } from "bun:test";
import { analyticsOverview } from "../src/server/lib/analytics";
import type { Env } from "../src/server/env";

const today = new Date().toISOString().slice(0, 10);

const rows = [
  {
    day: today,
    name: "pageview",
    path: "/",
    country: "FR",
    visitor: "v1",
    dims: JSON.stringify({
      ua: "Mozilla/5.0 (Macintosh) Chrome/126",
      asn: "15169",
      asOrg: "GOOGLE",
      colo: "CDG",
      ip: "8.8.8.0/24",
      status: 200,
      ref: "https://news.ycombinator.com/item?id=1",
    }),
  },
  {
    day: today,
    name: "pageview",
    path: "/notes",
    country: "BR",
    visitor: "v2",
    dims: JSON.stringify({ ua: "curl/8.4.0", status: 200 }),
  },
  {
    day: today,
    name: "blocked",
    path: "/.git/config",
    country: "FR",
    visitor: "v3",
    dims: JSON.stringify({ ua: "python-requests/2.31", status: 404 }),
  },
];

// Minimal D1 stand-in: analyticsOverview issues exactly one query.
const env = {
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
} as unknown as Env;

const keys = (list: Array<{ key: string }>) => list.map((row) => row.key);

describe("analyticsOverview", () => {
  test("derives browser, os, device and network from the dims blob", async () => {
    const all = await analyticsOverview(env, {});
    expect(keys(all.dimensions.browser).sort()).toEqual(["Bot", "Chrome"]);
    expect(all.dimensions.browser.find((row) => row.key === "Bot")?.events).toBe(2);
    expect(keys(all.dimensions.device)).toContain("bot");
    expect(keys(all.dimensions.asn)).toContain("AS15169 GOOGLE");
    expect(keys(all.dimensions.status).sort()).toEqual(["200", "404"]);
    expect(keys(all.dimensions.ref)).toContain("news.ycombinator.com");
  });

  test("own hosts count as direct traffic", async () => {
    const overview = await analyticsOverview(env, {}, { ownHosts: ["news.ycombinator.com"] });
    expect(keys(overview.dimensions.ref)).toEqual(["(direct)"]);
  });

  test("a filter narrows every other list but never its own", async () => {
    const fr = await analyticsOverview(env, { country: "FR" });
    expect(fr.totals.events).toBe(2);
    expect(keys(fr.dimensions.path).sort()).toEqual(["/", "/.git/config"]);
    // the country list ignores the country filter, so BR stays clickable
    expect(keys(fr.dimensions.country).sort()).toEqual(["BR", "FR"]);
  });

  test("filters compose across dimensions", async () => {
    const scan = await analyticsOverview(env, { country: "FR", name: "blocked" });
    expect(scan.totals.events).toBe(1);
    expect(keys(scan.dimensions.path)).toEqual(["/.git/config"]);
    // name list also keeps its siblings for one-click switching
    expect(keys(scan.dimensions.name).sort()).toEqual(["blocked", "pageview"]);
  });

  test("series is zero-filled over the window and stacked by event", async () => {
    const week = await analyticsOverview(env, { days: 7 });
    expect(week.series).toHaveLength(7);
    expect(week.series.at(-1)?.names.pageview).toEqual({ events: 2, visitors: 2 });
    expect(week.seriesOrder[0]).toBe("pageview");
  });
});
