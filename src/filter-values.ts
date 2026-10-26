// Tool list_filter_values: trả danh sách giá trị hợp lệ của 1 bộ lọc (id kho, id courier, tên
// tag, id lý do pending…) để AI KHÔNG phải đoán. Đoán sai id/tên → BE trả 0 đơn mà không báo lỗi.
//
// Mỗi bộ lọc lấy cùng nguồn dữ liệu với màn "Add indicator" của web FFM
// (sea-fulfillment-web components/AdvanceFilterV1.js), giữ cùng dạng value web gửi lên BE.

import { callApi, CallContext, fetchShops } from "./api.js";
import { SUB_STATUS_TEXT } from "./constants.js";

export interface FilterValue {
  value: string | number;
  label: string;
  [k: string]: unknown;
}

interface Source {
  // Khoá đặt vào `filter` của order_statistics.
  send_as: string;
  // "server": keyword gửi lên BE (bắt buộc có); "local": tải hết rồi lọc tại MCP.
  search: "server" | "local";
  // Bộ lọc cấp dưới cần id cấp trên (huyện cần tỉnh, xã cần huyện).
  parent?: string;
  note?: string;
  // Trả kèm `total` khi BE phân trang (tổng thật lớn hơn số dòng nhận về).
  load: (
    ctx: CallContext,
    keyword: string | undefined,
    parentId: string | undefined,
  ) => Promise<FilterValue[] | { values: FilterValue[]; total: number }>;
}

const MAX_VALUES = 200;

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ffm_settings lọc theo `type` ở BE (FFMSettingController.index).
async function settingsOfType(ctx: CallContext, type: string): Promise<any[]> {
  return list((await callApi(ctx, "GET", "/ffm_settings", { query: { type, app_type: "FFM" } }))?.data);
}

async function reasons(ctx: CallContext, type: string, otherId: number): Promise<FilterValue[]> {
  const rows = (await settingsOfType(ctx, type)).map((s) => ({ value: s.id, label: String(s.settings?.reason ?? s.id) }));
  // Web thêm "Other reason" với id âm cố định (utils/advance-filter.js getReasonOptions).
  return [...rows, { value: otherId, label: "Other reason" }];
}

