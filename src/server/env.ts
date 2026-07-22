// The Env contract. This file hand-mirrors wrangler.jsonc: if you add or
// remove a binding, var, or secret there, update this interface too.
// Secrets are optional (`?`) so the app degrades gracefully in dev when a
// feature's secrets aren't configured.
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  // Bindings (wrangler.jsonc)
  DB: D1Database;
  THREADS: KVNamespace;
  DEDUPE: KVNamespace;

  // Vars (wrangler.jsonc [vars])
  LLM_PROVIDER?: "openrouter" | "compat";
  LLM_MODEL?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
  META_API_VERSION?: string;
  META_PHONE_NUMBER_ID?: string;

  // Secrets (.dev.vars / wrangler secret put)
  MCP_AUTH_TOKEN?: string;
  ANALYTICS_SALT?: string;
  CF_AI_GATEWAY_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
}
