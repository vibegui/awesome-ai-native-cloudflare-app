// MCP-App UI resources. Every ui:// URI returns the SAME single-file HTML
// bundle (built by Vite + vite-plugin-singlefile, imported as a string via
// the wrangler Text rule). The React app picks which view to render at
// runtime from hostContext.toolInfo.tool.name — one bundle, many views.
//
// NOTE: run `bun run build` (or `bun run dev:worker`) once before
// `wrangler dev`/`deploy` so dist/web/index.html exists.
import appHtml from "../../../dist/web/index.html";

const MIME = "text/html;profile=mcp-app";

export const RESOURCES = [
  {
    uri: "ui://app/dashboard",
    name: "Dashboard",
    description: "Notes dashboard and app status.",
    mimeType: MIME,
  },
];

export function readResource(uri: string): { uri: string; mimeType: string; text: string } | null {
  if (!uri.startsWith("ui://")) return null;
  return { uri, mimeType: MIME, text: appHtml };
}

export { appHtml };
