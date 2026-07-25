// Cross-filter analytics over the event stream (rows written by track.ts).
//
// One D1 read per call fetches the raw events in the window; every ranking is
// aggregated in JS. That is what makes cross-filtering free: any dimension can
// filter any other, including the ones that only exist inside the `dims` JSON
// (status, cache, user agent, ASN, colo, IP range) and would otherwise need a
// json_extract GROUP BY per dimension.
//
// The rule that makes the UI feel right: each ranking respects every active
// filter EXCEPT its own, so clicking "FR" in Countries filters the pages and
// referrers but leaves the country list whole to click through.

import type { Env } from "../env";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Table columns first, then the dimensions derived from the `dims` JSON. */
export const DIMENSIONS = [
  "name",
  "path",
  "country",
  "ref",
  "status",
  "cache",
  "browser",
  "os",
  "device",
  "asn",
  "ip",
  "colo",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type OverviewQuery = { days?: number } & Partial<
  Record<Dimension, string>
>;

type Event = Record<Dimension, string> & { day: string; visitor: string };

// user agent → browser / os / device. Bots first: curl and python match
// nothing else, and a "Chrome" bucket full of scrapers is a lie.
const BOT_RE =
  /bot|crawl|spider|scan|curl|wget|python|go-http|java\/|libwww|okhttp|headless/i;
const BROWSERS: Array<[RegExp, string]> = [
  [BOT_RE, "Bot"],
  [/edg\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/firefox\/|fxios/i, "Firefox"],
  [/chrome\/|crios/i, "Chrome"],
  [/safari\//i, "Safari"],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/android/i, "Android"],
  [/iphone|ipad|ios /i, "iOS"],
  [/mac os x|macintosh/i, "macOS"],
  [/windows/i, "Windows"],
  [/linux|ubuntu|debian/i, "Linux"],
];

function firstMatch(rules: Array<[RegExp, string]>, ua: string): string {
  for (const [re, label] of rules) if (re.test(ua)) return label;
  return "(?)";
}

function device(ua: string): string {
  if (BOT_RE.test(ua)) return "bot";
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobile|android|iphone/i.test(ua)) return "mobile";
  return ua ? "desktop" : "(?)";
}

/** Referrers are grouped by hostname; own traffic and empty become "(direct)". */
function refHostname(ref: string, ownHosts: Set<string>): string {
  try {
    const host = new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
    if (!host || ownHosts.has(host)) return "(direct)";
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return "(direct)";
    return host;
  } catch {
    return "(direct)";
  }
}

/** Each ranking ignores its own filter — that is the cross-filter contract. */
function matches(
  event: Event,
  query: OverviewQuery,
  except: Dimension | null,
): boolean {
  for (const dim of DIMENSIONS) {
    if (dim === except) continue;
    const wanted = query[dim];
    if (wanted && event[dim] !== wanted) return false;
  }
  return true;
}

type Bucket = { events: number; visitors: Set<string> };

function group(events: Event[], key: (e: Event) => string) {
  const map = new Map<string, Bucket>();
  for (const event of events) {
    const k = key(event);
    const bucket = map.get(k) ?? { events: 0, visitors: new Set() };
    bucket.events += 1;
    bucket.visitors.add(event.visitor);
    map.set(k, bucket);
  }
  return map;
}

function rank(map: Map<string, Bucket>, limit: number) {
  return [...map.entries()]
    .map(([key, bucket]) => ({
      key,
      events: bucket.events,
      visitors: bucket.visitors.size,
    }))
    .sort((a, b) => b.events - a.events)
    .slice(0, limit);
}

// Aggregating raw rows in JS is fine at this scale (thousands of events per
// window). If the window ever exceeds the cap, move the rankings back to SQL
// GROUP BY — the shape of the result is deliberately the same.
const MAX_EVENTS = 50_000;

export interface OverviewOptions {
  /** hosts whose referrals count as "(direct)" — the app's own origins */
  ownHosts?: string[];
}

export async function analyticsOverview(
  env: Env,
  query: OverviewQuery = {},
  options: OverviewOptions = {},
) {
  const days = Math.min(Math.max(query.days ?? 7, 1), 90);
  const since = Date.now() - days * DAY_MS;
  const ownHosts = new Set(
    (options.ownHosts ?? []).map((host) => host.toLowerCase()),
  );

  const { results } = await env.DB.prepare(
    `SELECT date(ts / 1000, 'unixepoch') AS day,
            name,
            coalesce(path, '(none)') AS path,
            coalesce(nullif(country, ''), '?') AS country,
            coalesce(dims, '{}') AS dims,
            coalesce(visitor, '') AS visitor
     FROM events WHERE ts >= ?
     ORDER BY ts DESC LIMIT ?`,
  )
    .bind(since, MAX_EVENTS)
    .all();

  const events: Event[] = (results as Array<Record<string, unknown>>).map(
    (row) => {
      let dims: Record<string, unknown> = {};
      try {
        dims = JSON.parse(String(row.dims)) as Record<string, unknown>;
      } catch {
        // a corrupt dims blob must not drop the event
      }
      const str = (value: unknown) =>
        typeof value === "string" && value ? value : "";
      const ua = str(dims.ua);
      return {
        day: String(row.day),
        name: String(row.name),
        path: String(row.path),
        country: String(row.country),
        ref: refHostname(str(dims.ref), ownHosts),
        status: dims.status ? String(dims.status) : "(?)",
        cache: str(dims.cache) || "(?)",
        browser: firstMatch(BROWSERS, ua),
        os: firstMatch(SYSTEMS, ua),
        device: device(ua),
        asn: dims.asn
          ? `AS${dims.asn}${dims.asOrg ? ` ${str(dims.asOrg)}` : ""}`
          : "(?)",
        ip: str(dims.ip) || "(?)",
        colo: str(dims.colo) || "(?)",
        visitor: String(row.visitor),
      };
    },
  );

  // daily series, stacked by event name, zero-filled so gaps read as gaps
  const scoped = events.filter((event) => matches(event, query, null));
  const byDay = new Map<string, Map<string, Bucket>>();
  for (const event of scoped) {
    const day = byDay.get(event.day) ?? new Map<string, Bucket>();
    const bucket = day.get(event.name) ?? { events: 0, visitors: new Set() };
    bucket.events += 1;
    bucket.visitors.add(event.visitor);
    day.set(event.name, bucket);
    byDay.set(event.day, day);
  }
  const series: Array<{
    day: string;
    names: Record<string, { events: number; visitors: number }>;
  }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    const names: Record<string, { events: number; visitors: number }> = {};
    for (const [name, bucket] of byDay.get(day) ?? []) {
      names[name] = { events: bucket.events, visitors: bucket.visitors.size };
    }
    series.push({ day, names });
  }

  const dimensions = {} as Record<Dimension, ReturnType<typeof rank>>;
  for (const dim of DIMENSIONS) {
    dimensions[dim] = rank(
      group(
        events.filter((event) => matches(event, query, dim)),
        (event) => event[dim],
      ),
      12,
    );
  }

  const filters = {} as Record<Dimension, string | null>;
  for (const dim of DIMENSIONS) filters[dim] = query[dim] ?? null;

  // Stable colour order for the stacked chart: ranked over the whole window
  // with NO filter applied, so a filter never repaints the surviving series.
  const seriesOrder = rank(
    group(events, (event) => event.name),
    8,
  ).map((row) => row.key);

  return {
    days,
    filters,
    seriesOrder,
    totals: {
      events: scoped.length,
      visitors: new Set(scoped.map((event) => event.visitor)).size,
    },
    series,
    dimensions,
  };
}
