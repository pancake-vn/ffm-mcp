// OAuthServerProvider cho ffm-mcp http mode.
//
// Bọc đăng nhập username/password của FFM thành luồng OAuth 2.1 chuẩn MCP:
//   1. Claude gọi /authorize → SDK validate client/redirect → gọi authorize() →
//      ta render trang login (dropdown host + username + password).
//   2. User submit → http.ts gọi submitLogin() → loginToFfm() → lưu authorization
//      code (kèm host + JWT FFM) → redirect về client với ?code&state.
//      Tài khoản bật bảo mật 2 lớp: BE đòi OTP → render trang nhập OTP, mật khẩu giữ
//      phía server (pendingOtps) tới khi user nhập mã → submitOtp() đăng nhập kèm mã.
//   3. Claude gọi /token (PKCE) → SDK verify challenge qua challengeForAuthorizationCode()
//      → exchangeAuthorizationCode() phát session JWT (token.ts) nhúng JWT FFM + host.
//   4. Mỗi /mcp request → verifyAccessToken() decode session JWT → AuthInfo.extra.

import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";

import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { loginToFfm, OtpRequiredError } from "./auth.js";
import { SUPPORTED_HOSTS } from "./constants.js";
import { signSession, verifySession } from "./token.js";

const CODE_TTL_MS = 5 * 60 * 1000;
// Phiên chờ OTP sống bằng mã OTP của BE (5 phút). Giữ mật khẩu phía server, không đưa vào
// HTML, vì BE kiểm lại cả mật khẩu lẫn otp_code trong cùng 1 request đăng nhập.
const OTP_PENDING_TTL_MS = 5 * 60 * 1000;
// Gửi lại mã tính lại 5 phút, nhưng tổng thời gian giữ mật khẩu không quá 15 phút.
const OTP_PENDING_MAX_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// Chặn bộ nhớ tăng không giới hạn khi bị gửi form liên tục.
const OTP_PENDING_LIMIT = 1000;

// Host hiển thị trong dropdown (bỏ host dev local).
const SELECTABLE_HOSTS = SUPPORTED_HOSTS.filter(
  (h) => h.hostname !== "localhost" && h.hostname !== "ffm_running_app",
).map((h) => ({ url: `https://${h.hostname}`, label: `${h.prefix} — ${h.hostname}` }));

const VALID_HOST_URLS = new Set(SELECTABLE_HOSTS.map((h) => h.url));

interface AuthCode {
  ffmJwt: string;
  host: string;
  username: string;
  expEpoch: number; // exp của JWT FFM
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  state?: string;
  createdAt: number;
}

// Dữ liệu cần để phát authorization code sau khi đăng nhập FFM xong.
interface CodeRequest {
  host: string;
  username: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}

interface PendingOtp extends CodeRequest {
  password: string;
  attempts: number;
  createdAt: number; // lần gửi mã gần nhất
  firstCreatedAt: number;
}

export type SubmitResult = { redirect: string } | { html: string };

