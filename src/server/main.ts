// The whole app is one Worker:
//   GET  /            → the SPA (same single-file bundle the MCP host renders)
//   ALL  /mcp         → MCP server (bearer-gated) — register this URL in deco
//                       studio (Registry → Add MCP Server) as
//                       https://<worker>/mcp?token=<MCP_AUTH_TOKEN>
//   GET|POST /webhook → Meta WhatsApp webhook
//   GET  /healthz     → liveness probe
import { Hono } from "hono";
import type { Env } from "./env";
import { requireMcpAuth } from "./lib/auth";
import { appHtml } from "./mcp/resources";
import { handleMcp } from "./mcp/server";
import { webhook } from "./routes/webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/webhook", webhook);

app.use("/mcp", requireMcpAuth);
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

app.get("/", (c) => c.html(appHtml));

export default app;
