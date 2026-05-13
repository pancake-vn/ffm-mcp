// Wrapper gọi POST /api/orders/get_orders của sea-fulfillment BE.
// Tham chiếu:
//   - sea-fulfillment lib/sea_fulfillment_web/router.ex:132 (post "/orders/get_orders")
//   - sea-fulfillment lib/sea_fulfillment_web/controllers/order_controller.ex:11 (get_orders → index)
//   - sea-fulfillment-web actions/order.js:57 (FE call pattern, dùng access_token query param)

export interface GetOrdersOptions {
  accessToken: string;
  countryCode: string;
  host?: string; // override host, vd "https://fulfillment.pancake.vn"
  params: Record<string, unknown>;
}

export interface GetOrdersResponse {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
  data?: unknown[];
  [k: string]: unknown;
}

const DEFAULT_HOST = "https://fulfillment.pancake.vn";

export async function callGetOrders({
  accessToken,
  countryCode,
  host,
  params,
}: GetOrdersOptions): Promise<GetOrdersResponse> {
  const base = (host || DEFAULT_HOST).replace(/\/+$/, "");
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
    const text = await res.text().catch(() => "");
    throw new Error(`get_orders HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as { success?: boolean; data?: GetOrdersResponse; message?: string };
  if (json?.success === false) {
    throw new Error(`get_orders failed: ${json.message || JSON.stringify(json).slice(0, 300)}`);
  }
  return (json?.data ?? {}) as GetOrdersResponse;
}

// Load full theo paging tới khi hết hoặc đạt maxPages (an toàn ko vô tận).
export async function fetchAllOrders(opts: {
  accessToken: string;
  countryCode: string;
  host?: string;
  filter?: Record<string, unknown>;
  pageSize?: number;
  maxPages?: number;
  extraParams?: Record<string, unknown>;
}): Promise<unknown[]> {
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 20;
  const collected: unknown[] = [];
  let page = 1;
  // load_full=true để BE trả full schema giống FE flow OrderExportExcel.
  while (page <= maxPages) {
    const res = await callGetOrders({
      accessToken: opts.accessToken,
      countryCode: opts.countryCode,
      host: opts.host,
      params: {
        ...(opts.extraParams ?? {}),
        filter: opts.filter ?? {},
        page,
        page_size: pageSize,
        load_full: true,
      },
    });
    const batch = Array.isArray(res?.data) ? (res.data as unknown[]) : [];
    collected.push(...batch);
    const totalPages = Number(res?.total_pages ?? 0);
    if (!totalPages || page >= totalPages) break;
    page += 1;
  }
  return collected;
}
