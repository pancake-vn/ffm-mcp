// Wrapper gọi POST /api/orders/get_orders với auto-login.
//
// Tham chiếu:
//   - sea-fulfillment lib/sea_fulfillment_web/router.ex:132 (post "/orders/get_orders")
//   - sea-fulfillment lib/sea_fulfillment_web/controllers/order_controller.ex:11
//
// Auth: KHÔNG nhận access_token trực tiếp nữa. Caller truyền credentials
// (host + username + password); module này dùng auth.ts để lấy + cache
// token, và auto re-login khi 401.

import { invalidateToken, resolveAccessToken } from "./auth.js";

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export interface CallContext {
  host: string;
  username: string;
  password: string;
  countryCode: string;
}

export interface GetOrdersResponse {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
  data?: unknown[];
  [k: string]: unknown;
}

async function rawCall(
  host: string,
  accessToken: string,
  countryCode: string,
  params: Record<string, unknown>,
): Promise<GetOrdersResponse> {
  const base = host.replace(/\/+$/, "");
  const url =
    `${base}/api/orders/get_orders` +
    `?access_token=${encodeURIComponent(accessToken)}` +
    `&country_code=${encodeURIComponent(countryCode)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, body);
  }

  const json = (await res.json()) as {
    success?: boolean;
    data?: GetOrdersResponse;
    message?: string;
  };
  if (json?.success === false) {
    // BE đôi khi trả 200 + success:false cho auth failures.
    // Heuristic: message chứa "auth" / "token" / "login" / "unauthorized" → coi như 401.
    const msg = json.message || "";
    if (/auth|token|login|unauthor/i.test(msg)) {
      throw new HttpError(401, msg);
    }
    throw new Error(
      `get_orders failed: ${msg || JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return (json?.data ?? {}) as GetOrdersResponse;
}

export async function callGetOrders(
  ctx: CallContext,
  params: Record<string, unknown>,
): Promise<GetOrdersResponse> {
  if (!ctx.host) throw new Error("callGetOrders: host is required");
  let token = await resolveAccessToken(ctx.host, ctx.username, ctx.password);
  try {
    return await rawCall(ctx.host, token, ctx.countryCode, params);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      // Token cache có thể đã invalid (revoked / password đổi). Force re-login 1 lần.
      invalidateToken(ctx.host, ctx.username);
      token = await resolveAccessToken(
        ctx.host,
        ctx.username,
        ctx.password,
        { force: true },
      );
      return await rawCall(ctx.host, token, ctx.countryCode, params);
    }
    throw err;
  }
}

export async function fetchAllOrders(
  ctx: CallContext,
  opts: {
    filter?: Record<string, unknown>;
    pageSize?: number;
    maxPages?: number;
    extraParams?: Record<string, unknown>;
  },
): Promise<unknown[]> {
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 20;
  const collected: unknown[] = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await callGetOrders(ctx, {
      ...(opts.extraParams ?? {}),
      filter: opts.filter ?? {},
      page,
      page_size: pageSize,
      load_full: true,
    });
    const batch = Array.isArray(res?.data) ? (res.data as unknown[]) : [];
    collected.push(...batch);
    const totalPages = Number(res?.total_pages ?? 0);
    if (!totalPages || page >= totalPages) break;
    page += 1;
  }
  return collected;
}
