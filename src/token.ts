// Session token (access token ta phát cho MCP client) = JWT tự ký HMAC-SHA256.
// Stateless: payload nhúng JWT FFM + host + username + exp → verify chỉ cần check
// chữ ký + exp, không cần token store, restart không mất session.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  ffm_jwt: string; // JWT FFM thật (dùng làm access_token gọi BE)
  host: string; // host tenant user đã chọn lúc authorize
  username: string;
  exp: number; // unix seconds — khớp exp của JWT FFM
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

function sign(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

function getSecret(): string {
  const secret = process.env.OAUTH_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      "Missing OAUTH_SIGNING_SECRET — bắt buộc set env để ký session token (http mode).",
    );
  }
  return secret;
}

export function signSession(payload: SessionPayload): string {
  const secret = getSecret();
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function verifySession(token: string): SessionPayload {
  const secret = getSecret();
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [header, body, sig] = parts;
  const expected = sign(`${header}.${body}`, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid token signature");
  }
  const payload = JSON.parse(
    Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  ) as SessionPayload;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }
  return payload;
}
