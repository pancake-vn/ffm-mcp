// Wrapper gọi POST /api/orders/get_orders với 2 kiểu auth:
//   - password: tự login (auth.ts) + cache + retry re-login khi 401 (stdio mode).
//   - token:    dùng JWT FFM có sẵn (http/OAuth mode); 401 → báo re-authorize
//               vì không giữ password để re-login.

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

export interface GetOrdersResponse {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
  data?: unknown[];
  [k: string]: unknown;
}

async function resolveToken(ctx: CallContext): Promise<string> {
  if (ctx.auth.kind === "token") return ctx.auth.token;
  return resolveAccessToken(ctx.host, ctx.auth.username, ctx.auth.password);
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
  const token = await resolveToken(ctx);
  try {
    return await rawCall(ctx.host, token, ctx.countryCode, params);
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
        return await rawCall(ctx.host, fresh, ctx.countryCode, params);
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
