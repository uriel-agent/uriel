import { describe, expect, it } from "vitest";

import {
  signPayloadSha256,
  verifyGitHubSignature,
  verifyLinearSignature,
  verifySlackSignature,
  verifyTwilioSignature
} from "../packages/core/src/index.ts";

const encoder = new TextEncoder();

describe("webhook signatures", () => {
  it("signs payloads that verify as GitHub-style SHA-256 signatures", async () => {
    const body = "{\"job\":\"completed\"}";
    const signature = await signPayloadSha256("callback-secret", body);
    await expect(
      verifyGitHubSignature("callback-secret", body, signature)
    ).resolves.toBe(true);
    await expect(
      verifyGitHubSignature("different-secret", body, signature)
    ).resolves.toBe(false);
  });

  it("verifies GitHub SHA-256 signatures", async () => {
    const body = "{\"hello\":\"world\"}";
    const secret = "top-secret";
    const signature = await hmacHex("SHA-256", secret, body);
    await expect(
      verifyGitHubSignature(secret, body, `sha256=${signature}`)
    ).resolves.toBe(true);
    await expect(
      verifyGitHubSignature(secret, body, "sha256=deadbeef")
    ).resolves.toBe(false);
  });

  it("verifies Linear signatures with or without a prefix", async () => {
    const body = "{\"action\":\"create\"}";
    const secret = "linear-secret";
    const signature = await hmacHex("SHA-256", secret, body);
    await expect(verifyLinearSignature(secret, body, signature)).resolves.toBe(true);
    await expect(
      verifyLinearSignature(secret, body, `sha256=${signature}`)
    ).resolves.toBe(true);
  });

  it("rejects stale Slack signatures", async () => {
    const body = "payload";
    const secret = "slack-secret";
    const timestamp = "100";
    const signature = await hmacHex("SHA-256", secret, `v0:${timestamp}:${body}`);
    await expect(
      verifySlackSignature(secret, body, timestamp, `v0=${signature}`, 100)
    ).resolves.toBe(true);
    await expect(
      verifySlackSignature(secret, body, timestamp, `v0=${signature}`, 1000)
    ).resolves.toBe(false);
  });

  it("verifies Twilio signatures", async () => {
    const authToken = "twilio-token";
    const url = "https://example.com/webhooks/twilio";
    const params = new URLSearchParams({ Body: "hello", From: "+15551234567" });
    const payload = `${url}BodyhelloFrom+15551234567`;
    const signature = await hmacBase64("SHA-1", authToken, payload);
    await expect(
      verifyTwilioSignature(authToken, url, params, signature)
    ).resolves.toBe(true);
  });
});

async function hmacHex(
  hash: "SHA-1" | "SHA-256",
  secret: string,
  payload: string
): Promise<string> {
  const bytes = await hmacBytes(hash, secret, payload);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64(
  hash: "SHA-1" | "SHA-256",
  secret: string,
  payload: string
): Promise<string> {
  const bytes = await hmacBytes(hash, secret, payload);
  return Buffer.from(bytes).toString("base64");
}

async function hmacBytes(
  hash: "SHA-1" | "SHA-256",
  secret: string,
  payload: string
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return new Uint8Array(signature);
}
