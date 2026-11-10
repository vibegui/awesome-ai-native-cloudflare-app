// The smallest useful AI-native app: one Worker, one KV namespace.
//   /        notes + a chat; an LLM answers by calling the app's own tools
//   /admin   every conversation: what was said, which tools ran, the result
//   /mcp     the same tools for any agent (Claude Code via .mcp.json)
// No framework, no SDK. Business logic is the TOOLS list; every surface calls it.

export interface Env {
  DATA: KVNamespace;
  MCP_AUTH_TOKEN?: string; // gates /mcp and /admin
  OPENROUTER_API_KEY?: string; // the chat's model provider
  MODEL: string; // set in wrangler.jsonc, never in code
  LIMIT?: RateLimit; // per-IP budget in front of the paid model call
}

type Note = { id: string; text: string; at: string };
type Step = { tool: string; args: unknown; result: unknown };
type Conversation = { id: string; at: string; model: string; said: string; steps: Step[]; reply: string };
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  chat: boolean; // can the public chat call it? (deleting is for the owner only)
  run: (env: Env, args: Record<string, any>) => Promise<unknown>;
};

const listNotes = async (env: Env) => (await env.DATA.get<Note[]>("notes", "json")) ?? [];

async function listConversations(env: Env): Promise<Conversation[]> {
  const { keys } = await env.DATA.list({ prefix: "conv:", limit: 20 });
  const all = await Promise.all(keys.map((k) => env.DATA.get<Conversation>(k.name, "json")));
  return all.filter((c): c is Conversation => !!c).sort((a, b) => b.at.localeCompare(a.at));
}

const TOOLS: Tool[] = [
  {
    name: "list_notes",
    description: "List every note, newest first.",
    inputSchema: { type: "object", properties: {} },
    chat: true,
    run: (env) => listNotes(env),
  },
  {
    name: "add_note",
    description: "Add a note. Returns the note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    chat: true,
    run: async (env, { text }) => {
      if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
      const note = { id: crypto.randomUUID().slice(0, 8), text: text.trim().slice(0, 500), at: new Date().toISOString() };
      // ponytail: one KV key holds every note; move to D1 past a few hundred.
      await env.DATA.put("notes", JSON.stringify([note, ...(await listNotes(env))]));
      return note;
    },
  },
  {
    name: "delete_note",
    description: "Delete a note by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    chat: false,
    run: async (env, { id }) => {
      const notes = await listNotes(env);
      const kept = notes.filter((n) => n.id !== id);
      await env.DATA.put("notes", JSON.stringify(kept));
      return { deleted: notes.length - kept.length };
    },
  },
  {
    name: "list_conversations",
    description: "The last 20 chat conversations: what was said, tools called, reply.",
    inputSchema: { type: "object", properties: {} },
    chat: false,
    run: (env) => listConversations(env),
  },
];

