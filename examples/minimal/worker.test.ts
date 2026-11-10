import { expect, test } from "bun:test";
import worker, { type Env } from "./worker.ts";

const store = new Map<string, string>();
const env = {
  MCP_AUTH_TOKEN: "t",
  OPENROUTER_API_KEY: "k",
  MODEL: "test/model",
  DATA: {
    get: async (k: string, type?: string) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)!) : store.get(k)) : null),
    put: async (k: string, v: string) => void store.set(k, v),
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  },
} as unknown as Env;

const mcp = (method: string, params?: object, token = "t") =>
  worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  );
const text = async (r: Response) => JSON.parse(((await r.json()) as any).result.content[0].text);

test("mcp: auth, tools, page", async () => {
  expect((await mcp("tools/list", {}, "wrong")).status).toBe(401);
  expect((await worker.fetch(new Request("https://x/mcp"), env)).status).toBe(405);
  const { result } = (await (await mcp("tools/list")).json()) as any;
  expect(result.tools.map((t: any) => t.name)).toEqual(["list_notes", "add_note", "delete_note", "list_conversations"]);
  const note = await text(await mcp("tools/call", { name: "add_note", arguments: { text: "hi <b>" } }));
  expect(await (await worker.fetch(new Request("https://x/"), env)).text()).toContain("hi &#60;b&#62;");
  expect(await text(await mcp("tools/call", { name: "delete_note", arguments: { id: note.id } }))).toEqual({ deleted: 1 });
});

test("chat: model calls a tool, admin shows it; chat can't delete", async () => {
  const replies = [
    { tool_calls: [{ id: "a", function: { name: "add_note", arguments: '{"text":"buy coffee"}' } }, { id: "b", function: { name: "delete_note", arguments: '{"id":"x"}' } }] },
    { content: "Added: buy coffee." },
  ];
  globalThis.fetch = (async () => Response.json({ choices: [{ message: replies.shift() }] })) as any;
  const r = await worker.fetch(new Request("https://x/chat", { method: "POST", body: JSON.stringify({ text: "add buy coffee" }) }), env);
  const conv = (await r.json()) as any;
  expect(conv.reply).toBe("Added: buy coffee.");
  expect(conv.steps[0].result.text).toBe("buy coffee");
  expect(conv.steps[1].result.error).toContain("not available in chat");
  expect((await worker.fetch(new Request("https://x/admin"), env)).status).toBe(401);
  const admin = await (await worker.fetch(new Request("https://x/admin?token=t"), env)).text();
  expect(admin).toContain("add buy coffee");
  expect(admin).toContain("add_note");
  expect(admin).toContain("Added: buy coffee.");
});
