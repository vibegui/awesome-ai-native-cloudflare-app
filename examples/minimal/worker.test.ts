import { expect, test } from "bun:test";
import worker, { type Env } from "./worker.ts";

const store = new Map<string, string>();
const env = {
  MCP_AUTH_TOKEN: "t",
  NOTES: {
    get: async (k: string, type?: string) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)!) : store.get(k)) : null),
    put: async (k: string, v: string) => void store.set(k, v),
  },
} as unknown as Env;

const call = (method: string, params?: object, token = "t") =>
  worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  );
const text = async (r: Response) => JSON.parse(((await r.json()) as any).result.content[0].text);

test("auth, tools and the page", async () => {
  expect((await call("tools/list", {}, "wrong")).status).toBe(401);
  expect((await worker.fetch(new Request("https://x/mcp"), env)).status).toBe(405);
  const { result } = (await (await call("tools/list")).json()) as any;
  expect(result.tools.map((t: any) => t.name)).toEqual(["list_notes", "add_note", "delete_note"]);
  const note = await text(await call("tools/call", { name: "add_note", arguments: { text: "hi <b>" } }));
  expect(await text(await call("tools/call", { name: "list_notes" }))).toHaveLength(1);
  expect(await (await worker.fetch(new Request("https://x/"), env)).text()).toContain("hi &#60;b&#62;");
  expect(await text(await call("tools/call", { name: "delete_note", arguments: { id: note.id } }))).toEqual({ deleted: 1 });
});
