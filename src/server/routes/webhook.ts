// Meta WhatsApp webhook. The canonical resilient shape:
//   1. GET  — subscription handshake (echo hub.challenge).
//   2. POST — verify HMAC over the RAW body, dedupe on message.id
//             (Meta retries aggressively), then RETURN 200 IMMEDIATELY and do
//             all real work in ctx.waitUntil() — Meta times out at ~20s and a
//             timeout means a redelivery storm.
import { Hono } from "hono";
import type { Env } from "../env";
import { verifyMetaSignature } from "../lib/signature";
import { handleInbound, type InboundMessage } from "../pipeline/inbound";

export const webhook = new Hono<{ Bindings: Env }>();

webhook.get("/", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token && token === c.env.META_VERIFY_TOKEN && challenge) {
    return c.text(challenge);
  }
  return c.text("forbidden", 403);
});

webhook.post("/", async (c) => {
  const rawBody = await c.req.text();

  const valid = await verifyMetaSignature(
    rawBody,
    c.req.header("x-hub-signature-256"),
    c.env.META_APP_SECRET,
  );
  if (!valid) return c.text("invalid signature", 401);

  const messages = extractTextMessages(rawBody);
  for (const msg of messages) {
    // Dedupe: Meta redelivers on any perceived failure.
    const dedupeKey = `msg:${msg.id}`;
    if (await c.env.DEDUPE.get(dedupeKey)) continue;
    await c.env.DEDUPE.put(dedupeKey, "1", { expirationTtl: 24 * 60 * 60 });

    c.executionCtx.waitUntil(handleInbound(c.env, msg));
  }

  // Always 200 — status callbacks (delivered/read) and unsupported types are
  // acked and ignored.
  return c.text("ok");
});

/** Pull plain text messages out of Meta's deeply nested webhook payload. */
function extractTextMessages(rawBody: string): InboundMessage[] {
  const out: InboundMessage[] = [];
  try {
    const payload = JSON.parse(rawBody) as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{ id?: string; from?: string; type?: string; text?: { body?: string } }>;
          };
        }>;
      }>;
    };
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          if (m.type === "text" && m.id && m.from && m.text?.body) {
            out.push({ id: m.id, from: m.from, text: m.text.body });
          }
        }
      }
    }
  } catch {
    // Malformed payload — ignore; we still ack.
  }
  return out;
}
