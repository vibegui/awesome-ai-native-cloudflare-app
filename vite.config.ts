import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The SPA builds to ONE self-contained HTML file (all CSS/JS inlined).
// The Worker imports that file as a string and serves it both at `/` and as
// every `ui://` MCP resource — so the same bundle renders inside deco studio's
// sandboxed iframe and standalone in a browser.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "dist/web" },
  resolve: {
    alias: { "@": new URL("./src/client", import.meta.url).pathname },
  },
  server: {
    host: true,
    // Lets the dev server be proxied/embedded during studio development.
    allowedHosts: [".decocms.com", "localhost"],
    proxy: {
      "/mcp": "http://localhost:8787",
      "/webhook": "http://localhost:8787",
      "/api": "http://localhost:8787",
    },
  },
});