const SOURCES: Record<string, Source> = {
  slot_warehouse_id: {
    send_as: "slot_warehouse_id",
    search: "local",
    load: async (ctx) =>
      list((await callApi(ctx, "GET", "/warehouses"))?.data).map((w) => ({
        value: w.id,
        label: String(w.name ?? w.id),
        address: w.full_address ?? null,
      })),
  },
  shop_id: {
    send_as: "shop_id",
    search: "local",
    load: async (ctx) => (await fetchShops(ctx)).map((s) => ({ value: s.id, label: String(s.name ?? s.id) })),
  },
  partner_id: {
    send_as: "partner_id",
    search: "local",
    load: async (ctx) => [
      { value: "no_courier", label: "No courier" },
      // Web bỏ partner id 8 khỏi danh sách (actions/auth.js getPartners).
      ...list((await callApi(ctx, "GET", "/partners"))?.data)
        .filter((p) => p.id != 8)
        .map((p) => ({ value: p.id, label: String(p.common_settings?.custom_name || p.name || p.id) })),
    ],
  },
  service_types: {
    send_as: "service_types",
    search: "local",
    note: "Giá trị là TÊN service type.",
    load: async (ctx) => [
      { value: "No Service Type", label: "No Service Type" },
      ...(await settingsOfType(ctx, "customer_service_type"))
        .map((s) => s.settings?.name)
        .filter((n) => typeof n === "string" && n !== "")
        .map((n) => ({ value: n, label: n })),
    ],
  },
  include_tags: {
    send_as: "include_tags",
    search: "local",
    note: "Giá trị là TÊN tag (value), dùng cho cả include_tags / exclude_tags. Sai 1 ký tự → 0 đơn.",
    load: async (ctx) => {
      const groups = list((await callApi(ctx, "GET", "/orders/tag_group_options"))?.data);
      const seen = new Set<string>();
      const out: FilterValue[] = [{ value: "no_tag", label: "No tag" }];
      for (const g of groups) {
        for (const c of list(g.children)) {
          if (typeof c.tag_name !== "string" || seen.has(c.tag_name)) continue;
          seen.add(c.tag_name);
          out.push({ value: c.tag_name, label: String(c.label ?? c.tag_name), group: g.label ?? null });
        }
      }
      return out;
    },
  },
  product_id: {
    send_as: "product_id",
    search: "server",
    load: async (ctx, keyword) => {
      // Không gửi page_size thì BE chỉ trả 30 dòng đầu (Parse.page_info).
      const products = (await callApi(ctx, "POST", "/products/get_products", { body: { text: keyword, page_size: MAX_VALUES } }))
        ?.products;
      const values = list(products?.data).map((p) => ({
        value: p.id,
        label: String(p.name ?? p.id),
        custom_id: p.custom_id ?? null,
      }));
      return { values, total: Number(products?.total_entries) || values.length };
    },
  },
  variation_id: {
    send_as: "variation_id",
    search: "server",
    load: async (ctx, keyword) =>
      // get_all → BE trả mảng thẳng trong `data` (VariationController.index), không phân trang.
      list((await callApi(ctx, "POST", "/variations/get_variations", { body: { text: keyword, get_all: true } }))?.data).map(
        (v) => ({
          value: v.id,
          label: String(v.product?.name ?? v.id),
          custom_id: v.custom_id ?? null,
          fields: list(v.fields).map((f) => `${f.name}: ${f.value}`).join(", ") || null,
        }),
      ),
  },
  combo_product: {
    send_as: "combo_product",
    search: "server",
    note: "Giá trị là pos_combo_id (không phải id combo trong FFM).",
    // Web dùng /products/search_combo (chỉ khớp ĐÚNG nguyên tên); /products/combo tìm gần đúng theo
    // tên / mã nên hợp với AI hơn, nhưng 1 combo POS có thể có nhiều dòng (mỗi shop) → gộp theo pos_combo_id.
    load: async (ctx, keyword) => {
      const body = await callApi(ctx, "GET", "/products/combo", { query: { keyword, page_size: MAX_VALUES } });
      const rows = list(body?.entries);
      const seen = new Set<unknown>();
      const values = rows
        .filter((c) => !seen.has(c.pos_combo_id) && seen.add(c.pos_combo_id))
        .map((c) => ({ value: c.pos_combo_id, label: String(c.name ?? c.pos_combo_id), custom_id: c.custom_id ?? null }));
      // total_entries đếm DÒNG (trước khi gộp) → chỉ dùng khi BE cắt bớt dòng.
      const beTotal = Number(body?.total_entries) || 0;
      return { values, total: beTotal > rows.length ? beTotal : values.length };
    },
  },
  pending_reason_id: {
    send_as: "pending_reason_id",
    search: "local",
    load: (ctx) => reasons(ctx, "order_pending_reason", -1),
  },
  cancel_reason_id: {
    send_as: "cancel_reason_id",
    search: "local",
    load: (ctx) => reasons(ctx, "order_cancellation_reason", -2),
  },
  province_id: {
    send_as: "province_id",
    search: "local",
    load: async (ctx) =>
      list((await callApi(ctx, "GET", "/geo/provinces"))?.data).map((p) => ({ value: p.id, label: String(p.name ?? p.id) })),
  },
  district_id: {
    send_as: "district_id",
    search: "local",
    parent: "province_id",
    load: async (ctx, _kw, parentId) =>
      list((await callApi(ctx, "GET", "/geo/districts", { query: { province_id: parentId } }))?.data).map((d) => ({
        value: d.id,
        label: String(d.name ?? d.id),
      })),
  },
  commune_id: {
    send_as: "commune_id",
    search: "local",
    parent: "district_id",
    load: async (ctx, _kw, parentId) =>
      list((await callApi(ctx, "GET", "/geo/communes", { query: { district_id: parentId } }))?.data).map((c) => ({
        value: c.id,
        label: String(c.name ?? c.id),
      })),
  },
  sub_status: {
    send_as: "sub_status",
    search: "local",
    load: async () =>
      Object.entries(SUB_STATUS_TEXT)
        .filter(([k]) => k !== "no_sub_status") // bucket của group_by, không phải giá trị lọc
        .map(([value, label]) => ({ value, label })),
  },
  saved_filter: {
    send_as: "(cả filter)",
    search: "local",
    note:
      "Bộ lọc đã lưu ở màn Order Data Statistics. Dùng nguyên `filters` làm `filter` của " +
      "order_statistics (có thể thêm khoá khác); KHÔNG gửi khoá saved_filter_id. Nếu MCP báo " +
      "khoá không hợp lệ thì báo user khoá đó chưa hỗ trợ, KHÔNG tự bỏ khoá rồi trả số.",
    load: async (ctx) =>
      list((await callApi(ctx, "GET", "/saved_filters", { query: { table_key: "order-data" } }))?.data).map((f) => ({
        value: f.id,
        label: String(f.name ?? f.id),
        filters: f.filters ?? {},
      })),
  },
};

// Tên khác AI hay dùng cho cùng 1 nguồn.
const KEY_ALIASES: Record<string, string> = {
  exclude_tags: "include_tags",
  tags: "include_tags",
  order_sub_status: "sub_status",
  saved_filter_id: "saved_filter",
};

export const FILTER_VALUE_KEYS: ReadonlyArray<string> = [...Object.keys(SOURCES), ...Object.keys(KEY_ALIASES)];

// So khớp không phân biệt hoa thường và dấu tiếng Việt.
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();

export async function listFilterValues(
  ctx: CallContext,
  filterKey: string,
  keyword?: string,
  parentId?: string,
): Promise<Record<string, unknown>> {
  const key = KEY_ALIASES[filterKey] ?? filterKey;
  const source = SOURCES[key];
  if (!source) {
    throw new Error(`filter_key \`${filterKey}\` không hỗ trợ. Hỗ trợ: ${FILTER_VALUE_KEYS.join(", ")}.`);
  }
  if (source.search === "server" && !keyword) {
    throw new Error(`\`${filterKey}\` cần keyword (tên hoặc mã) — danh sách quá lớn để tải hết.`);
  }
  if (source.parent && !parentId) {
    throw new Error(`\`${filterKey}\` cần parent_id = id của \`${source.parent}\` (gọi list_filter_values với ${source.parent} trước).`);
  }

  const loaded = await source.load(ctx, keyword, parentId);
  let values = Array.isArray(loaded) ? loaded : loaded.values;
  if (keyword && source.search === "local") {
    const kw = fold(keyword);
    values = values.filter((v) => fold(`${v.label} ${v.value}`).includes(kw));
  }
  const total = Array.isArray(loaded) ? values.length : loaded.total;
  const returned = values.slice(0, MAX_VALUES);

  return {
    filter_key: filterKey,
    send_as: filterKey === "exclude_tags" ? "exclude_tags" : source.send_as,
    total,
    values: returned,
    ...(total > returned.length
      ? { truncated: `Chỉ trả ${returned.length}/${total} giá trị — thêm keyword để thu hẹp.` }
      : {}),
    ...(source.note ? { note: source.note } : {}),
  };
}
