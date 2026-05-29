#!/usr/bin/env node
// MCP server cho sea-fulfillment orders — HTTP/remote entry (Streamable HTTP + OAuth).
//
// Cắm vào Claude Desktop qua "Add custom connector" → dán URL https://<host>/mcp →
// trình duyệt mở trang Authorize (chọn tenant + đăng nhập FFM) → dùng ngay.
//
// Stdio entry (local): src/index.ts. Tool logic dùng chung: src/tools.ts.

import express from "express";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { FfmOAuthProvider } from "./oauth-provider.js";
import { buildServer, ResolveAuth } from "./tools.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = process.env.PUBLIC_URL || "";

if (!PUBLIC_URL) {
  process.stderr.write(
    "[ffm-mcp-http] Missing PUBLIC_URL (vd https://mcp-ffm.pancake.vn) — bắt buộc cho OAuth metadata.\n",
  );
  process.exit(1);
}
if (!process.env.OAUTH_SIGNING_SECRET) {
  process.stderr.write(
    "[ffm-mcp-http] Missing OAUTH_SIGNING_SECRET — bắt buộc để ký session token.\n",
  );
  process.exit(1);
}

const issuerUrl = new URL(PUBLIC_URL);
const provider = new FfmOAuthProvider();

// http mode: auth = token (JWT FFM lấy từ session), host nhúng trong token.
const resolveAuth: ResolveAuth = (extra) => {
  const info = extra?.authInfo?.extra as
    | { ffm_jwt?: string; host?: string }
    | undefined;
  if (!info?.ffm_jwt || !info.host) {
    throw new Error("Thiếu auth context — kết nối chưa được authorize.");
  }
  return { host: info.host, auth: { kind: "token", token: info.ffm_jwt } };
};

const app = express();
// Chạy sau reverse proxy (nginx) terminate TLS: tin X-Forwarded-* của hop đầu
// để req.ip đúng (rate-limit OAuth không gộp mọi user vào chung IP proxy).
app.set("trust proxy", 1);

// OAuth endpoints: /authorize, /token, /register, /.well-known/* (SDK lo).
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: issuerUrl,
    resourceName: "Pancake FFM",
  }),
);

// Trang login submit (form từ provider.authorize POST về đây).
// Đặt ngoài prefix /authorize để không bị body-parser của mcpAuthRouter nuốt stream.
app.post(
  "/login/submit",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      const redirectUrl = await provider.submitLogin(req.body);
      res.redirect(302, redirectUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(400)
        .set("Content-Type", "text/html; charset=utf-8")
        .send(provider.renderLoginPage(req.body, message));
    }
  },
);

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// MCP endpoint — bảo vệ bằng Bearer token, transport stateless.
const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${issuerUrl.href.replace(/\/$/, "")}/.well-known/oauth-protected-resource`,
});

app.post("/mcp", bearer, express.json(), async (req, res) => {
  const server = buildServer(resolveAuth);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(`[ffm-mcp-http] /mcp error: ${err}\n`);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

app.listen(PORT, () => {
  process.stderr.write(
    `[ffm-mcp-http] ready on :${PORT} (issuer ${issuerUrl.href})\n`,
  );
});
