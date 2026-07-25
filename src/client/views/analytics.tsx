// Traffic view: what the event stream looks like from the outside.
//
// Two ideas carry the whole screen:
//  1. Cross-filter — every row in every list is a button. Click a country and
//     the pages, referrers and the chart follow it; the country list itself
//     stays whole (the server drops each list's own filter), so you can keep
//     clicking through. Click the same row again to clear it.
//  2. One stacked bar per day, coloured by event name. Colour follows the
//     event, never its rank: the server sends a stable seriesOrder computed
//     without filters, so filtering never repaints the survivors.
import { useCallback, useEffect, useState } from "react";
import { useCallTool } from "../context";

interface Row {
  key: string;
  events: number;
  visitors: number;
}

interface Overview {
  days: number;
  filters: Record<string, string | null>;
  seriesOrder: string[];
  totals: { events: number; visitors: number };
  series: Array<{
    day: string;
    names: Record<string, { events: number; visitors: number }>;
  }>;
  dimensions: Record<string, Row[]>;
}

const PANELS: Array<{ dim: string; title: string }> = [
  { dim: "name", title: "Events" },
  { dim: "path", title: "Pages" },
  { dim: "ref", title: "Sources" },
  { dim: "country", title: "Countries" },
  { dim: "browser", title: "Browser" },
  { dim: "os", title: "System" },
  { dim: "device", title: "Device" },
  { dim: "status", title: "HTTP status" },
  { dim: "cache", title: "Cache" },
  { dim: "asn", title: "Network (ASN)" },
  { dim: "ip", title: "IP range" },
  { dim: "colo", title: "Colo" },
];

const FILTER_LABEL: Record<string, string> = {
  name: "event",
  path: "page",
  ref: "source",
  country: "country",
  status: "status",
  cache: "cache",
  browser: "browser",
  os: "system",
  device: "device",
  asn: "network",
  ip: "IP",
  colo: "colo",
};

/** Five validated categorical slots; anything past them shares "other". */
const SLOTS = 5;
const slotVar = (index: number) =>
  index < SLOTS ? `var(--series-${index + 1})` : "var(--series-other)";