// The agent: the model picks tools, we run them, up to 5 rounds, then save the log.
async function chat(env: Env, said: string): Promise<Conversation> {
  const tools = TOOLS.filter((t) => t.chat);
  const messages: any[] = [
    {
      role: "system",
      content: "You run a tiny notes app. Use the tools to read or add notes, then answer in one or two sentences, in the user's language.",
    },
    { role: "user", content: said },
  ];
  const steps: Step[] = [];
  let reply = "";
  for (let round = 0; round < 5 && !reply; round++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.MODEL,
        messages,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      }),
    });
    if (!res.ok) throw new Error(`model call failed: ${res.status}`);
    const msg = ((await res.json()) as any).choices?.[0]?.message;
    if (!msg) throw new Error("model returned no message");
    messages.push(msg);
    if (!msg.tool_calls?.length) reply = msg.content || "(no answer)";
    for (const call of msg.tool_calls ?? []) {
      const tool = tools.find((t) => t.name === call.function.name);
      let args: unknown = {};
      let result: unknown;
      try {
        args = JSON.parse(call.function.arguments || "{}");
        if (!tool) throw new Error(`tool not available in chat: ${call.function.name}`);
        result = await tool.run(env, args as Record<string, any>);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      steps.push({ tool: call.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  const conv = {
    id: crypto.randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    model: env.MODEL,
    said,
    steps,
    reply: reply || "(stopped after 5 rounds)",
  };
  // inverted timestamp in the key so KV's lexicographic list returns newest first
  await env.DATA.put(`conv:${9e15 - Date.now()}:${conv.id}`, JSON.stringify(conv), { expirationTtl: 60 * 60 * 24 * 30 });
  return conv;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return false; // fail closed
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  return given === env.MCP_AUTH_TOKEN; // ponytail: plain compare; the full starter uses a constant-time one
}

const rpc = (id: unknown, body: object) => Response.json({ jsonrpc: "2.0", id: id ?? null, ...body });

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
          serverInfo: { name: "minimal-notes", version: "0.2.0" },
        },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return rpc(id, { result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpc(id, { error: { code: -32602, message: `unknown tool: ${params.name}` } });
      try {
        const out = await tool.run(env, params.arguments ?? {});
        return rpc(id, { result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
      } catch (e) {
        return rpc(id, { result: { isError: true, content: [{ type: "text", text: (e as Error).message }] } });
      }
    }
    default:
      return rpc(id, { error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
      `<style>body{font:16px/1.5 system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}` +
      `pre{white-space:pre-wrap;background:#f4f4f5;padding:.5rem;border-radius:6px;font-size:13px}` +
      `form{display:flex;gap:.5rem}input{flex:1;font:inherit;padding:.5rem}button{font:inherit}.c{border-top:1px solid #ddd;padding:.75rem 0}</style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const CHAT_JS = `
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
f.onsubmit = async (e) => {
  e.preventDefault();
  const text = t.value;
  t.value = "";
  log.insertAdjacentHTML("beforeend", "<p><b>You:</b> " + esc(text) + "</p>");
  const r = await fetch("/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const c = await r.json();
  if (!r.ok) return log.insertAdjacentHTML("beforeend", "<p>" + esc(c.error) + "</p>");
  for (const s of c.steps) {
    log.insertAdjacentHTML("beforeend", "<pre>" + esc(s.tool + "(" + JSON.stringify(s.args) + ")") + "</pre>");
    if (s.tool === "add_note" && s.result.text) notes.insertAdjacentHTML("afterbegin", "<li>" + esc(s.result.text) + "</li>");
  }
  log.insertAdjacentHTML("beforeend", "<p><b>Agent:</b> " + esc(c.reply) + "</p>");
};`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return mcp(req, env);

    if (url.pathname === "/chat" && req.method === "POST") {
      if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("forbidden", { status: 403 });
      if (!env.OPENROUTER_API_KEY) return Response.json({ error: "chat is not configured" }, { status: 503 });
      const ip = req.headers.get("cf-connecting-ip") ?? "local";
      if (env.LIMIT && !(await env.LIMIT.limit({ key: ip })).success) return Response.json({ error: "slow down" }, { status: 429 });
      const { text } = (await req.json()) as { text?: string };
      if (!text?.trim()) return Response.json({ error: "say something" }, { status: 400 });
      try {
        return Response.json(await chat(env, text.trim().slice(0, 1000)));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    }

    if (url.pathname === "/admin") {
      if (!authorized(req, env)) return new Response("unauthorized: /admin?token=<MCP_AUTH_TOKEN>", { status: 401 });
      const convs = await listConversations(env);
      const steps = (s: Step[]) => s.map((x) => `<pre>${esc(x.tool)}(${esc(JSON.stringify(x.args))})\n→ ${esc(JSON.stringify(x.result))}</pre>`).join("");
      return page(
        "Admin",
        `<h1>Conversations</h1>` +
          (convs
            .map(
              (c) =>
                `<div class="c"><small>${esc(c.at)} · ${esc(c.model)}</small><p><b>User:</b> ${esc(c.said)}</p>${steps(c.steps)}<p><b>Agent:</b> ${esc(c.reply)}</p></div>`,
            )
            .join("") || "<p>No conversations yet.</p>"),
      );
    }

    const notes = await listNotes(env);
    return page(
      "Notes",
      `<h1>Notes</h1><ul id="notes">${notes.map((n) => `<li>${esc(n.text)}</li>`).join("")}</ul>` +
        `<h2>Chat</h2><div id="log"></div>` +
        `<form id="f"><input id="t" placeholder="add a note saying buy coffee" autocomplete="off"><button>Send</button></form>` +
        `<script>${CHAT_JS}</script>`,
    );
  },
};
