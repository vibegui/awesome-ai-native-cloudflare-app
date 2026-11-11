// Metrics tools: the app's first-party analytics over MCP, so an agent (or a
// human in Claude Code) reads real traffic before changing anything.
import type { Env } from "../env";
import { analyticsOverview, DIMENSIONS, type Dimension } from "../lib/analytics";
import type { ToolDef } from "./tools";

const DAY_MS = 24 * 60 * 60 * 1000;

// group_by values are mapped to SQL through this whitelist — never
// interpolate user input into SQL.
const GROUP_EXPRS: Record<string, string> = {
  day: "date(ts / 1000, 'unixepoch')",
  name: "name",
  path: "coalesce(path, '')",
  country: "coalesce(country, '')",
};

// Every dimension of the event stream is both a ranking and a filter, so the
// traffic view cross-filters: click a country, the pages and referrers follow,
// the country list stays whole.
const DIM_DESC: Record<Dimension, string> = {
  name: "event name (pageview, wa_message, blocked…)",
  path: "request path",
  country: "country, 2-letter ISO code",
  ref: "referrer hostname, or '(direct)'",
  status: "HTTP status of the response",
  cache: "cf-cache-status when available",
  browser: "browser derived from the user agent (Chrome, Safari, Bot…)",
  os: "operating system (macOS, iOS, Windows…)",
  device: "device class (desktop | mobile | tablet | bot)",
  asn: "visitor network: ASN + organization (e.g. 'AS15169 GOOGLE')",
  ip: "visitor IP range (/24 on v4, /48 on v6)",
  colo: "Cloudflare colo that served it (e.g. GRU)",
};

export const METRICS_TOOLS: ToolDef[] = [
  {
    name: "analytics_overview",
    _meta: { ui: { resourceUri: "ui://app/analytics" } },
    description:
      "Traffic dashboard over the event stream: totals, a daily series stacked by event name, " +
      "and rankings for path, country, referrer, HTTP status, cache, browser, OS, device, ASN, " +
      "IP range and colo. Every dimension doubles as a filter and each ranking ignores its own " +
      "filter, so dimensions cross-filter each other.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Trailing window in days (1-90, default 7)" },
        ...Object.fromEntries(
          DIMENSIONS.map((dim) => [
            dim,
            { type: "string", description: `Filter by ${DIM_DESC[dim]}` },
          ]),
        ),
      },
    },
    async execute(env, input) {
      const query: Record<string, unknown> = { days: Number(input.days) || undefined };
      for (const dim of DIMENSIONS) {
        if (typeof input[dim] === "string" && input[dim]) query[dim] = input[dim];
      }
      return analyticsOverview(env, query);
    },
  },
  {
    name: "metrics_query",
    description:
      "Aggregate the event stream. Filter by event name, group by day|name|path|country, " +
      "over a trailing window. Returns events count, summed value, and unique visitors per group.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name filter, e.g. 'pageview' (optional)" },
        since_days: { type: "number", description: "Trailing window in days (default 7, max 90)" },
        group_by: { type: "string", enum: ["day", "name", "path", "country"], description: "Default 'day'" },
      },
    },
    async execute(env, input) {
      const sinceDays = Math.min(Math.max(Number(input.since_days) || 7, 1), 90);
      const groupBy = String(input.group_by ?? "day");
      const expr = GROUP_EXPRS[groupBy];
      if (!expr) throw new Error(`group_by must be one of: ${Object.keys(GROUP_EXPRS).join(", ")}`);
      const since = Date.now() - sinceDays * DAY_MS;
      const name = input.name ? String(input.name) : null;

      const sql =
        `SELECT ${expr} AS key, COUNT(*) AS events, SUM(value) AS value, ` +
        "COUNT(DISTINCT visitor) AS uniques FROM events WHERE ts >= ? " +
        (name ? "AND name = ? " : "") +
        "GROUP BY key ORDER BY key";
      const stmt = env.DB.prepare(sql);
      const { results } = await (name ? stmt.bind(since, name) : stmt.bind(since)).all();
      return { since_days: sinceDays, group_by: groupBy, name, rows: results };
    },
  },
];
