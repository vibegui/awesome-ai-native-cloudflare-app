// The tool registry: a plain array of objects. Adding a tool = push one
// object. Schemas are hand-written JSON Schema (what the MCP wire format
// wants anyway). Tools call the same functions your REST routes would —
// the MCP endpoint is a live control plane over the running app.
//
// `_meta.ui.resourceUri` links a tool to an MCP-App view (see resources.ts):
// hosts that support MCP Apps (deco studio) render that view in an iframe
// with the tool's result preloaded.
import type { Env } from "../env";
import { MetaApi } from "../services/meta";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: { ui?: { resourceUri: string } };
  execute(env: Env, input: Record<string, unknown>): Promise<unknown>;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  created_at: number;
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_status",
    description: "Health snapshot: note count and which integrations are configured.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://app/dashboard" } },
    async execute(env) {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
      return {
        ok: true,
        notes: row?.n ?? 0,
        whatsappConfigured: Boolean(env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID),
        llmConfigured: Boolean(env.CF_AI_GATEWAY_TOKEN || env.OPENROUTER_API_KEY),
      };
    },
  },
  {
    name: "list_notes",
    description: "List the most recent notes (newest first, max 50).",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://app/dashboard" } },
    async execute(env) {
      const { results } = await env.DB.prepare(
        "SELECT id, title, body, created_at FROM notes ORDER BY created_at DESC LIMIT 50",
      ).all<Note>();
      return { notes: results };
    },
  },
  {
    name: "add_note",
    description: "Create a note.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short note title" },
        body: { type: "string", description: "Note body (optional)" },
      },
      required: ["title"],
    },
    _meta: { ui: { resourceUri: "ui://app/dashboard" } },
    async execute(env, input) {
      const title = String(input.title ?? "").trim();
      if (!title) throw new Error("title is required");
      const note: Note = {
        id: crypto.randomUUID(),
        title,
        body: String(input.body ?? ""),
        created_at: Date.now(),
      };
      await env.DB.prepare("INSERT INTO notes (id, title, body, created_at) VALUES (?, ?, ?, ?)")
        .bind(note.id, note.title, note.body, note.created_at)
        .run();
      return { created: note };
    },
  },
  {
    name: "delete_note",
    description: "Delete a note by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async execute(env, input) {
      const result = await env.DB.prepare("DELETE FROM notes WHERE id = ?")
        .bind(String(input.id))
        .run();
      return { deleted: result.meta.changes === 1 };
    },
  },
  {
    name: "send_whatsapp_text",
    description: "Send a WhatsApp text message to a phone number (E.164, digits only).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient phone, e.g. 15551234567" },
        text: { type: "string", description: "Message body" },
      },
      required: ["to", "text"],
    },
    async execute(env, input) {
      const meta = MetaApi.fromEnv(env);
      if (!meta) throw new Error("WhatsApp is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID)");
      const res = await meta.sendTextMessage(String(input.to), String(input.text));
      return { sent: true, messageId: res.messages?.[0]?.id };
    },
  },
];

export const toolByName: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);
