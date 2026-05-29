// Tool definitions + handler logic dùng chung cho cả 2 entry:
//   - stdio (src/index.ts): auth = password (env username/password).
//   - http  (src/http.ts):  auth = token (JWT FFM lấy từ OAuth session).
//
// Auth context KHÔNG đọc env trực tiếp ở đây — entry truyền vào qua `resolveAuth`
// (cho buildServer) hoặc `binding` (cho handleToolCall).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CallAuth, callGetOrders, fetchAllOrders } from "./api.js";
import { normalizeOrders } from "./normalize.js";

const BaseInput = {
  country_code: z.string().min(1),
  host: z.string().url().optional(),
  filter: z.record(z.unknown()).optional(),
  page: z.number().int().positive().optional(),
  page_size: z.number().int().positive().max(2000).optional(),
  extra: z.record(z.unknown()).optional(),
};

const GetOrdersInput = z.object({
  ...BaseInput,
  load_full: z.boolean().optional(),
  is_summarize: z.boolean().optional(),
});

const GetOrdersNormalizedInput = z.object({
  ...BaseInput,
  paginate: z.boolean().optional(),
  max_pages: z.number().int().positive().max(100).optional(),
});

const COMMON_PROPERTIES = {
  country_code: {
    type: "string",
    description:
      "BẮT BUỘC. Phone-code quốc gia. Supported (có currency map): " +
      "63=Philippines(PHP), 66=Thailand(THB), 60=Malaysia(MYR), " +
      "62=Indonesia(IDR), 65=Singapore(SGD). BE còn accept 856=Laos " +
      "nhưng MCP không có currency map → tiền fallback /100.",
  },
  host: {
    type: "string",
    description:
      "Base URL (gồm scheme). Stdio mode: override env SEA_FULFILLMENT_HOST. " +
      "Http/remote mode: BỎ QUA — host đã cố định theo session OAuth.",
  },
  filter: {
    type: "object",
    description:
      "Filter object — keys phổ biến: " +
      "pagination: page, page_size; search: keyword (string[]), order_ids " +
      "(number[]); status: statuses (string[] — new/confirmed/printed/" +
      "packing/pending/shipped/delivered/returning/returned/cancel), " +
      "sub_status, printed_count, processing_count; date range (dynamic " +
      "theo time_key): time_key (vd 'inserted_at'/'updated_at'/" +
      "'assign_sale_at'/'picked_up_at'/'send_to_partner_at'/" +
      "'delivered_at'/'first_assign_sale_at'), '<time_key>:ranges' = " +
      "{ since, until } với ISO 8601 NaiveDateTime " +
      "'YYYY-MM-DDTHH:MM:SS' (KHÔNG dùng unix epoch — BE silently trả " +
      "[]), '<time_key>:editor_ids' (number[]); advance filter — value " +
      "PHẢI là enum FE accept, KHÔNG free-form: shop_id (number | " +
      "'no_shop'); partner_id (number | 'no_courier'); service_types " +
      "(string từ ffmSettings); tags (number[] | 'no_tag', kèm " +
      "is_exclude_tags); total_quantity (number); cod ('no_cod' | " +
      "'has_cod' | '<eq|gt_or_eq|lt_or_eq>_<amount>'); " +
      "is_duplicated_phone/is_duplicated_ip (boolean true/false); " +
      "courier_reconciliation_status ('importing'|'courier_reconciling'|" +
      "'courier_reconciled'|'courier_not_yet_reconciled'); " +
      "customer_reconciliation_status ('new'|'sent_email'|'reconciled'|" +
      "'processing'|'completed'|'done'|'customer_not_yet_reconciled'); " +
      "assigning_sale_id/assigning_care_id (number | 'no_user' | " +
      "'has_user'); waybill_number ('no_waybill_number' | " +
      "'matched_waybill_number' — KHÔNG phải tracking string); " +
      "order_source ('non_marketplace'|'-3' shopee|'-4' lazada|'-9' " +
      "tiktok); pending_reason_id (number | -1); cancel_reason_id " +
      "(number | -2); shift ('morning'|'afternoon'|'evening'); " +
      "category_id (number | 'no_category'); business_countries_ids " +
      "(country_code | 'no_business_countries'); saved_filter_id, " +
      "slot_warehouse_id, combo_product, delivery_address_id (number). " +
      "Exclude: key + is_exclude_<key>: true. Sort: dùng `extra` — " +
      "{ sort_by, sort_direction:'asc'|'desc' }.",
  },
  page: { type: "number" },
  page_size: { type: "number" },
  extra: { type: "object", description: "Param phụ merge vào body request." },
};

