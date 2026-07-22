// Zero-dependency WhatsApp Cloud API client (Meta Graph API).
// Plain fetch — droppable into any Worker or Node project.
import type { Env } from "../env";

interface SendResponse {
  messages?: Array<{ id: string }>;
}

export class MetaApi {
  constructor(
    private accessToken: string,
    private phoneNumberId: string,
    private apiVersion = "v23.0",
  ) {}

  static fromEnv(env: Env): MetaApi | null {
    if (!env.META_ACCESS_TOKEN || !env.META_PHONE_NUMBER_ID) return null;
    return new MetaApi(env.META_ACCESS_TOKEN, env.META_PHONE_NUMBER_ID, env.META_API_VERSION);
  }

  private get baseUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`;
  }

  private async post(path: string, body: unknown): Promise<SendResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Meta API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as SendResponse;
  }

  sendTextMessage(to: string, text: string): Promise<SendResponse> {
    return this.post("/messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: true, body: text },
    });
  }

  /** Best-effort: mark inbound message read + show a typing indicator. */
  async markMessageAsRead(messageId: string): Promise<void> {
    try {
      await this.post("/messages", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      });
    } catch {
      // Non-fatal — never let read receipts break the reply path.
    }
  }
}