export function AnalyticsView() {
  const callTool = useCallTool();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"visitors" | "events">("visitors");

  const load = useCallback(
    async (args: Record<string, unknown>) => {
      try {
        const clean: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined && value !== null && value !== "") clean[key] = value;
        }
        setData(await callTool<Overview>("analytics_overview", clean, { navigate: false }));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [callTool],
  );

  useEffect(() => {
    void load({ days: 7 });
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="center muted">Reading the event stream…</p>;

  const active: Record<string, string> = {};
  for (const [dim, value] of Object.entries(data.filters)) if (value) active[dim] = value;

  const reload = (args: Record<string, unknown>) =>
    void load({ days: data.days, ...active, ...args });

  // clicking the same row again clears that dimension's filter
  const toggle = (dim: string, value: string) =>
    reload({ [dim]: active[dim] === value ? undefined : value });

  const perVisitor = data.totals.visitors
    ? (data.totals.events / data.totals.visitors).toFixed(1)
    : "—";

  return (
    <div className="analytics">
      <div className="pills">
        {[7, 30, 90].map((days) => (
          <button
            key={days}
            type="button"
            className={`pill ${data.days === days ? "active" : ""}`}
            onClick={() => reload({ days })}
          >
            {days}d
          </button>
        ))}
        {Object.entries(active).map(([dim, value]) => (
          <button
            key={dim}
            type="button"
            className="pill filter"
            title={`Clear ${FILTER_LABEL[dim] ?? dim} filter`}
            onClick={() => reload({ [dim]: undefined })}
          >
            {FILTER_LABEL[dim] ?? dim}: <strong>{value}</strong> ×
          </button>
        ))}
      </div>

      <div className="stat-row">
        <button
          type="button"
          className={`stat ${metric === "visitors" ? "active" : ""}`}
          onClick={() => setMetric("visitors")}
        >
          <strong>{data.totals.visitors.toLocaleString()}</strong>
          <span>visitors</span>
        </button>
        <button
          type="button"
          className={`stat ${metric === "events" ? "active" : ""}`}
          onClick={() => setMetric("events")}
        >
          <strong>{data.totals.events.toLocaleString()}</strong>
          <span>events</span>
        </button>
        <div className="stat static">
          <strong>{perVisitor}</strong>
          <span>events per visitor</span>
        </div>
      </div>

      <Timeline
        series={data.series}
        order={data.seriesOrder}
        metric={metric}
        onPick={(name) => toggle("name", name)}
      />

      <div className="panels">
        {PANELS.map(({ dim, title }) => {
          const rows = data.dimensions[dim] ?? [];
          if (rows.length === 0) return null;
          const max = Math.max(1, ...rows.map((row) => row.events));
          return (
            <section className="panel" key={dim}>
              <h3>{title}</h3>
              <ul>
                {rows.map((row) => (
                  <li key={row.key}>
                    <button
                      type="button"
                      className="panel-row"
                      aria-pressed={active[dim] === row.key}
                      onClick={() => toggle(dim, row.key)}
                      title={`${row.visitors.toLocaleString()} visitors`}
                    >
                      <span
                        className="panel-fill"
                        style={{ width: `${Math.max(2, (row.events / max) * 100)}%` }}
                      />
                      <span className="panel-label">{row.key || "—"}</span>
                      <strong>{row.events.toLocaleString()}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Timeline({
  series,
  order,
  metric,
  onPick,
}: {
  series: Overview["series"];
  order: string[];
  metric: "visitors" | "events";
  onPick: (name: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 180;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 22;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const GAP = 2;

  const slotOf = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? SLOTS : Math.min(index, SLOTS);
  };

  const days = series.map((day) => {
    const segments = order
      .map((name) => ({ name, value: day.names[name]?.[metric] ?? 0 }))
      .filter((segment) => segment.value > 0);
    const others = Object.entries(day.names)
      .filter(([name]) => !order.includes(name))
      .reduce((sum, [, value]) => sum + (value[metric] ?? 0), 0);
    if (others > 0) segments.push({ name: "other", value: others });
    return {
      day: day.day,
      segments,
      total: segments.reduce((sum, segment) => sum + segment.value, 0),
    };
  });

  const present = order.filter((name) =>
    days.some((day) => day.segments.some((segment) => segment.name === name)),
  );
  const max = Math.max(1, ...days.map((day) => day.total));
  const count = Math.max(1, days.length);
  const step = W / count;
  const barW = Math.max(3, Math.min(28, step - 2));
  const labelEvery = Math.ceil(count / 6);
  const hovered = hover !== null ? days[hover] : null;

  return (
    <div className="chart-wrap">
      <div className="legend">
        {present.map((name) => (
          <button key={name} type="button" onClick={() => onPick(name)} title={`Filter by ${name}`}>
            <i style={{ background: slotVar(slotOf(name)) }} />
            {name}
          </button>
        ))}
      </div>
      {hovered && (
        <div className="chart-tip" style={{ left: `${((hover! + 0.5) / count) * 100}%` }}>
          <strong>{hovered.day.slice(5)}</strong>
          {hovered.segments.map((segment) => (
            <span key={segment.name}>
              <i style={{ background: slotVar(slotOf(segment.name)) }} />
              {segment.name}: {segment.value.toLocaleString()}
            </span>
          ))}
          <em>
            {hovered.total.toLocaleString()} {metric}
          </em>
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={`${metric} per day, by event`}
        onMouseLeave={() => setHover(null)}
      >
        {[0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              className="grid"
              x1={0}
              x2={W}
              y1={PAD_TOP + plotH * (1 - fraction)}
              y2={PAD_TOP + plotH * (1 - fraction)}
            />
            <text
              className="axis"
              x={W - 4}
              y={PAD_TOP + plotH * (1 - fraction) - 4}
              textAnchor="end"
            >
              {Math.round(max * fraction).toLocaleString()}
            </text>
          </g>
        ))}
        <line className="baseline" x1={0} x2={W} y1={PAD_TOP + plotH} y2={PAD_TOP + plotH} />
        {days.map((day, index) => {
          const x = index * step + (step - barW) / 2;
          let cursor = PAD_TOP + plotH;
          return (
            <g key={day.day} opacity={hover === null || hover === index ? 1 : 0.55}>
              {day.segments.map((segment, segmentIndex) => {
                const h = Math.max(
                  1.5,
                  (segment.value / max) * (plotH - 4) - (segmentIndex > 0 ? GAP : 0),
                );
                const top = segmentIndex === day.segments.length - 1;
                const y = cursor - h - (segmentIndex > 0 ? GAP : 0);
                cursor = y;
                const r = Math.min(4, barW / 2, h);
                const d = top
                  ? `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`
                  : `M${x},${y + h} V${y} H${x + barW} V${y + h} Z`;
                return <path key={segment.name} d={d} fill={slotVar(slotOf(segment.name))} />;
              })}
              {index % labelEvery === 0 && (
                <text
                  className="axis"
                  x={index * step + step / 2}
                  y={H - 6}
                  textAnchor="middle"
                >
                  {day.day.slice(8)}
                </text>
              )}
              <rect
                className="hit"
                x={index * step}
                y={0}
                width={step}
                height={H}
                onMouseEnter={() => setHover(index)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
