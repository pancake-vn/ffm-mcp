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

// Khoá BE xử lý theo dạng danh sách (`terms` / `Enum.map` / so `term == ["x"]`)
// → PHẢI là mảng, gửi scalar sẽ ra 0 đơn im lặng. MCP tự wrap giúp.
// Gồm cả khoá catch-all (map thẳng sang field ES cùng tên) lẫn khoá có clause riêng
// nhưng nhận list. Mọi field ở đây đã đối chiếu với ES mapping của order index.
const TERM_ARRAY_KEYS: ReadonlyArray<string> = [
  // catch-all → terms trên field cùng tên (có trong mapping)
  "status",
  "shop_id",
  "marketplace_id",
  "slot_warehouse_id",
  "pending_reason_id",
  "cancel_reason_id",
  "total_quantity",
  "display_id",
  "platform_order_id",
  "printed_count",
  "processing_count",
  "creator_id",
  "last_editor_id",
  "send_to_partner_user_id",
  "call_later_status",
  "ssc_id",
  // clause riêng nhưng nhận list
  "order_sub_status", // terms trên field `sub_status` — caller gửi `sub_status` cũng được, xem KEY_ALIASES
  "order_ids",
  "keyword",
  "include_tags", // giá trị là TÊN tag (BE query tags.name), + "no_tag"
  "exclude_tags", // giá trị là TÊN tag, + "no_tag"
  "service_types", // hoặc ["No Service Type"]
  "assigning_sale_id", // hoặc ["no_user"] / ["has_user"]
  "assigning_care_id",
  "partner_id", // hoặc ["no_courier"]
  "order_source", // ["non_marketplace"] / ["-3"] / ["-4"] / ["-9"]
  "product_id",
  "variation_id",
  "combo_product",
  "province_id",
  "district_id",
  "commune_id",
];

// Khoá BE nhận SCALAR (string/boolean) hoặc toggle → giữ nguyên kiểu caller gửi.
const PASSTHROUGH_KEYS: ReadonlyArray<string> = [
  "time_key",
  "waybill_number", // "no_waybill_number" | "matched_waybill_number"
  "courier_reconciliation_status",
  "customer_reconciliation_status",
  "need_attention_tags", // 1 tên tag
  "sub_sale_pending_reason",
  "is_duplicated_phone",
  "is_duplicated_ip",
  "cod", // "has_cod" | "no_cod" | "<op>_<amount>" (BE tự List.wrap)
  // toggle thiếu địa chỉ — chỉ cần có mặt khoá
  "no_address",
  "no_detail_address",
  "no_commune",
];

// Khoá động hợp lệ: "<time_key>:ranges", "<time_key>:editor_ids", cờ "is_exclude_<key>".
const DYNAMIC_KEY = /(?::ranges|:editor_ids)$/;
const EXCLUDE_FLAG = /^is_exclude_/;

// Khoá caller hay gửi → khoá BE thật sự áp dụng. `sub_status` bị base_es_query/2 `Map.drop`
// khi `status` không phải MỘT chuỗi thuộc need_attention/sale_pending/@sub_status_statuses
// (key đó dành cho tab con của trang list). MCP luôn gửi `status` dạng mảng, không truyền
// thì là nil → cả hai đều khiến `sub_status` bị bỏ và BE trả số của MỌI đơn. `order_sub_status`
// lọc cùng field `sub_status` nhưng không bị bỏ.
const KEY_ALIASES: Record<string, string> = {
  sub_status: "order_sub_status",
};

const KNOWN_KEYS: ReadonlyArray<string> = [...TERM_ARRAY_KEYS, ...PASSTHROUGH_KEYS, ...Object.keys(KEY_ALIASES)];

// Khoá hay bị dùng nhầm — đã đối chiếu apply_es_filter + ES mapping của order index.
// Nêu thẳng cách thay thế thay vì để caller đoán.
const INVALID_KEY_HINTS: Record<string, string> = {
  tags: "dùng `include_tags` / `exclude_tags`, giá trị là TÊN tag (BE query `tags.name`), KHÔNG phải tag ID",
  tag: "dùng `include_tags` / `exclude_tags`, giá trị là TÊN tag",
  is_exclude_tags: "không có `tags` để exclude — dùng thẳng `exclude_tags: [\"tên tag\"]`",
  category_id: "ES order index KHÔNG có field này → luôn 0 đơn",
  shift: "ES order index KHÔNG có field này → luôn 0 đơn",
  saved_filter_id: "ES order index KHÔNG có field này (bộ lọc đã lưu là khái niệm phía FE) → luôn 0 đơn",
  delivery_address_id: "ES order index KHÔNG có field này → luôn 0 đơn",
  business_countries_ids: "ES order index KHÔNG có field này → luôn 0 đơn; lọc quốc gia bằng `country_code` ở cấp tool",
  tracking_number: "dùng `keyword: [\"<mã vận đơn>\"]` (keyword tìm cả tracking_number)",
  phone_number: "dùng `keyword: [\"<số điện thoại>\"]`",
};

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

  for (const [rawKey, value] of Object.entries(filter)) {
    const flagOf = rawKey.replace(EXCLUDE_FLAG, "");
    const key =
      KEY_ALIASES[rawKey] ??
      (EXCLUDE_FLAG.test(rawKey) && KEY_ALIASES[flagOf] ? `is_exclude_${KEY_ALIASES[flagOf]}` : rawKey);
    if (key !== rawKey && key in filter) {
      throw new FilterKeyError(`Không gửi cùng lúc \`${rawKey}\` và \`${key}\` — hai khoá lọc cùng field, chỉ giữ một.`);
    }
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
        const hint = INVALID_KEY_HINTS[k];
        if (hint) return `\`${k}\` → ${hint}`;
        const s = suggestKey(k);
        return s ? `\`${k}\` (có phải \`${s}\`?)` : `\`${k}\``;
      })
      .join("; ");
    throw new FilterKeyError(
      `Khoá filter không hợp lệ: ${details}. ` +
        `BE BỎ QUA khoá lạ và trả 0 đơn mà KHÔNG báo lỗi, nên MCP chặn tại đây để tránh ra số sai. ` +
        `Khoá hợp lệ: ${KNOWN_KEYS.join(", ")}, kèm dạng động "<time_key>:ranges", ` +
        `"<time_key>:editor_ids", "is_exclude_<key>".`,
    );
  }

  return out;
}
