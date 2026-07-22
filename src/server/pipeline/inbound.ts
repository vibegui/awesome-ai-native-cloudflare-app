// The inbound WhatsApp pipeline. Runs inside ctx.waitUntil() AFTER the
// webhook has already returned 200 — errors are logged, never thrown.
//
// Thread state lives in KV as a JSON document keyed t:<phone>:<YYYY-MM-DD>,
// capped at 30 turns with a 30-day TTL. Daily rollover keeps documents small;
// no database required for conversation state.
import { chatCompletion, type ChatMessage } from "../ai/gateway";
import type { Env } from "../env";
import { MetaApi } from "../services/meta";
import systemPrompt from "../../../prompts/system.md";

const MAX_TURNS = 30;
const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60;

interface Turn {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface InboundMessage {
  id: string;
  from: string; // phone, digits only
  text: string;
}

function threadKey(phone: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `t:${phone}:${day}`;
}

export async function handleInbound(env: Env, msg: InboundMessage): Promise<void> {
  const meta = MetaApi.fromEnv(env);
  if (!meta) {
    console.warn("inbound message ignored: WhatsApp not configured");
    return;
  }

  try {
    await meta.markMessageAsRead(msg.id);

    const key = threadKey(msg.from);
    const turns = ((await env.THREADS.get(key, "json")) as Turn[] | null) ?? [];

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...turns.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: msg.text },
    ];

    let reply: string;
    try {
      const result = await chatCompletion(env, messages);
      reply = result.content.trim() || "Sorry, I could not come up with a reply. Try again?";
    } catch (err) {
      console.error("LLM failed", err);
      reply = "Sorry, something went wrong on my side. Please try again in a moment.";
    }

    await meta.sendTextMessage(msg.from, reply);

    const now = Date.now();
    const newTurns: Turn[] = [
      { role: "user", content: msg.text, ts: now },
      { role: "assistant", content: reply, ts: now },
    ];
    const updated = [...turns, ...newTurns].slice(-MAX_TURNS);
    await env.THREADS.put(key, JSON.stringify(updated), { expirationTtl: THREAD_TTL_SECONDS });
  } catch (err) {
    // Never rethrow out of waitUntil — Meta already got its 200.
    console.error("inbound pipeline failed", err);
  }
}
