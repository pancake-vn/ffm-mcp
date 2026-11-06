// Wrapper gọi API FFM với 2 kiểu auth:
//   - password: tự login (auth.ts) + cache + retry re-login khi 401 (stdio mode).
//   - token:    dùng JWT FFM có sẵn (http/OAuth mode); 401 → báo re-authorize
//               vì không giữ password để re-login.
//
// Endpoint chính: POST /api/orders/statistics (Order Data Statistics — trả aggregation
// group_by + metrics + totals, KHÔNG trả full order doc). Kèm GET /api/shops để resolve
// shop_id → tên shop khi group_by theo shop, và POST /api/users/get_users để tra user
// (tên/email → UUID cho filter, UUID → tên khi group_by theo user).

import { invalidateToken, resolveAccessToken } from "./auth.js";

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export type CallAuth =
  | { kind: "password"; username: string; password: string }
  | { kind: "token"; token: string };

export interface CallContext {
  host: string;
  countryCode: string;
  auth: CallAuth;
}

export interface StatisticsResponse {
  total_entries?: number;
  totals?: Record<string, number>;
  group_by?: string[];
  metrics?: string[];
  buckets?: Array<{
    keys: Array<{ key: unknown; key_as_string?: string }>;
    count: number;
    values: Record<string, number>;
  }>;
  time_key?: string;
  interval?: string;
  [k: string]: unknown;
}

export interface ShopLite {
  id: number | string;
  name?: string;
  pos_shop_id?: string | number;
  [k: string]: unknown;
}

export interface UserLite {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email?: string | null;
  group?: string | null;
  [k: string]: unknown;
}

// Header gửi kèm mọi request gọi BE. Token gửi bằng `Authorization: Bearer` VÀ vẫn gửi
// `?access_token=` trên URL: BE prod hiện chỉ đọc token ở URL (plug api_auth của
// sea-fulfillment), BE phase 2 sẽ đọc header. Khi phase 2 lên prod thì bỏ `access_token`
// khỏi URL ở rawStatistics / rawShops / rawUsers / callApi, chỉ giữ header này.
function authHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

async function resolveToken(ctx: CallContext): Promise<string> {
  if (ctx.auth.kind === "token") return ctx.auth.token;
  return resolveAccessToken(ctx.host, ctx.auth.username, ctx.auth.password);
}

// Đọc envelope { success, data, message } của BE. BE đôi khi trả 200 + success:false
// cho auth failures → heuristic message chứa "auth"/"token"/"login"/"unauthorized" ⇒ 401.
async function readEnvelope(res: Response, label: string): Promise<any> {
  return (await readBody(res, label))?.data ?? {};
}

// Như readEnvelope nhưng trả NGUYÊN body: vài API không bọc kết quả trong `data`
// (vd /products/get_products → `products`, /products/combo → `entries`).
async function readBody(res: Response, label: string): Promise<any> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, body);
  }
  const json = (await res.json()) as {
    success?: boolean;
    data?: unknown;
    message?: string;
    error_code?: number;
  };
  if (json?.success === false) {
    const msg = json.message || "";
    // error_code 103 (plug check_two_factor của BE): tài khoản chưa bật bảo mật 2 lớp — token
    // vẫn đúng, đăng nhập / authorize lại không giúp gì nên KHÔNG đổi thành 401.
    if (json.error_code === 103) {
      throw new Error(
        "Tài khoản FFM chưa bật bảo mật 2 lớp — đăng nhập web FFM, bật ở màn " +
          "/two_factor rồi hỏi lại (không cần kết nối lại MCP).",
      );
    }
    if (/auth|token|login|unauthor/i.test(msg)) throw new HttpError(401, msg);
    throw new Error(`${label} failed: ${msg || JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// Gọi 1 request đã auth; nếu 401 và auth=password thì force re-login + retry 1 lần.
async function withAuthRetry<T>(
  ctx: CallContext,
  doCall: (token: string) => Promise<T>,
): Promise<T> {
  if (!ctx.host) throw new Error("host is required");
  const token = await resolveToken(ctx);
  try {
    return await doCall(token);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      if (ctx.auth.kind === "password") {
        // Token cache có thể đã invalid (revoked / password đổi). Force re-login 1 lần.
        invalidateToken(ctx.host, ctx.auth.username);
        const fresh = await resolveAccessToken(
          ctx.host,
          ctx.auth.username,
          ctx.auth.password,
          { force: true },
        );
        return await doCall(fresh);
      }
      // token mode: không có password để re-login → yêu cầu user authorize lại.
      throw new HttpError(
        401,
        "FFM session đã hết hạn hoặc bị thu hồi — hãy authorize lại kết nối MCP.",
      );
    }
    throw err;
  }
}

async function rawStatistics(
  host: string,
  accessToken: string,
  countryCode: string,
  payload: Record<string, unknown>,
): Promise<StatisticsResponse> {
  const base = host.replace(/\/+$/, "");
  const url =
    `${base}/api/orders/statistics` +
    `?access_token=${encodeURIComponent(accessToken)}` +
    `&country_code=${encodeURIComponent(countryCode)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(payload ?? {}),
  });
  return (await readEnvelope(res, "statistics")) as StatisticsResponse;
}

