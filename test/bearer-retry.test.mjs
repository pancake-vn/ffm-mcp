// BE từ chối token (401) → withAuthRetry đăng nhập lại rồi gọi lại 1 lần: lần gọi lại phải mang
// token MỚI trên header `Authorization: Bearer`, URL không có access_token.
// Giả lập BE bằng globalThis.fetch, không gọi BE thật. Chạy: npm test (test import từ dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TOKEN_FILE tính từ homedir() lúc import → đặt HOME tạm TRƯỚC khi import dist.
process.env.HOME = mkdtempSync(join(tmpdir(), "ffm-mcp-retry-"));

const D = new URL("../dist/", import.meta.url).href;
const HOST = "https://fulfillment.pancake.vn";
const EXP = Math.floor(Date.now() / 1000) + 30 * 86400;
const jwt = (n) => "h." + Buffer.from(JSON.stringify({ exp: EXP, n })).toString("base64url") + ".s";
const OLD = jwt(1);
const FRESH = jwt(2);

let logins = 0;
const statsCalls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.pathname === "/api/users/login/password") {
    logins += 1;
    return ok({ success: true, access_token: logins === 1 ? OLD : FRESH });
  }
  if (u.pathname === "/api/orders/statistics") {
    statsCalls.push({ url: u, headers: init.headers });
    return init.headers.Authorization === `Bearer ${FRESH}`
      ? ok({ success: true, data: { total_entries: 1 } })
      : ok({ success: false, error_code: 102, message: "Missing access_token" });
  }
  throw new Error("unexpected " + url);
};

const { callStatistics } = await import(D + "api.js");

test("BE từ chối token cũ → đăng nhập lại, gọi lại bằng token mới trên header", async () => {
  const ctx = { host: HOST, countryCode: "63", auth: { kind: "password", username: "u", password: "pw" } };
  const res = await callStatistics(ctx, {});
  assert.equal(res.total_entries, 1);
  assert.equal(logins, 2);
  assert.equal(statsCalls.length, 2);
  assert.equal(statsCalls[0].headers.Authorization, `Bearer ${OLD}`);
  assert.equal(statsCalls[1].headers.Authorization, `Bearer ${FRESH}`);
  for (const c of statsCalls) assert.equal(c.url.searchParams.get("access_token"), null);
});
