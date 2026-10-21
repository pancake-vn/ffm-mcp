// Auto-login + token cache cho ffm-mcp.
//
// Flow:
//   1. Tool call → resolveAccessToken(host, username, password).
//   2. Có cache hợp lệ → return ngay.
//   3. Không cache (hoặc sắp expire < REFRESH_SKEW_SECONDS) → gọi
//      POST /api/users/login/password (router.ex:35), parse JWT lấy `exp`,
//      cache lại.
//   4. Trong api.ts: nếu BE trả 401 → invalidate cache + force re-login +
//      retry 1 lần.
//
// In-flight dedup: nếu nhiều call cùng key cùng lúc, chỉ chạy 1 login.
//
// Tài khoản bật bảo mật 2 lớp: BE trả `require_otp` (đã gửi mã OTP về email) thay vì
// access_token → throw OtpRequiredError; tool ffm_verify_otp (stdio) gọi verifyOtp() đăng
// nhập lại kèm otp_code. Token stdio lưu ra TOKEN_FILE để mở lại client không phải nhập OTP.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// BE đã gửi mã OTP về email (user bật 2 lớp, hoặc bị nhập sai mật khẩu nhiều lần), phải
// gọi lại login kèm otp_code mới có access_token. message = câu BE trả (có email đã che).
export class OtpRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpRequiredError";
  }
}

export interface CachedToken {
  accessToken: string;
  expEpoch: number; // unix seconds
}

// Refresh khi còn ≤ 5 phút trước expiry để tránh edge race.
const REFRESH_SKEW_SECONDS = 300;

const cache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();

// Mã OTP sống 5 phút (BE). Trong thời gian đó không gọi login lại khi chưa có mã: mỗi lần
// gọi cách nhau quá 60 giây là BE gửi thêm 1 email OTP.
const OTP_PENDING_MS = 5 * 60 * 1000;
const otpPending = new Map<string, { message: string; sentAt: number }>();

export const TOKEN_FILE = join(homedir(), ".ffm-mcp", "tokens.json");

function cacheKey(host: string, username: string): string {
  return `${host.replace(/\/+$/, "")}::${username}`;
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function isFresh(t: CachedToken | undefined, now: number): t is CachedToken {
  return typeof t?.accessToken === "string" && typeof t.expEpoch === "number" &&
    t.expEpoch - now > REFRESH_SKEW_SECONDS;
}

// Đọc lại file mỗi lần cache trong process không có token: process khác (session client
// khác) có thể vừa nhập OTP xong và ghi token mới.
function readTokenFile(): Record<string, CachedToken> {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) ?? {};
  } catch {
    return {};
  }
}

// Ghi token của 1 key (null = xoá), giữ token của key khác, bỏ token đã hết hạn.
function writeTokenFile(key: string, token: CachedToken | null): void {
  const now = nowEpoch();
  const data = readTokenFile();
  if (token) data[key] = token;
  else delete data[key];
  for (const [k, t] of Object.entries(data)) {
    if (!(typeof t?.expEpoch === "number" && t.expEpoch > now)) delete data[k];
  }
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    // Ghi file tạm rồi rename: process khác đọc giữa chừng không gặp file rỗng.
    const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600); // mode của writeFileSync chỉ áp dụng khi tạo file mới
    renameSync(tmp, TOKEN_FILE);
  } catch (err) {
    process.stderr.write(`[ffm-mcp] không ghi được ${TOKEN_FILE}: ${err}\n`);
  }
}

function saveToken(key: string, token: CachedToken): void {
  cache.set(key, token);
  otpPending.delete(key);
  writeTokenFile(key, token);
}

function decodeJwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    // base64url → base64. Buffer.from chấp nhận cả 2, miễn pad đúng.
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const obj = JSON.parse(json);
    return typeof obj.exp === "number" ? obj.exp : null;
  } catch {
    return null;
  }
}

// Login trực tiếp tới BE, trả { accessToken, expEpoch }. Dùng bởi:
//   - resolveAccessToken (stdio: login + cache + refresh).
//   - OAuth /authorize/submit (http: login để phát session token, không cache).
// otpCode: gửi kèm khi BE đã đòi OTP (lần gọi trước throw OtpRequiredError).
export async function loginToFfm(
  host: string,
  username: string,
  password: string,
  otpCode?: string,
): Promise<CachedToken> {
  const url = `${host.replace(/\/+$/, "")}/api/users/login/password`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      otpCode ? { username, password, otp_code: otpCode } : { username, password },
    ),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `login HTTP ${res.status} (${url}): ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    success?: boolean;
    access_token?: string;
    message?: string;
    require_otp?: boolean;
  };
  // UserController.password_login/2: đúng mật khẩu nhưng còn thiếu OTP → success: true,
  // require_otp: true, không có access_token.
  if (json?.require_otp) {
    throw new OtpRequiredError(json.message || "OTP code required");
  }
  if (!json?.success || !json.access_token) {
    throw new Error(
      `login failed: ${json?.message || JSON.stringify(json).slice(0, 300)}`,
    );
  }
  const exp =
    decodeJwtExp(json.access_token) ??
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // fallback 30d (Tools.exp_30_days)
  return { accessToken: json.access_token, expEpoch: exp };
}

export async function resolveAccessToken(
  host: string,
  username: string,
  password: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  const key = cacheKey(host, username);
  const now = nowEpoch();

  if (!opts.force) {
    const cached = cache.get(key);
    if (isFresh(cached, now)) return cached.accessToken;
    const fromFile = readTokenFile()[key];
    if (isFresh(fromFile, now)) {
      cache.set(key, fromFile);
      return fromFile.accessToken;
    }
  }

  // Đang chờ user nhập mã đã gửi → không gọi login (tránh gửi thêm email OTP).
  const waiting = otpPending.get(key);
  if (waiting && Date.now() - waiting.sentAt < OTP_PENDING_MS) {
    throw new OtpRequiredError(waiting.message);
  }

  // Dedup các login đồng thời cùng key.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = loginToFfm(host, username, password).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }
  try {
    const fresh = await pending;
    saveToken(key, fresh);
    return fresh.accessToken;
  } catch (err) {
    if (err instanceof OtpRequiredError) {
      otpPending.set(key, { message: err.message, sentAt: Date.now() });
    }
    throw err;
  }
}

// Tool ffm_verify_otp (stdio). Có otpCode → đăng nhập kèm mã, lưu token. Không có otpCode →
// gọi login để BE gửi mã mới (BE giới hạn 1 mã / 60 giây), throw OtpRequiredError.
export async function verifyOtp(
  host: string,
  username: string,
  password: string,
  otpCode?: string,
): Promise<CachedToken> {
  const key = cacheKey(host, username);
  try {
    const fresh = await loginToFfm(host, username, password, otpCode || undefined);
    saveToken(key, fresh);
    return fresh;
  } catch (err) {
    if (err instanceof OtpRequiredError) {
      otpPending.set(key, { message: err.message, sentAt: Date.now() });
    }
    throw err;
  }
}

export function invalidateToken(host: string, username: string): void {
  const key = cacheKey(host, username);
  cache.delete(key);
  writeTokenFile(key, null);
}
