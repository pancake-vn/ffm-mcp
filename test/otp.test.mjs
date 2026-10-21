// Test luồng OTP (bảo mật 2 lớp) của ffm-mcp: stdio (auth.ts + tool ffm_verify_otp) và
// remote OAuth (oauth-provider.ts). Giả lập BE bằng globalThis.fetch, không gọi BE thật.
// Chạy: npm test (build dist trước, test import từ dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TOKEN_FILE tính từ homedir() lúc import → đặt HOME tạm TRƯỚC khi import dist.
process.env.HOME = mkdtempSync(join(tmpdir(), "ffm-mcp-otp-"));
process.env.OAUTH_SIGNING_SECRET = "test-secret";

const D = new URL("../dist/", import.meta.url).href;
const HOST = "https://fulfillment.pancake.vn";
const OTP = "KQGKF0G";
const EXP = Math.floor(Date.now() / 1000) + 30 * 86400;
const jwt = (exp) => "h." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".s";

// mode: "otp" = tài khoản bật 2 lớp; "plain" = không; "need103" = chưa bật (API trả 103);
// "forced" = bị bắt OTP vì sai mật khẩu nhiều lần (BE đòi OTP cả khi mật khẩu sai).
let mode = "otp";
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ path: u.pathname, body });
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.pathname === "/api/users/login/password") {
    const otpSent = { success: true, require_otp: true, message_code: 666, message: "An OTP Code has been sent to a***@gmail.com." };
    if (mode === "forced") {
      if (!body.otp_code) return ok(otpSent);
      return body.password === "pw" && body.otp_code === OTP
        ? ok({ success: true, access_token: jwt(EXP) })
        : ok({ success: false, message: "Wrong username, password or OTP code" });
    }
    if (body.password !== "pw") return ok({ success: false, message: "Wrong username or password" });
    if (mode === "otp") {
      if (!body.otp_code) return ok(otpSent);
      if (body.otp_code !== OTP) return ok({ success: false, message: "OTP Code is invalid" });
    }
    return ok({ success: true, access_token: jwt(EXP) });
  }
  if (u.pathname === "/api/orders/statistics") {
    if (mode === "need103") return ok({ success: false, message: "Two-factor authentication required", error_code: 103 });
    return ok({ success: true, data: { total_entries: 7, group_by: [], buckets: [], totals: {} } });
  }
  throw new Error("unexpected " + url);
};
const logins = () => calls.filter((c) => c.path === "/api/users/login/password").length;

const auth = await import(D + "auth.js");
const { handleToolCall } = await import(D + "tools.js");
const { FfmOAuthProvider } = await import(D + "oauth-provider.js");

test("stdio: nhập OTP qua ffm_verify_otp, lưu token ra file", async () => {
  mode = "otp";
  const binding = { host: HOST, auth: { kind: "password", username: "u", password: "pw" } };
  const stats = () => handleToolCall("order_statistics", { country_code: "63" }, binding);
  const tokenFile = join(process.env.HOME, ".ffm-mcp", "tokens.json");

  let r = await stats();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ffm_verify_otp/);
  const afterFirst = logins();

  // Đang chờ mã: không gọi login lại (không gửi thêm email).
  r = await stats();
  assert.equal(r.isError, true);
  assert.equal(logins(), afterFirst);

  // Không kèm mã = gửi mã mới, không phải lỗi.
  r = await handleToolCall("ffm_verify_otp", {}, binding);
  assert.equal(r.isError, undefined);
  assert.equal(logins(), afterFirst + 1);
  assert.equal(calls.at(-1).body.otp_code, undefined);

  r = await handleToolCall("ffm_verify_otp", { otp_code: "WRONG" }, binding);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /OTP Code is invalid/);

  // Mã có khoảng trắng + chữ thường vẫn được chuẩn hoá.
  r = await handleToolCall("ffm_verify_otp", { otp_code: " kqg kf0g " }, binding);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(calls.at(-1).body.otp_code, OTP);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(process.env.HOME, ".ffm-mcp")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(process.env.HOME, ".ffm-mcp")), ["tokens.json"]); // không còn file tạm
  assert.ok(JSON.parse(readFileSync(tokenFile, "utf8"))[`${HOST}::u`].accessToken);

  const before = logins();
  r = await stats();
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(logins(), before);

  // Process mới (module mới) đọc token từ file, không login.
  const fresh = await import(D + "auth.js?fresh=1");
  await fresh.resolveAccessToken(HOST, "u", "pw");
  assert.equal(logins(), before);

  auth.invalidateToken(HOST, "u");
  assert.equal(JSON.parse(readFileSync(tokenFile, "utf8"))[`${HOST}::u`], undefined);
});

test("stdio: error_code 103 báo chưa bật 2 lớp, không đăng nhập lại", async () => {
  mode = "plain";
  const binding = { host: HOST, auth: { kind: "password", username: "u103", password: "pw" } };
  await handleToolCall("order_statistics", { country_code: "63" }, binding);
  mode = "need103";
  const before = logins();
  const r = await handleToolCall("order_statistics", { country_code: "63" }, binding);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /chưa bật bảo mật 2 lớp/);
  assert.equal(logins(), before);
});

