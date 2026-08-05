// Tool definitions + handler logic dùng chung cho cả 2 entry:
//   - stdio (src/index.ts): auth = password (env username/password).
//   - http  (src/http.ts):  auth = token (JWT FFM lấy từ OAuth session).
//
// Auth context KHÔNG đọc env trực tiếp ở đây — entry truyền vào qua `resolveAuth`
// (cho buildServer) hoặc `binding` (cho handleToolCall).
//
// Tool DUY NHẤT: order_statistics — gọi POST /api/orders/statistics (Order Data
// Statistics manual query, KHÔNG AI), trả aggregation group_by + metrics + totals
// đã decorate nhãn/tiền tệ. KHÔNG list full order (khác get_orders cũ).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CallAuth, callStatistics, fetchShops } from "./api.js";
import {
  DATE_FIELD_KEYS,
  GROUP_FIELDS,
  METRIC_KEYS,
} from "./constants.js";
import { validateFilter } from "./filter-schema.js";
import { esOffsetString, localRangesToUtc, resolveUtcOffset } from "./filter.js";
import { decorateStatistics } from "./statistics.js";

const StatisticsInput = z.object({
  country_code: z.string().min(1),
  host: z.string().url().optional(),
  filter: z.record(z.unknown()).optional(),
  group_by: z.union([z.string(), z.array(z.string())]).optional(),
  metrics: z.array(z.string()).optional(),
  time_key: z.string().optional(),
  interval: z.string().optional(),
  timezone: z.union([z.number(), z.string()]).optional(),
  size: z.number().int().positive().max(1000).optional(),
});

const FILTER_DESCRIPTION =
  "Filter object — CÙNG schema get_orders (apply_es_filter). ⚠️ TÊN KHOÁ PHẢI " +
  "CHÍNH XÁC: BE bỏ qua khoá lạ và trả 0 đơn mà KHÔNG báo lỗi (vd viết " +
  "`statuses` thay vì `status` → 0 đơn, tưởng nhầm là kỳ đó không có đơn). MCP " +
  "chặn khoá lạ và báo lỗi thay vì trả số sai. Khoá dạng terms (status, " +
  "sub_status, shop_id, marketplace_id, tags, category_id, slot_warehouse_id, " +
  "pending_reason_id, cancel_reason_id, shift, business_countries_ids, " +
  "saved_filter_id, delivery_address_id, total_quantity) PHẢI là MẢNG — " +
  "`shop_id: [13]` chứ KHÔNG phải `shop_id: 13` (MCP tự wrap giúp nếu lỡ gửi số lẻ). " +
  "Keys phổ biến: search: keyword (string[]), order_ids (number[]); trạng thái: " +
  "`status` (string[] — new/confirmed/printed/packing/pending/shipped/delivered/" +
  "returning/returned/cancel — TÊN LÀ `status`, KHÔNG PHẢI `statuses`), " +
  "sub_status (string[]); date range (dynamic theo time_key): " +
  "time_key (vd 'inserted_at'/'updated_at'/'assign_sale_at'/'picked_up_at'/" +
  "'send_to_partner_at'/'delivered_at'/'first_assign_sale_at'), " +
  "'<time_key>:ranges' = { since, until } dạng ISO 'YYYY-MM-DDTHH:MM:SS' theo " +
  "GIỜ LOCAL (của user nếu truyền `timezone`, không thì giờ của country): MCP tự " +
  "quy đổi sang mốc UTC tuyệt đối (hậu tố 'Z') trước khi gọi BE. KHÔNG dùng unix " +
  "epoch (BE silently trả rỗng). Nếu tự thêm hậu tố 'Z'/offset thì coi là absolute, " +
  "MCP không shift nữa. Advance filter — value PHẢI là enum FE accept, KHÔNG " +
  "free-form: shop_id (number[] — mảng, hoặc 'no_shop'); partner_id (number | " +
  "'no_courier'); service_types (string); tags (number[] | 'no_tag', kèm is_exclude_tags); " +
  "total_quantity (number); cod ('no_cod' | 'has_cod' | " +
  "'<eq|gt_or_eq|lt_or_eq>_<amount>'); is_duplicated_phone/is_duplicated_ip " +
  "(boolean); courier_reconciliation_status ('importing'|'courier_reconciling'|" +
  "'courier_reconciled'|'courier_not_yet_reconciled'); " +
  "customer_reconciliation_status ('new'|'sent_email'|'reconciled'|'processing'|" +
  "'completed'|'done'|'customer_not_yet_reconciled'); assigning_sale_id/" +
  "assigning_care_id (number | 'no_user' | 'has_user'); waybill_number " +
  "('no_waybill_number' | 'matched_waybill_number'); order_source " +
  "('non_marketplace'|'-3' shopee|'-4' lazada|'-9' tiktok); pending_reason_id " +
  "(number | -1); cancel_reason_id (number | -2); shift " +
  "('morning'|'afternoon'|'evening'); category_id (number | 'no_category'); " +
  "business_countries_ids (country_code | 'no_business_countries'); " +
  "saved_filter_id, slot_warehouse_id, combo_product, delivery_address_id " +
  "(number). Exclude: key + is_exclude_<key>: true.";

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
  filter: { type: "object", description: FILTER_DESCRIPTION },
  group_by: {
    type: ["string", "array"],
    items: { type: "string", enum: [...GROUP_FIELDS] },
    description:
      "Chiều gom nhóm (tối đa 2). Hợp lệ: " +
      GROUP_FIELDS.join(" | ") +
      ". Rỗng/bỏ trống → chỉ trả tổng (totals). 'date' PHẢI đứng một mình " +
      "(histogram) — kèm chiều khác thì BE chỉ giữ date. VD ['status'] hoặc " +
      "['status','shop_id'] (cross-tab).",
  },
  metrics: {
    type: "array",
    items: { type: "string", enum: [...METRIC_KEYS] },
    description:
      "Field số cần sum. Default ['cod']. Số đơn (count) LUÔN có sẵn không cần " +
      "khai. Billing: cod, transfer_money, shipping_fee, discount, surcharge, " +
      "extra_price, total_quantity. Reconciliation (phẳng từ order_partners): " +
      "courier_*/customer_* của shipping_fee/shipping_fee_tax/cod_fee/cod_fee_tax/" +
      "insurance_fee/return_fee/return_fee_tax/ffm_fee/total_fee. Tiền được scale " +
      "sẵn theo currency (recon PH dùng PHP100 → /100).",
  },
  time_key: {
    type: "string",
    enum: [...DATE_FIELD_KEYS],
    description:
      "Khi group_by chứa 'date': mốc timestamp để bucket (default updated_at). " +
      DATE_FIELD_KEYS.join(" | ") + ".",
  },
  interval: {
    type: "string",
    enum: ["day", "week", "month"],
    description: "Khi group_by chứa 'date': kích thước bucket histogram (default day).",
  },
  timezone: {
    type: ["number", "string"],
    description:
      "Offset giờ local của USER — suy ra từ giờ/locale hiện tại (vd VN/TH → 7, " +
      "PH/SG/MY → 8; cũng nhận '+07:00'). Dùng CHO 2 việc: (1) hiểu since/until " +
      "trong filter `*:ranges` là giờ local nào để quy sang mốc UTC tuyệt đối; " +
      "(2) time_zone cho date_histogram khi group_by 'date' (chỉ khi đó MCP mới " +
      "gửi field này xuống BE — gửi thừa sẽ làm BE shift cửa sổ lọc). LUÔN truyền " +
      "khi có date range hoặc group_by date. Thiếu → fallback timezone của " +
      "country_code (có thể lệch ranh giới ngày).",
  },
  size: {
    type: "number",
    description: "Số bucket tối đa cho MỖI tầng terms agg (default 100, cap 1000).",
  },
};

