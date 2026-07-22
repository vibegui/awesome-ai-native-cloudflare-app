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