test("ffm_verify_otp chỉ dùng ở stdio", async () => {
  const r = await handleToolCall("ffm_verify_otp", { otp_code: OTP }, { host: HOST, auth: { kind: "token", token: "x" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /stdio/);
});

function setup() {
  const p = new FfmOAuthProvider();
  const client = p.clientsStore.registerClient({ redirect_uris: ["https://claude.ai/cb"] });
  const base = { host: HOST, username: "u", client_id: client.client_id, redirect_uri: "https://claude.ai/cb", code_challenge: "ch", state: "st" };
  const pendingId = (res) => res.html.match(/name="pending_id" value="([^"]+)"/)[1];
  return { p, client, base, pendingId };
}

test("remote: đăng nhập có bước OTP", async () => {
  mode = "otp";
  const { p, client, base, pendingId } = setup();
  await assert.rejects(p.submitLogin({ ...base, password: "bad" }), /Wrong username/);

  let res = await p.submitLogin({ ...base, password: "pw" });
  assert.ok("html" in res);
  assert.doesNotMatch(res.html, /value="pw"/);
  const form = { ...base, pending_id: pendingId(res) };

  res = await p.submitLogin({ ...form, otp_code: "" });
  assert.match(res.html, /Nhập mã OTP\./);

  const before = logins();
  res = await p.submitLogin({ ...form, resend: "1" });
  assert.ok("html" in res);
  assert.equal(logins(), before + 1);

  res = await p.submitLogin({ ...form, otp_code: "WRONG" });
  assert.match(res.html, /OTP Code is invalid/);

  // Field ẩn bị sửa không có tác dụng: đăng nhập + redirect dùng dữ liệu phía server.
  res = await p.submitLogin({ ...form, redirect_uri: "https://evil.example/cb", otp_code: "kqgkf0g" });
  assert.ok(res.redirect.startsWith("https://claude.ai/cb"));
  const red = new URL(res.redirect);
  assert.equal(red.searchParams.get("state"), "st");
  const tok = await p.exchangeAuthorizationCode(client, red.searchParams.get("code"));
  assert.equal((await p.verifyAccessToken(tok.access_token)).extra.host, HOST);

  await assert.rejects(p.submitLogin({ ...form, otp_code: OTP }), /hết hạn/);
});

test("remote: sai mã 5 lần thì xoá phiên", async () => {
  mode = "otp";
  const { p, base, pendingId } = setup();
  const id = pendingId(await p.submitLogin({ ...base, password: "pw" }));
  for (let i = 0; i < 4; i++) assert.ok("html" in (await p.submitLogin({ ...base, pending_id: id, otp_code: "W" + i })));
  await assert.rejects(p.submitLogin({ ...base, pending_id: id, otp_code: "W5" }), /quá nhiều lần/);
  await assert.rejects(p.submitLogin({ ...base, pending_id: id, otp_code: OTP }), /hết hạn/);
});

test("remote: phiên chờ OTP hết hạn, mỗi tài khoản 1 phiên, nút Đăng nhập lại", async () => {
  mode = "forced";
  const { p, base, pendingId } = setup();
  // Mật khẩu sai vẫn bị đòi OTP (tài khoản bị bắt OTP) → nút Đăng nhập lại để sửa mật khẩu.
  let id = pendingId(await p.submitLogin({ ...base, password: "bad" }));
  assert.match((await p.submitLogin({ ...base, pending_id: id, otp_code: OTP })).html, /Wrong username, password or OTP code/);
  await assert.rejects(p.submitLogin({ ...base, pending_id: id, restart: "1" }), /Nhập lại/);
  assert.equal(p.pendingOtps.size, 0);

  const id1 = pendingId(await p.submitLogin({ ...base, password: "pw" }));
  const id2 = pendingId(await p.submitLogin({ ...base, password: "pw" }));
  assert.equal(p.pendingOtps.size, 1);
  await assert.rejects(p.submitLogin({ ...base, pending_id: id1, otp_code: OTP }), /hết hạn/);

  // Quá 5 phút kể từ lần gửi mã gần nhất.
  p.pendingOtps.get(id2).createdAt -= 6 * 60 * 1000;
  await assert.rejects(p.submitLogin({ ...base, pending_id: id2, otp_code: OTP }), /hết hạn/);

  // Gửi lại mã liên tục cũng không quá 15 phút tổng.
  id = pendingId(await p.submitLogin({ ...base, password: "pw" }));
  p.pendingOtps.get(id).firstCreatedAt -= 16 * 60 * 1000;
  await assert.rejects(p.submitLogin({ ...base, pending_id: id, resend: "1" }), /hết hạn/);
});

test("remote: tài khoản không cần OTP chuyển hướng như cũ", async () => {
  mode = "plain";
  const { p, base } = setup();
  assert.ok("redirect" in (await p.submitLogin({ ...base, password: "pw" })));
});