export async function callStatistics(
  ctx: CallContext,
  payload: Record<string, unknown>,
): Promise<StatisticsResponse> {
  return withAuthRetry(ctx, (token) =>
    rawStatistics(ctx.host, token, ctx.countryCode, payload),
  );
}

async function rawShops(
  host: string,
  accessToken: string,
  countryCode: string,
): Promise<ShopLite[]> {
  const base = host.replace(/\/+$/, "");
  // is_show_all=true bắt buộc, nếu không /shops trả list partial (nhiều id miss).
  const url =
    `${base}/api/shops` +
    `?access_token=${encodeURIComponent(accessToken)}` +
    `&country_code=${encodeURIComponent(countryCode)}` +
    `&is_available=false&is_show_all=true`;

  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(accessToken),
  });
  const data = await readEnvelope(res, "shops");
  return Array.isArray(data) ? (data as ShopLite[]) : [];
}

// Lấy toàn bộ shop (id → name) để resolve nhãn khi group_by theo shop_id.
export async function fetchShops(ctx: CallContext): Promise<ShopLite[]> {
  return withAuthRetry(ctx, (token) =>
    rawShops(ctx.host, token, ctx.countryCode),
  );
}

async function rawUsers(
  host: string,
  accessToken: string,
  countryCode: string,
  keyword: string | undefined,
): Promise<UserLite[]> {
  const base = host.replace(/\/+$/, "");
  const url =
    `${base}/api/users/get_users` +
    `?access_token=${encodeURIComponent(accessToken)}` +
    `&country_code=${encodeURIComponent(countryCode)}`;
  // get_all=true: giống web FFM (utils/fetch-data.js) — lấy user thuộc country_code hoặc chưa
  // gán nước. Không gửi page → BE trả toàn bộ, không phân trang. `keyword` khớp đúng
  // email/phone/username hoặc tìm gần đúng first_name/last_name (UserController.index).
  const body = { get_all: true, filter: keyword ? { keyword: [keyword] } : {} };

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  const data = await readEnvelope(res, "users");
  // Có page → { data: [...] }; không page → { data: [...] } hoặc [] khi BE từ chối (group USER).
  const list = Array.isArray(data) ? data : data?.data;
  return Array.isArray(list) ? (list as UserLite[]) : [];
}

// Tra user theo keyword (bỏ trống = toàn bộ user của country) — UUID dùng cho filter
// assigning_sale_id / assigning_care_id / creator_id… và để resolve nhãn khi group_by user.
export async function fetchUsers(
  ctx: CallContext,
  keyword?: string,
): Promise<UserLite[]> {
  return withAuthRetry(ctx, (token) =>
    rawUsers(ctx.host, token, ctx.countryCode, keyword),
  );
}

// Gọi 1 API đọc dữ liệu của FFM (danh sách kho, courier, lý do, tag, sản phẩm…) cho tool
// list_filter_values. Trả NGUYÊN body vì mỗi API đặt kết quả ở khoá khác nhau.
export async function callApi(
  ctx: CallContext,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<any> {
  return withAuthRetry(ctx, async (token) => {
    const params = new URLSearchParams({ access_token: token, country_code: ctx.countryCode });
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }
    const res = await fetch(`${ctx.host.replace(/\/+$/, "")}/api${path}?${params}`, {
      method,
      headers: authHeaders(token),
      ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    });
    return readBody(res, path);
  });
}
