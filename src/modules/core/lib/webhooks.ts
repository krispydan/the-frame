import { createHmac, timingSafeEqual } from "crypto";

export type WebhookPayload = {
  provider: string;
  headers: Record<string, string>;
  body: string;
  parsedBody: unknown;
};

export type WebhookHandler = (payload: WebhookPayload) => Promise<{ ok: boolean; message?: string }>;

class WebhookRegistry {
  private handlers = new Map<string, WebhookHandler>();

  register(provider: string, handler: WebhookHandler) {
    this.handlers.set(provider, handler);
  }

  getHandler(provider: string): WebhookHandler | undefined {
    return this.handlers.get(provider);
  }

  listProviders(): string[] {
    return Array.from(this.handlers.keys());
  }
}

export const webhookRegistry = new WebhookRegistry();

// ── Signature Verification ──

export function verifyShopifyHmac(body: string, signature: string, secret: string): boolean {
  const hash = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function verifyGenericHmac(body: string, signature: string, secret: string, algorithm = "sha256"): boolean {
  const hash = createHmac(algorithm, secret).update(body, "utf8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Test webhook handler (for health checks) ──
webhookRegistry.register("test", async (payload) => {
  return { ok: true, message: `Test webhook received at ${new Date().toISOString()}` };
});
