#!/usr/bin/env node
// MCP server cho sea-fulfillment orders.
//
// Transport: stdio.
// Tools:
//   - get_orders            : query 1 page get_orders, trả raw response BE.
//   - get_orders_normalized : query (1 page hoặc all pages) + normalize theo
//                             OrderExportExcel.formatData.
//
// Auth: server tự gọi POST /api/users/login/password lấy access_token bằng
// SEA_FULFILLMENT_USERNAME + SEA_FULFILLMENT_PASSWORD, cache theo `exp`
// claim của JWT (30 ngày), auto re-login khi BE trả 401. Tool input có thể
// override `username` / `password` per-call.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callGetOrders, fetchAllOrders } from "./api.js";
import { normalizeOrders } from "./normalize.js";

const ENV_HOST = process.env.SEA_FULFILLMENT_HOST || "";
const ENV_USERNAME = process.env.SEA_FULFILLMENT_USERNAME || "";
const ENV_PASSWORD = process.env.SEA_FULFILLMENT_PASSWORD || "";

const BaseInput = {
  // BẮT BUỘC mỗi tool call — không có default env. Tránh tình huống config
  // env một country nhưng dữ liệu user cần lại nằm country khác.
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

function resolveCredentials(): { username: string; password: string } {
  if (!ENV_USERNAME || !ENV_PASSWORD) {
    throw new Error(
      "Missing credentials. BẮT BUỘC set env SEA_FULFILLMENT_USERNAME + " +
        "SEA_FULFILLMENT_PASSWORD trong config MCP client. Server sẽ tự " +
        "gọi POST /api/users/login/password lấy access_token, cache + " +
        "refresh tự động.",
    );
  }
  return { username: ENV_USERNAME, password: ENV_PASSWORD };
}

function resolveHost(input: { host?: string }): string {
  const host = input.host || ENV_HOST;
  if (!host) {
    throw new Error(
      "Missing host. BẮT BUỘC set env SEA_FULFILLMENT_HOST (vd " +
        "https://fulfillment.pancake.vn, https://bigate.co …) hoặc " +
        "truyền tham số `host` mỗi call. Xem README §2.3 cho danh sách " +
        "supported_hosts.",
    );
  }
  return host;
}

// Auth (username/password) lấy hoàn toàn từ env — KHÔNG expose ra tool
// input. Caller (AI client) chỉ truyền query params; server tự handle
// login + cache + refresh.
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
      "Base URL (gồm scheme). BẮT BUỘC — không default. " +
      "Nếu env SEA_FULFILLMENT_HOST chưa set thì phải truyền tham số này. " +
      "Các host BE supported (lib/app/constant.ex:72): " +
      "https://fulfillment.pancake.vn (app_id=99,PFFM), " +
      "https://g-solution.vn (1,GIP), https://afgwarehouse.net (2,AFG), " +
      "https://app.mspeedyexpress.com (3,MSX), https://lynexpress.co (4,LYN), " +
      "https://buber.pancake.vn (5,BUBER), https://admin.ifgfulfillmentglobal.com (6,IFG), " +
      "https://bigate.co (9,BIG).",
  },
  filter: {
    type: "object",
    description:
      "Filter object — keys phổ biến (FE sea-fulfillment-web dùng): " +
      "pagination: page, page_size; search: keyword (string[]), order_ids " +
      "(number[]); status: statuses (string[] — new/confirmed/printed/" +
      "packing/pending/shipped/delivered/returning/returned/cancel), " +
      "sub_status, printed_count, processing_count; date range (dynamic " +
      "theo time_key): time_key (vd 'inserted_at'/'updated_at'/" +
      "'assign_sale_at'/'picked_up_at'/'send_to_partner_at'/" +
      "'delivered_at'/'first_assign_sale_at'), '<time_key>:ranges' = " +
      "{ since, until } với ISO 8601 NaiveDateTime " +
      "'YYYY-MM-DDTHH:MM:SS' (KHÔNG dùng unix epoch — BE silently trả " +
      "[]), '<time_key>:editor_ids' (number[]); advance: shop_id, " +
      "partner_id, service_types, tags, " +
      "product_id, variation_id, total_quantity {min,max}, cod {min,max}, " +
      "is_duplicated_phone, is_duplicated_ip, courier_reconciliation_status, " +
      "customer_reconciliation_status, assigning_sale_id, assigning_care_id, " +
      "delivery_address_id, waybill_number, combo_product, order_source, " +
      "saved_filter_id, slot_warehouse_id. Sort: dùng `extra` field — " +
      "{ sort_by, sort_direction:'asc'|'desc' }. Xem README §4.1 cho " +
      "chi tiết.",
  },
  page: { type: "number" },
  page_size: { type: "number" },
  extra: { type: "object", description: "Param phụ merge vào body request." },
};

const server = new Server(
  { name: "ffm-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_orders",
      description:
        "Gọi POST /api/orders/get_orders (sea-fulfillment) và trả raw " +
        "response. Auth tự động: server gọi POST /api/users/login/password " +
        "bằng SEA_FULFILLMENT_USERNAME + SEA_FULFILLMENT_PASSWORD, cache " +
        "JWT 30 ngày, re-login khi 401.",
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
        "Gọi get_orders với load_full=true rồi normalize từng order theo " +
        "OrderExportExcel.formatData (sea-fulfillment-web). Trả mảng order " +
        "phẳng với các field: full_address, weight, total_quantity, " +
        "tracking_number, partner_name, product_name, remarks, " +
        "customer_name, status (text), shop, send_to_partner_at, " +
        "shipped_at, completed_at, courier_*/customer_* reconciliation, " +
        "tags, … Bật paginate=true để loop hết. Auth tự động (xem " +
        "get_orders).",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  try {
    switch (name) {
      case "get_orders": {
        const args = GetOrdersInput.parse(rawArgs ?? {});
        const { username, password } = resolveCredentials();
        const host = resolveHost(args);
        const country = args.country_code;
        const params: Record<string, unknown> = {
          ...(args.extra ?? {}),
          filter: args.filter ?? {},
        };
        if (args.page != null) params.page = args.page;
        if (args.page_size != null) params.page_size = args.page_size;
        if (args.load_full != null) params.load_full = args.load_full;
        if (args.is_summarize != null) params.is_summarize = args.is_summarize;

        const data = await callGetOrders(
          { host, username, password, countryCode: country },
          params,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "get_orders_normalized": {
        const args = GetOrdersNormalizedInput.parse(rawArgs ?? {});
        const { username, password } = resolveCredentials();
        const host = resolveHost(args);
        const country = args.country_code;
        const ctx = { host, username, password, countryCode: country };

        let orders: any[];
        let pagination: Record<string, unknown> | null = null;

        if (args.paginate) {
          orders = await fetchAllOrders(ctx, {
            filter: args.filter,
            pageSize: args.page_size,
            maxPages: args.max_pages,
            extraParams: args.extra,
          });
        } else {
          const params: Record<string, unknown> = {
            ...(args.extra ?? {}),
            filter: args.filter ?? {},
            page: args.page ?? 1,
            page_size: args.page_size ?? 50,
            load_full: true,
          };
          const data = await callGetOrders(ctx, params);
          orders = Array.isArray(data?.data) ? (data.data as any[]) : [];
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
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[ffm-mcp] ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[ffm-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
