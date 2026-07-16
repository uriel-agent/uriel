const encoder = new TextEncoder();

export async function signPayloadSha256(
  secret: string,
  body: string
): Promise<string> {
  return `sha256=${await hmacHex("SHA-256", secret, body)}`;
}

export async function verifyGitHubSignature(
  secret: string,
  body: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = await hmacHex("SHA-256", secret, body);
  return timingSafeEqualHex(signatureHeader.slice("sha256=".length), expected);
}

export async function verifyLinearSignature(
  secret: string,
  body: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }
  const normalized = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const expected = await hmacHex("SHA-256", secret, body);
  return timingSafeEqualHex(normalized, expected);
}

export async function verifySlackSignature(
  secret: string,
  body: string,
  timestamp: string | null,
  signatureHeader: string | null,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!timestamp || !signatureHeader?.startsWith("v0=")) {
    return false;
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  if (Math.abs(nowSeconds - timestampSeconds) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${body}`;
  const expected = await hmacHex("SHA-256", secret, base);
  return timingSafeEqualHex(signatureHeader.slice("v0=".length), expected);
}

export async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }

  const sortedPairs = Array.from(params.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const payload =
    url + sortedPairs.map(([key, value]) => `${key}${value}`).join("");
  const expected = await hmacBase64("SHA-1", authToken, payload);
  return timingSafeEqualString(signatureHeader, expected);
}

export async function verifyDiscordSignature(
  publicKeyHex: string,
  timestamp: string | null,
  body: string,
  signatureHex: string | null
): Promise<boolean> {
  if (!timestamp || !signatureHex) {
    return false;
  }

  const publicKey = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex);
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey,
    "Ed25519",
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "Ed25519",
    key,
    signature,
    encoder.encode(`${timestamp}${body}`)
  );
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return timingSafeEqualBytes(leftBytes, rightBytes);
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (!/^[0-9a-f]*$/u.test(normalizedLeft)) {
    return false;
  }
  if (!/^[0-9a-f]*$/u.test(normalizedRight)) {
    return false;
  }
  return timingSafeEqualBytes(hexToBytes(normalizedLeft), hexToBytes(normalizedRight));
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(normalized)) {
    throw new Error("Invalid hex string.");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

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
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return new Uint8Array(signature);
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
