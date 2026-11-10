// The smallest useful AI-native app: one Worker, one KV namespace, an MCP
// server at /mcp with three tools, and a page at /. No SDK, no framework.
// An agent connected through .mcp.json operates it; CLAUDE.md tells it how.

export interface Env {
  NOTES: KVNamespace;
  MCP_AUTH_TOKEN?: string;
}

type Note = { id: string; text: string; at: string };
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  run: (env: Env, args: Record<string, unknown>) => Promise<unknown>;
};

async function listNotes(env: Env): Promise<Note[]> {
  return (await env.NOTES.get<Note[]>("notes", "json")) ?? [];
}

const TOOLS: Tool[] = [
  {
    name: "list_notes",
    description: "List every note, newest first.",
    inputSchema: { type: "object", properties: {} },
    run: async (env) => listNotes(env),
  },
  {
    name: "add_note",
    description: "Add a note. Returns the note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: async (env, { text }) => {
      if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
      const note = { id: crypto.randomUUID().slice(0, 8), text: text.trim(), at: new Date().toISOString() };
      // ponytail: one KV key holds every note; move to D1 past a few hundred.
      await env.NOTES.put("notes", JSON.stringify([note, ...(await listNotes(env))]));
      return note;
    },
  },
  {
    name: "delete_note",
    description: "Delete a note by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (env, { id }) => {
      const notes = await listNotes(env);
      await env.NOTES.put("notes", JSON.stringify(notes.filter((n) => n.id !== id)));
      return { deleted: notes.length - (await listNotes(env)).length };
    },
  },
];

const rpc = (id: unknown, body: object) => Response.json({ jsonrpc: "2.0", id: id ?? null, ...body });

function authorized(req: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return false; // fail closed
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  return given === env.MCP_AUTH_TOKEN; // ponytail: plain compare; the full starter uses a constant-time one
}

async function mcp(req: Request, env: Env): Promise<Response> {
  // A 200 to GET reads as a dropped event stream and clients reconnect forever.
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
  if (!authorized(req, env)) return new Response("unauthorized", { status: 401 });
  const { id, method, params = {} } = (await req.json()) as { id?: unknown; method: string; params?: any };
  switch (method) {
    case "initialize":
      return rpc(id, {
        result: {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "minimal-notes", version: "0.1.0" },
        },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return rpc(id, { result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpc(id, { error: { code: -32602, message: `unknown tool: ${params.name}` } });
      try {
        const out = await tool.run(env, params.arguments ?? {});
        return rpc(id, { result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
      } catch (e) {
        return rpc(id, { result: { isError: true, content: [{ type: "text", text: String((e as Error).message) }] } });
      }
    }
    default:
      return rpc(id, { error: { code: -32601, message: `method not found: ${method}` } });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return mcp(req, env);
    const notes = await listNotes(env);
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
        `<title>Notes</title><body style="font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">` +
        `<h1>Notes</h1><ul>${notes.map((n) => `<li>${esc(n.text)}</li>`).join("") || "<li>No notes yet. Ask your agent to add one.</li>"}</ul>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
};
