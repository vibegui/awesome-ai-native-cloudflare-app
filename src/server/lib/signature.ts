// Meta webhook signature verification (X-Hub-Signature-256).
// Meta signs every POST with HMAC-SHA256 over the RAW body using your app
// secret. Verify before parsing; reject on mismatch. If the secret is unset
// we accept (local dev), because Meta can't reach localhost anyway.
import { timingSafeEqual } from "./auth";

export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!appSecret) return true; // dev mode — no secret configured
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(signatureHeader.slice("sha256=".length), expected);
}
