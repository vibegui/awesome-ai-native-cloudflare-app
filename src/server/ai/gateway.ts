// All LLM calls go through Cloudflare AI Gateway — one URL in front of every
// provider, giving you caching, rate limits, logs, spend tracking, and BYOK
// key storage without touching app code.
//
// Two modes, switched on env.LLM_PROVIDER:
//   "compat"     — OpenAI-shaped /compat endpoint, billed from your AI Gateway
//                  credit balance (one bill, any model).
//   "openrouter" — per-provider path; ship OPENROUTER_API_KEY yourself or
//                  store it in the Gateway (BYOK) and send no key at all.
import type { Env } from "../env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function chatCompletion(env: Env, messages: ChatMessage[]): Promise<ChatResult> {
  const account = env.AI_GATEWAY_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_NAME;
  if (!account || !gateway) throw new Error("AI Gateway is not configured");

  const provider = env.LLM_PROVIDER ?? "openrouter";
  const model = env.LLM_MODEL ?? "anthropic/claude-sonnet-4.5";
  const base = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`;

  const url =
    provider === "compat"
      ? `${base}/compat/chat/completions`
      : `${base}/openrouter/v1/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "compat") {
    headers.Authorization = `Bearer ${env.CF_AI_GATEWAY_TOKEN ?? ""}`;
  } else if (env.OPENROUTER_API_KEY) {
    // Omit entirely to use a key stored in the Gateway (BYOK).
    headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
      // Reasoning models can burn the whole token budget on hidden reasoning
      // and return an empty string. Keep reasoning off for chat replies.
      reasoning: { enabled: false },
    }),
  });
  if (!res.ok) throw new Error(`LLM call failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: ChatResult["usage"];
  };
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage,
  };
}
