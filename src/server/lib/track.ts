// First-party analytics — no GA, no PostHog, full Cloudflare.
// Events are rows in D1; the Worker itself is the collector. `track()` is
// fire-and-forget safe: analytics must never break the app.
//
// Instrumentation rule: every feature you ship gets at least one track()
// call, or the self-improvement loop is blind to it.
import type { Env } from "../env";

export interface TrackOpts {
  value?: number;
  path?: string;
  visitor?: string;
  country?: string;
  dims?: Record<string, string | number | boolean>;
}

export async function track(env: Env, name: string, opts: TrackOpts = {}): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO events (name, value, path, visitor, country, dims, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        name,
        opts.value ?? 1,
        opts.path ?? null,
        opts.visitor ?? null,
        opts.country ?? null,
        opts.dims ? JSON.stringify(opts.dims).slice(0, 512) : null,
        Date.now(),
      )
      .run();
  } catch (err) {
    console.error("track failed", err);
  }
}

/**
 * Cookieless daily unique-visitor id: SHA-256 of salt + day + ip + ua,
 * truncated. Rotates every UTC day, so it can count uniques but can never
 * track a person across days. Set ANALYTICS_SALT in production.
 */
export async function visitorHash(env: Env, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const ua = request.headers.get("user-agent") ?? "";
  const day = new Date().toISOString().slice(0, 10);
  const salt = env.ANALYTICS_SALT ?? "dev-salt";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${day}:${ip}:${ua}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Country code Cloudflare attaches to every request — free geo dimension. */
export function requestCountry(request: Request): string | undefined {
  return (request as Request & { cf?: { country?: string } }).cf?.country;
}

/** Visitor network without keeping a whole IP: /24 on v4, /48 on v6. */
function ipRange(ip: string): string | undefined {
  if (!ip) return undefined;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::/48`;
  const octets = ip.split(".");
  return octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : undefined;
}

/**
 * The dimensions Cloudflare's own analytics screen shows, captured per event:
 * referrer, user agent (browser/os/device are derived at query time), ASN and
 * its organization, colo, plus response status and cache state when there is a
 * response to read. The IP is reduced to a network range — enough to recognize
 * a scanner, never a person.
 */
export function requestDims(
  request: Request,
  response?: Response,
): Record<string, string | number | boolean> {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const dims: Record<string, string | number | boolean | undefined> = {
    ref: request.headers.get("referer")?.slice(0, 200) || undefined,
    ua: request.headers.get("user-agent")?.slice(0, 200) || undefined,
    asn: cf.asn ? String(cf.asn) : undefined,
    asOrg: typeof cf.asOrganization === "string" ? cf.asOrganization : undefined,
    colo: typeof cf.colo === "string" ? cf.colo : undefined,
    ip: ipRange(request.headers.get("cf-connecting-ip") ?? ""),
  };
  if (response) {
    dims.status = response.status;
    dims.cache = response.headers.get("cf-cache-status") ?? "n/a";
  }
  for (const key of Object.keys(dims)) {
    if (dims[key] === undefined) delete dims[key];
  }
  return dims as Record<string, string | number | boolean>;
}
