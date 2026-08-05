// Validate + chuẩn hoá KHOÁ filter trước khi gọi BE.
//
// Vì sao cần: SeaFulfillment.Services.EsV2.Order.apply_es_filter/2 là `case key do` với
// clause cuối là catch-all — khoá LẠ (vd "statuses") vẫn được build thành
// `terms: %{statuses => [...]}` trên field KHÔNG tồn tại trong mapping ES → match 0 doc,
// BE trả về 0 đơn mà KHÔNG báo lỗi. Người đọc tưởng "kỳ đó không có đơn" trong khi thực
// tế là gõ sai tên khoá. Tương tự, khoá catch-all nhận scalar (`shop_id: 13`) sinh
// `terms` sai kiểu → cũng ra 0.
//
// MCP chặn ngay tại đây: khoá lạ → lỗi rõ ràng kèm gợi ý; scalar ở khoá dạng `terms`
// → tự wrap thành mảng (đúng ý định caller, không đổi ngữ nghĩa).

// Khoá rơi vào catch-all của apply_es_filter → BE build `terms: %{key => term}`.
// PHẢI là mảng (BE chỉ List.wrap cho status/sub_status/need_attention_tags/
// sub_sale_pending_reason) → MCP tự wrap để không ra 0 đơn im lặng.
const TERM_ARRAY_KEYS: ReadonlyArray<string> = [
  "status",
  "sub_status",
  "shop_id",
  "marketplace_id",
  "tags",
  "category_id",
  "slot_warehouse_id",
  "pending_reason_id",
  "cancel_reason_id",
  "shift",
  "business_countries_ids",
  "saved_filter_id",
  "delivery_address_id",
  "total_quantity",
];

// Khoá có clause riêng trong apply_es_filter → giữ nguyên kiểu caller gửi
// (string / boolean / number / array tuỳ clause).
const PASSTHROUGH_KEYS: ReadonlyArray<string> = [
  "time_key",
  "order_ids",
  "printed_count",
  "processing_count",
  "include_tags",
  "exclude_tags",
  "service_types",
  "assigning_sale_id",
  "assigning_care_id",
  "variation_id",
  "product_id",
  "waybill_number",
  "courier_reconciliation_status",
  "customer_reconciliation_status",
  "need_attention_tags",
  "sub_sale_pending_reason",
  "is_duplicated_phone",
  "is_duplicated_ip",
  "partner_id",
  "order_source",
  "combo_product",
  "keyword",
  "cod",
];

// Khoá động hợp lệ: "<time_key>:ranges", "<time_key>:editor_ids", cờ "is_exclude_<key>".
const DYNAMIC_KEY = /(?::ranges|:editor_ids)$/;
const EXCLUDE_FLAG = /^is_exclude_/;

const KNOWN_KEYS: ReadonlyArray<string> = [...TERM_ARRAY_KEYS, ...PASSTHROUGH_KEYS];

// Gợi ý khoá đúng cho lỗi chính tả hay gặp (số nhiều/ít, khác biệt dấu gạch dưới).
function suggestKey(key: string): string | undefined {
  // "statuses" → "status" (bỏ "es"), "shop_ids" → "shop_id" (bỏ "s"), "tag" → "tags".
  const candidates = [
    key.replace(/es$/, ""),
    key.replace(/s$/, ""),
    `${key}s`,
    key.replace(/_ids?$/, "_id"),
  ];
  const hit = candidates.find((c) => c !== key && KNOWN_KEYS.includes(c));
  if (hit) return hit;
  const flat = key.replace(/_/g, "").toLowerCase();
  return KNOWN_KEYS.find((k) => k.replace(/_/g, "").toLowerCase() === flat);
}

export class FilterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterKeyError";
  }
}

/**
 * Kiểm tra khoá + chuẩn hoá giá trị của filter.
 * - Khoá lạ → ném FilterKeyError (thay vì để BE trả 0 đơn im lặng).
 * - Khoá dạng `terms` nhận scalar → wrap thành mảng.
 */
export function validateFilter(
  filter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!filter || typeof filter !== "object") return {};

  const out: Record<string, unknown> = {};
  const unknown: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (DYNAMIC_KEY.test(key) || EXCLUDE_FLAG.test(key) || PASSTHROUGH_KEYS.includes(key)) {
      out[key] = value;
      continue;
    }
    if (TERM_ARRAY_KEYS.includes(key)) {
      // scalar → [scalar]; giữ nguyên nếu đã là mảng (bỏ null/undefined lạc).
      out[key] = Array.isArray(value) ? value : value == null ? value : [value];
      continue;
    }
    unknown.push(key);
  }

  if (unknown.length) {
    const details = unknown
      .map((k) => {
        const s = suggestKey(k);
        return s ? `\`${k}\` (có phải \`${s}\`?)` : `\`${k}\``;
      })
      .join(", ");
    throw new FilterKeyError(
      `Khoá filter không hợp lệ: ${details}. ` +
        `BE BỎ QUA khoá lạ và trả 0 đơn mà KHÔNG báo lỗi, nên MCP chặn tại đây để tránh ra số sai. ` +
        `Khoá hợp lệ: ${KNOWN_KEYS.join(", ")}, kèm dạng động "<time_key>:ranges", ` +
        `"<time_key>:editor_ids", "is_exclude_<key>".`,
    );
  }

  return out;
}
