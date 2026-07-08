import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readR2Config,
  isR2Configured,
  normalizeKey,
  r2PublicUrl,
  r2PresignPut,
} from "@/lib/storage/r2";

const R2_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"];

function setR2(overrides: Record<string, string | undefined> = {}) {
  const base = {
    R2_ACCOUNT_ID: "acct123",
    R2_ACCESS_KEY_ID: "AKIATEST",
    R2_SECRET_ACCESS_KEY: "secret123",
    R2_BUCKET: "the-frame-media",
    R2_PUBLIC_BASE_URL: "https://media.getjaxy.com",
  };
  for (const k of R2_ENV) {
    const v = k in overrides ? overrides[k] : (base as Record<string, string>)[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("R2 config + key helpers", () => {
  afterEach(() => {
    for (const k of R2_ENV) delete process.env[k];
  });

  it("is dormant until every required var is set", () => {
    for (const k of R2_ENV) delete process.env[k];
    expect(isR2Configured()).toBe(false);
    expect(readR2Config()).toBeNull();

    // partial config stays dormant (safety — never half-enable)
    process.env.R2_ACCOUNT_ID = "acct123";
    process.env.R2_ACCESS_KEY_ID = "AKIATEST";
    expect(isR2Configured()).toBe(false);
  });

  it("reads full config; public base is optional and trimmed", () => {
    setR2({ R2_PUBLIC_BASE_URL: "https://media.getjaxy.com/" });
    const cfg = readR2Config()!;
    expect(cfg).toMatchObject({ accountId: "acct123", bucket: "the-frame-media" });
    expect(cfg.publicBaseUrl).toBe("https://media.getjaxy.com"); // trailing slash stripped
  });

  it("normalizes keys (no leading slash, forward slashes)", () => {
    expect(normalizeKey("/images/a.jpg")).toBe("images/a.jpg");
    expect(normalizeKey("videos\\clips\\raw\\x.mp4")).toBe("videos/clips/raw/x.mp4");
  });

  it("builds public URLs from the CDN base, or the app proxy when private", () => {
    setR2();
    expect(r2PublicUrl("images/x.jpg")).toBe("https://media.getjaxy.com/images/x.jpg");
    setR2({ R2_PUBLIC_BASE_URL: undefined });
    expect(r2PublicUrl("images/x.jpg")).toBe("/api/media/images/x.jpg");
  });
});

describe("R2 presigned upload URL", () => {
  beforeEach(() => setR2());
  afterEach(() => {
    for (const k of R2_ENV) delete process.env[k];
  });

  it("produces a signed PUT URL with the SigV4 query params", async () => {
    const url = await r2PresignPut("videos/sources/abc.mp4", "video/mp4", 900);
    expect(url).toContain("acct123.r2.cloudflarestorage.com/the-frame-media/videos/sources/abc.mp4");
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=900");
    expect(url).toContain("X-Amz-Credential=");
  });
});
