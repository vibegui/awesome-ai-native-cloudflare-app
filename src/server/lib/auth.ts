// Bearer-token gate for /mcp. This single shared secret is the entire MCP
// security model: whoever holds the token is the owner.
//
// The token is accepted three ways for client compatibility:
//   1. `Authorization: Bearer <token>`  — standard MCP clients
//   2. `x-mcp-auth: <token>`            — clients that can't set Authorization
//   3. `?token=<token>`                 — hosts whose "Add MCP" dialog only
//                                          stores a URL (e.g. deco studio)
//
// Fails CLOSED: if MCP_AUTH_TOKEN is unset the endpoint returns 503 rather
// than running open. Set a throwaway token in .dev.vars for local dev.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export const requireMcpAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const secret = c.env.MCP_AUTH_TOKEN;
  if (!secret) {
    return c.json({ error: "MCP_AUTH_TOKEN is not configured" }, 503);
  }

  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const header = c.req.header("x-mcp-auth");
  const query = c.req.query("token");
  const provided = bearer ?? header ?? query;

  if (!provided || !timingSafeEqual(provided, secret)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
