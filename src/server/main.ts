// The whole app is one Worker:
//   GET  /            → the SPA (same single-file bundle the MCP host renders)
//   ALL  /mcp         → MCP server (bearer-gated) — register this URL in deco
//                       studio (Registry → Add MCP Server) as
//                       https://<worker>/mcp?token=<MCP_AUTH_TOKEN>
//   POST /e           → first-party analytics beacon (client-side events)
//   GET|POST /webhook → Meta WhatsApp webhook
//   GET  /healthz     → liveness probe
//   scheduled()       → daily event pruning (90-day retention)
import { Hono } from "hono";
import type { Env } from "./env";
import { requireMcpAuth } from "./lib/auth";
import { requestCountry, track, visitorHash } from "./lib/track";
import { appHtml } from "./mcp/resources";
import { handleMcp } from "./mcp/server";
import { webhook } from "./routes/webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/webhook", webhook);

app.use("/mcp", requireMcpAuth);
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

// First-party event beacon. Public by design (like any analytics endpoint):
// inputs are validated and size-capped, and writes are fire-and-forget.
// From the client: navigator.sendBeacon("/e", JSON.stringify({ name: "cta_click" }))
app.post("/e", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false }, 400);
  }
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 64 || !/^[a-z0-9_.:-]+$/i.test(name)) {
    return c.json({ ok: false, error: "invalid event name" }, 400);
  }
  const request = c.req.raw;
  c.executionCtx.waitUntil(
    (async () => {
      await track(c.env, name, {
        value: typeof body.value === "number" && Number.isFinite(body.value) ? body.value : 1,
        path: typeof body.path === "string" ? body.path.slice(0, 256) : undefined,
        dims:
          body.dims && typeof body.dims === "object"
            ? (body.dims as Record<string, string | number | boolean>)
            : undefined,
        visitor: await visitorHash(c.env, request),
        country: requestCountry(request),
      });
    })(),
  );
  return c.json({ ok: true });
});

app.get("/", (c) => {
  const request = c.req.raw;
  c.executionCtx.waitUntil(
    (async () => {
      await track(c.env, "pageview", {
        path: "/",
        visitor: await visitorHash(c.env, request),
        country: requestCountry(request),
      });
    })(),
  );
  return c.html(appHtml);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(cutoff).run();
  },
};