export const TOOL_DEFS = [
  {
    name: "order_statistics",
    description:
      "Thống kê dữ liệu đơn hàng sea-fulfillment (FFM) qua ES aggregation " +
      "(POST /api/orders/statistics) — chính là 'Order Data Statistics manual " +
      "query (No AI)' trên web. Trả count tổng + số liệu group-by (KHÔNG trả full " +
      "order doc). Dùng khi user muốn ĐẾM / TỔNG HỢP / BÁO CÁO theo nhóm (vd 'đếm " +
      "đơn theo trạng thái', 'tổng COD theo shop tháng này', 'số đơn giao mỗi ngày " +
      "7 ngày qua'). Cấu hình: filter (lọc, cùng schema get_orders) + group_by " +
      "(tối đa 2 chiều, 'date' đứng riêng) + metrics (field số cần sum). Kết quả " +
      "đã decorate: nhãn người đọc (status text, shop name, marketplace) + tiền tệ " +
      "scale sẵn. BẮT BUỘC country_code (63=PH, 66=TH, 60=MY, 62=ID, 65=SG). Khi " +
      "lọc/gom theo thời gian BẮT BUỘC kèm `timezone` theo giờ local của user.",
    inputSchema: {
      type: "object",
      required: ["country_code"],
      properties: { ...COMMON_PROPERTIES },
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
      case "order_statistics": {
        const args = StatisticsInput.parse(rawArgs ?? {});
        const country = args.country_code;
        const ctx = { host: binding.host, countryCode: country, auth: binding.auth };

        const offset = resolveUtcOffset(args.timezone, country);
        // Chặn khoá filter sai tên (BE trả 0 đơn im lặng) + wrap scalar → mảng.
        const checked = validateFilter(args.filter);
        // Range → mốc UTC tuyệt đối (có "Z") ⇒ BE không gắn offset lần 2.
        const filter = localRangesToUtc(checked, offset) ?? {};

        const requestedDims = Array.isArray(args.group_by)
          ? args.group_by
          : args.group_by
            ? [args.group_by]
            : [];

        const payload: Record<string, unknown> = { filter };
        if (args.group_by != null) payload.group_by = args.group_by;
        if (args.metrics?.length) payload.metrics = args.metrics;
        if (args.time_key) payload.time_key = args.time_key;
        if (args.interval) payload.interval = args.interval;
        if (args.size != null) payload.size = args.size;
        // CHỈ gửi timezone khi group_by date — lúc đó BE cần cho date_histogram time_zone.
        // Gửi thừa là có hại: BE dùng chính giá trị này để gắn offset vào range naive
        // (normalize_range_timezone) → lệch cửa sổ. Range của MCP đã có "Z" nên không bị
        // gắn, nhưng không gửi thừa vẫn an toàn hơn.
        if (requestedDims.includes("date")) payload.timezone = esOffsetString(offset);

        const data = await callStatistics(ctx, payload);

        // Resolve tên shop khi (và chỉ khi) BE thực sự group theo shop_id.
        const dims = Array.isArray(data.group_by) ? data.group_by : [];
        const shopsById = dims.includes("shop_id")
          ? Object.fromEntries((await fetchShops(ctx)).map((s) => [String(s.id), s]))
          : {};

        const decorated = decorateStatistics(data, { countryCode: country, shopsById });
        return {
          content: [{ type: "text", text: JSON.stringify(decorated, null, 2) }],
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
    { name: "ffm-mcp", version: "0.4.0" },
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