export const TOOL_DEFS = [
  {
    name: "get_orders",
    description:
      "Lấy đơn hàng sea-fulfillment (FFM) — trả RAW response BE " +
      "(POST /api/orders/get_orders). Dùng khi cần dữ liệu thô hoặc field " +
      "BE chưa normalize. Nếu user muốn LIỆT KÊ / XUẤT BẢNG / EXCEL đơn " +
      "thì ưu tiên get_orders_normalized. BẮT BUỘC truyền country_code " +
      "(phone-code: 63=PH, 66=TH, 60=MY, 62=ID, 65=SG).",
    inputSchema: {
      type: "object",
      required: ["country_code"],
      properties: {
        ...COMMON_PROPERTIES,
        load_full: {
          type: "boolean",
          description:
            "Nếu true → BE trả full order schema (cần cho normalize).",
        },
        is_summarize: { type: "boolean" },
      },
    },
  },
  {
    name: "get_orders_normalized",
    description:
      "Lấy đơn hàng FFM đã NORMALIZE — dùng khi user muốn liệt kê, xuất " +
      "bảng, hoặc xuất Excel đơn hàng. Tự bật load_full=true, gọi BE rồi " +
      "normalize theo logic export Excel của FE. Trả mảng order phẳng: " +
      "display_id, status (text), customer_name, phone_number, " +
      "full_address, total_quantity, weight, tracking_number, " +
      "partner_name, cod, total_price (đã chia /100 theo currency), shop, " +
      "send_to_partner_at, shipped_at, completed_at, " +
      "courier_*/customer_* reconciliation, tags, service_types, … Bật " +
      "paginate=true để loop hết các trang. BẮT BUỘC country_code.",
    inputSchema: {
      type: "object",
      required: ["country_code"],
      properties: {
        ...COMMON_PROPERTIES,
        paginate: {
          type: "boolean",
          description: "true → fetch toàn bộ pages (cap by max_pages).",
        },
        max_pages: {
          type: "number",
          description: "Trần số page khi paginate=true, default 20.",
        },
      },
    },
  },
];

// host + auth resolved bởi entry (stdio đọc env, http đọc token).
export interface AuthBinding {
  host: string;
  auth: CallAuth;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export async function handleToolCall(
  name: string,
  rawArgs: unknown,
  binding: AuthBinding,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "get_orders": {
        const args = GetOrdersInput.parse(rawArgs ?? {});
        const ctx = {
          host: binding.host,
          countryCode: args.country_code,
          auth: binding.auth,
        };
        const params: Record<string, unknown> = {
          ...(args.extra ?? {}),
          filter: args.filter ?? {},
        };
        if (args.page != null) params.page = args.page;
        if (args.page_size != null) params.page_size = args.page_size;
        if (args.load_full != null) params.load_full = args.load_full;
        if (args.is_summarize != null) params.is_summarize = args.is_summarize;

        const data = await callGetOrders(ctx, params);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "get_orders_normalized": {
        const args = GetOrdersNormalizedInput.parse(rawArgs ?? {});
        const country = args.country_code;
        const ctx = { host: binding.host, countryCode: country, auth: binding.auth };

        let orders: Record<string, any>[];
        let pagination: Record<string, unknown> | null = null;

        if (args.paginate) {
          orders = (await fetchAllOrders(ctx, {
            filter: args.filter,
            pageSize: args.page_size,
            maxPages: args.max_pages,
            extraParams: args.extra,
          })) as Record<string, any>[];
        } else {
          const params: Record<string, unknown> = {
            ...(args.extra ?? {}),
            filter: args.filter ?? {},
            page: args.page ?? 1,
            page_size: args.page_size ?? 50,
            load_full: true,
          };
          const data = await callGetOrders(ctx, params);
          orders = Array.isArray(data?.data)
            ? (data.data as Record<string, any>[])
            : [];
          pagination = {
            page: data?.page,
            page_size: data?.page_size,
            total: data?.total,
            total_pages: data?.total_pages,
          };
        }

        const normalized = normalizeOrders(orders, { countryCode: country });
        const payload = {
          country_code: country,
          count: normalized.length,
          pagination,
          orders: normalized,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}

// resolveAuth: từ (extra của request handler, args đã parse) → AuthBinding.
// extra.authInfo có khi transport có auth (http). args để stdio đọc host override.
export type ResolveAuth = (
  extra: { authInfo?: { extra?: Record<string, unknown> } } | undefined,
  args: Record<string, unknown>,
) => AuthBinding;

export function buildServer(resolveAuth: ResolveAuth): Server {
  const server = new Server(
    { name: "ffm-mcp", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const binding = resolveAuth(extra as any, args);
    return handleToolCall(req.params.name, req.params.arguments, binding);
  });

  return server;
}