interface LoginFields {
  host?: string;
  username?: string;
  password?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  state?: string;
  scope?: string;
  resource?: string;
  // Trang nhập OTP
  pending_id?: string;
  otp_code?: string;
  resend?: string;
  restart?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function hidden(name: string, val?: string): string {
  return val ? `<input type="hidden" name="${name}" value="${escapeHtml(val)}">` : "";
}

// Field OAuth đi theo mọi form, để lỗi ở bước nào cũng render lại được trang đăng nhập.
function oauthHidden(fields: LoginFields): string {
  return [
    hidden("client_id", fields.client_id),
    hidden("redirect_uri", fields.redirect_uri),
    hidden("code_challenge", fields.code_challenge),
    hidden("state", fields.state),
    hidden("scope", fields.scope),
    hidden("resource", fields.resource),
  ].join("\n  ");
}

function renderPage(title: string, form: string): string {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6f8;
       margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);
        width:360px}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{color:#666;font-size:13px;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
  input,select{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ddd;
        border-radius:8px;font-size:14px}
  button{width:100%;margin-top:24px;padding:12px;border:0;border-radius:8px;background:#2563eb;
        color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#1d4ed8}
  button.secondary{margin-top:12px;background:#fff;color:#2563eb;border:1px solid #2563eb}
  button.secondary:hover{background:#eff6ff}
</style></head>
<body>${form}</body></html>`;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

export class FfmOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new InMemoryClientsStore();
  private codes = new Map<string, AuthCode>();
  private pendingOtps = new Map<string, PendingOtp>();

  constructor() {
    setInterval(() => this.sweepPendingOtps(), 60 * 1000).unref();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const html = this.renderLoginPage({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state,
      scope: params.scopes?.join(" "),
      resource: params.resource?.href,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  }

  // Gọi từ http.ts POST /login/submit. Trả redirect URL, trang nhập OTP, hoặc throw lỗi
  // (http.ts render lại trang đăng nhập kèm lỗi).
  async submitLogin(fields: LoginFields): Promise<SubmitResult> {
    this.sweepPendingOtps();
    if (fields.pending_id) return this.submitOtp(fields);

    const { host, username, password, client_id, redirect_uri, code_challenge } =
      fields;

    if (!host || !VALID_HOST_URLS.has(host)) {
      throw new Error("Vui lòng chọn host hợp lệ.");
    }
    if (!username || !password) {
      throw new Error("Nhập đầy đủ username và password.");
    }
    if (!client_id || !redirect_uri || !code_challenge) {
      throw new Error("Thiếu tham số OAuth (client_id/redirect_uri/code_challenge).");
    }
    const client = this._clientsStore.getClient(client_id);
    if (!client) throw new Error("client_id không hợp lệ.");
    if (!client.redirect_uris.includes(redirect_uri)) {
      throw new Error("redirect_uri chưa đăng ký cho client này.");
    }

    const request: CodeRequest = {
      host,
      username,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      state: fields.state,
    };

    try {
      // Đăng nhập FFM — sai username/password sẽ throw ở đây.
      const { accessToken, expEpoch } = await loginToFfm(host, username, password);
      return { redirect: this.issueCode(request, accessToken, expEpoch) };
    } catch (err) {
      if (!(err instanceof OtpRequiredError)) throw err;
      // Mỗi tài khoản chỉ giữ 1 phiên chờ OTP (phiên mới nhất).
      for (const [id, p] of this.pendingOtps) {
        if (p.host === host && p.username === username) this.pendingOtps.delete(id);
      }
      if (this.pendingOtps.size >= OTP_PENDING_LIMIT) {
        throw new Error("Hệ thống đang bận, thử lại sau ít phút.");
      }
      const pendingId = randomBytes(32).toString("base64url");
      const now = Date.now();
      this.pendingOtps.set(pendingId, {
        ...request,
        password,
        attempts: 0,
        createdAt: now,
        firstCreatedAt: now,
      });
      return { html: this.renderOtpPage(pendingId, fields, err.message, false) };
    }
  }

  // Bước 2 của tài khoản bật bảo mật 2 lớp: form nhập OTP (hoặc nút "Gửi lại mã").
  // Thông tin đăng nhập + OAuth lấy từ pendingOtps phía server, không tin field ẩn của form.
  private async submitOtp(fields: LoginFields): Promise<SubmitResult> {
    const pendingId = fields.pending_id!;
    const pending = this.pendingOtps.get(pendingId);
    if (!pending) throw new Error("Phiên nhập OTP đã hết hạn — đăng nhập lại.");
    // Nút "Đăng nhập lại": sửa mật khẩu (BE vẫn đòi OTP cả khi mật khẩu sai nếu tài khoản
    // đang bị bắt OTP vì nhập sai nhiều lần — UserController.otp_forced_login/5).
    if (fields.restart === "1") {
      this.pendingOtps.delete(pendingId);
      throw new Error("Nhập lại thông tin đăng nhập.");
    }

    const resend = fields.resend === "1";
    // Mã của BE gồm chữ hoa + số (UserOtp.gen_code/0), so khớp phân biệt hoa thường.
    const otpCode = fields.otp_code?.replace(/\s+/g, "").toUpperCase();
    if (!resend && !otpCode) {
      return { html: this.renderOtpPage(pendingId, fields, "Nhập mã OTP.", true) };
    }

    try {
      const { accessToken, expEpoch } = await loginToFfm(
        pending.host,
        pending.username,
        pending.password,
        resend ? undefined : otpCode,
      );
      this.pendingOtps.delete(pendingId);
      return { redirect: this.issueCode(pending, accessToken, expEpoch) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OtpRequiredError) {
        // Gửi lại mã: tính lại thời gian chờ theo mã mới, giữ nguyên số lần đã nhập sai.
        pending.createdAt = Date.now();
        return { html: this.renderOtpPage(pendingId, fields, message, false) };
      }
      pending.attempts += 1;
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        this.pendingOtps.delete(pendingId);
        throw new Error("Nhập sai OTP quá nhiều lần — đăng nhập lại.");
      }
      return { html: this.renderOtpPage(pendingId, fields, message, true) };
    }
  }

  private issueCode(request: CodeRequest, ffmJwt: string, expEpoch: number): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      ffmJwt,
      host: request.host,
      username: request.username,
      expEpoch,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      clientId: request.clientId,
      state: request.state,
      createdAt: Date.now(),
    });

    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state) url.searchParams.set("state", request.state);
    return url.href;
  }

  // Xoá phiên chờ OTP quá hạn (user bỏ ngang) để mật khẩu không nằm lại trong bộ nhớ.
  // Gọi ở mọi lượt gửi form + định kỳ (http.ts không có lượt nào thì interval vẫn dọn).
  private sweepPendingOtps(): void {
    const now = Date.now();
    for (const [id, p] of this.pendingOtps) {
      if (now - p.createdAt > OTP_PENDING_TTL_MS || now - p.firstCreatedAt > OTP_PENDING_MAX_MS) {
        this.pendingOtps.delete(id);
      }
    }
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.takeCodeIfValid(authorizationCode, false);
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.takeCodeIfValid(authorizationCode, true);
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code không thuộc client này.");
    }
    const accessToken = signSession({
      ffm_jwt: entry.ffmJwt,
      host: entry.host,
      username: entry.username,
      exp: entry.expEpoch,
    });
    const expiresIn = Math.max(60, entry.expEpoch - Math.floor(Date.now() / 1000));
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    // v1: không hỗ trợ refresh token — hết hạn thì authorize lại.
    throw new Error("refresh_token không được hỗ trợ; vui lòng authorize lại.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = verifySession(token); // throw nếu sai chữ ký / hết hạn
    return {
      token,
      clientId: "ffm-mcp",
      scopes: [],
      expiresAt: payload.exp,
      extra: {
        ffm_jwt: payload.ffm_jwt,
        host: payload.host,
        username: payload.username,
      },
    };
  }

  // challengeForAuthorizationCode (peek=false) gọi trước exchange; exchange (consume=true)
  // mới xoá code. Cùng validate TTL.
  private takeCodeIfValid(code: string, consume: boolean): AuthCode {
    const entry = this.codes.get(code);
    if (!entry) throw new Error("Authorization code không hợp lệ.");
    if (Date.now() - entry.createdAt > CODE_TTL_MS) {
      this.codes.delete(code);
      throw new Error("Authorization code đã hết hạn.");
    }
    if (consume) this.codes.delete(code);
    return entry;
  }

  renderLoginPage(fields: LoginFields, error?: string): string {
    const options = SELECTABLE_HOSTS.map(
      (h) =>
        `<option value="${escapeHtml(h.url)}"${
          fields.host === h.url ? " selected" : ""
        }>${escapeHtml(h.label)}</option>`,
    ).join("");
    const errorHtml = error
      ? `<p style="color:#c0392b;margin:0 0 16px">${escapeHtml(error)}</p>`
      : "";
    return renderPage("Kết nối Pancake FFM", `<form class="card" method="post" action="/login/submit">
  <h1>Kết nối Pancake FFM</h1>
  <p class="sub">Đăng nhập để cấp quyền cho trợ lý AI truy cập đơn hàng.</p>
  ${errorHtml}
  <label for="host">Hệ thống (tenant)</label>
  <select id="host" name="host" required>${options}</select>
  <label for="username">Username / Email / SĐT</label>
  <input id="username" name="username" autocomplete="username"
         value="${escapeHtml(fields.username ?? "")}" required>
  <label for="password">Mật khẩu</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  ${oauthHidden(fields)}
  <button type="submit">Đăng nhập &amp; cấp quyền</button>
</form>`);
  }

  // host + username đi kèm dạng field ẩn chỉ để hiển thị và render lại trang đăng nhập khi
  // phiên OTP hết hạn; đăng nhập + phát code dùng dữ liệu trong pendingOtps.
  private renderOtpPage(
    pendingId: string,
    fields: LoginFields,
    message: string,
    isError: boolean,
  ): string {
    const color = isError ? "#c0392b" : "#166534";
    return renderPage("Nhập mã OTP — Pancake FFM", `<form class="card" method="post" action="/login/submit">
  <h1>Nhập mã OTP</h1>
  <p class="sub">Tài khoản ${escapeHtml(fields.username ?? "")} cần nhập mã OTP gửi về email.</p>
  <p style="color:${color};margin:0 0 16px;font-size:14px">${escapeHtml(message)}</p>
  <label for="otp_code">Mã OTP trong email</label>
  <input id="otp_code" name="otp_code" autocomplete="one-time-code" required autofocus>
  ${hidden("pending_id", pendingId)}
  ${hidden("host", fields.host)}
  ${hidden("username", fields.username)}
  ${oauthHidden(fields)}
  <button type="submit">Xác nhận</button>
  <button type="submit" class="secondary" name="resend" value="1" formnovalidate>Gửi lại mã</button>
  <button type="submit" class="secondary" name="restart" value="1" formnovalidate>Đăng nhập lại</button>
</form>`);
  }
}
