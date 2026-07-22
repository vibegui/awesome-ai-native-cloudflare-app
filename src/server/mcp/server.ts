// A complete MCP server in ~150 lines: JSON-RPC 2.0 over POST, no SDK.
// Implements spec 2024-11-05 request/response (no SSE) — which is all that
// deco studio, Claude, Cursor, et al. need to list and call tools and render
// MCP-App UI resources.
import type { Env } from "../env";
import { track } from "../lib/track";
import { RESOURCES, readResource } from "./resources";
import { TOOLS, toolByName } from "./tools";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function reply(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function replyError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    // Human/debug-friendly descriptor. MCP itself is POST-only here.
    return Response.json({
      name: "awesome-ai-native-cloudflare-app",
      protocol: PROTOCOL_VERSION,
      tools: TOOLS.map((t) => t.name),
    });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = (await request.json()) as JsonRpcRequest;
  } catch {
    return replyError(null, -32700, "parse error");
  }

  switch (rpc.method) {
    case "initialize":
      return reply(rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "awesome-ai-native-cloudflare-app", version: "0.1.0" },
        instructions:
          "Notes + WhatsApp starter app. Use list_notes/add_note to manage notes, " +
          "get_status for a health snapshot, send_whatsapp_text to message a user.",
      });

    case "ping":
      return reply(rpc.id, {});

    case "tools/list":
      return reply(rpc.id, {
        tools: TOOLS.map(({ name, description, inputSchema, _meta }) => ({
          name,
          description,
          inputSchema,
          ...(_meta ? { _meta } : {}),
        })),
      });

    case "tools/call": {
      const params = rpc.params ?? {};
      const name = params.name as string | undefined;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = name ? toolByName[name] : undefined;
      if (!tool) return replyError(rpc.id, -32602, `unknown tool: ${name}`);
      try {
        await track(env, "mcp_tool_call", { dims: { tool: tool.name } });
        const out = await tool.execute(env, args);
        return reply(rpc.id, {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false,
        });
      } catch (err) {
        return reply(rpc.id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }

    case "resources/list":
      return reply(rpc.id, { resources: RESOURCES });

    case "resources/read": {
      const uri = (rpc.params?.uri ?? "") as string;
      const contents = readResource(uri);
      if (!contents) return replyError(rpc.id, -32602, `unknown resource: ${uri}`);
      return reply(rpc.id, { contents: [contents] });
    }

    case "prompts/list":
      return reply(rpc.id, { prompts: [] });

    default:
      return replyError(rpc.id, -32601, `method not found: ${rpc.method}`);
  }
}
