// OAuthServerProvider cho ffm-mcp http mode.
//
// Bọc đăng nhập username/password của FFM thành luồng OAuth 2.1 chuẩn MCP:
//   1. Claude gọi /authorize → SDK validate client/redirect → gọi authorize() →
//      ta render trang login (dropdown host + username + password).
//   2. User submit → http.ts gọi submitLogin() → loginToFfm() → lưu authorization
//      code (kèm host + JWT FFM) → redirect về client với ?code&state.
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

import { loginToFfm } from "./auth.js";
import { SUPPORTED_HOSTS } from "./constants.js";
import { signSession, verifySession } from "./token.js";

const CODE_TTL_MS = 5 * 60 * 1000;

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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
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

  // Gọi từ http.ts POST /login/submit. Trả redirect URL hoặc throw lỗi.
  async submitLogin(fields: LoginFields): Promise<string> {
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

    // Đăng nhập FFM — sai username/password sẽ throw ở đây.
    const { accessToken, expEpoch } = await loginToFfm(host, username, password);

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      ffmJwt: accessToken,
      host,
      username,
      expEpoch,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      clientId: client_id,
      state: fields.state,
      createdAt: Date.now(),
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (fields.state) url.searchParams.set("state", fields.state);
    return url.href;
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
    const hidden = (name: string, val?: string) =>
      val ? `<input type="hidden" name="${name}" value="${escapeHtml(val)}">` : "";
    const options = SELECTABLE_HOSTS.map(
      (h) =>
        `<option value="${escapeHtml(h.url)}"${
          fields.host === h.url ? " selected" : ""
        }>${escapeHtml(h.label)}</option>`,
    ).join("");
    const errorHtml = error
      ? `<p style="color:#c0392b;margin:0 0 16px">${escapeHtml(error)}</p>`
      : "";
    return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kết nối Pancake FFM</title>
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
</style></head>
<body><form class="card" method="post" action="/login/submit">
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
  ${hidden("client_id", fields.client_id)}
  ${hidden("redirect_uri", fields.redirect_uri)}
  ${hidden("code_challenge", fields.code_challenge)}
  ${hidden("state", fields.state)}
  ${hidden("scope", fields.scope)}
  ${hidden("resource", fields.resource)}
  <button type="submit">Đăng nhập &amp; cấp quyền</button>
</form></body></html>`;
  }
}
