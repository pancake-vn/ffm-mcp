#!/usr/bin/env node
// MCP server cho sea-fulfillment orders — STDIO entry (local).
//
// Auth: server tự gọi POST /api/users/login/password lấy access_token bằng
// SEA_FULFILLMENT_USERNAME + SEA_FULFILLMENT_PASSWORD, cache theo `exp` claim
// (30 ngày), auto re-login khi BE trả 401.
//
// Tool definitions + logic dùng chung với http entry, ở src/tools.ts.
// Remote (HTTP + OAuth) entry: src/http.ts.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer, ResolveAuth } from "./tools.js";

const ENV_HOST = process.env.SEA_FULFILLMENT_HOST || "";
const ENV_USERNAME = process.env.SEA_FULFILLMENT_USERNAME || "";
const ENV_PASSWORD = process.env.SEA_FULFILLMENT_PASSWORD || "";

function resolveHost(args: Record<string, unknown>): string {
  const host = (typeof args.host === "string" && args.host) || ENV_HOST;
  if (!host) {
    throw new Error(
      "Missing host. BẮT BUỘC set env SEA_FULFILLMENT_HOST (vd " +
        "https://fulfillment.pancake.vn, https://bigate.co …) hoặc truyền " +
        "tham số `host` mỗi call.",
    );
  }
  return host;
}

// stdio: auth = password (env), host = args.host override env.
const resolveAuth: ResolveAuth = (_extra, args) => {
  if (!ENV_USERNAME || !ENV_PASSWORD) {
    throw new Error(
      "Missing credentials. BẮT BUỘC set env SEA_FULFILLMENT_USERNAME + " +
        "SEA_FULFILLMENT_PASSWORD. Server tự login lấy access_token, cache + " +
        "refresh tự động.",
    );
  }
  return {
    host: resolveHost(args),
    auth: { kind: "password", username: ENV_USERNAME, password: ENV_PASSWORD },
  };
};

async function main() {
  const server = buildServer(resolveAuth);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[ffm-mcp] ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[ffm-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
