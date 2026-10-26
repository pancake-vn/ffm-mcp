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
  // "or" (mặc định) | "and" — BE tách mọi khoá condition_* ra :condition_filter (base_es_query)
  // rồi đọc ở clause include_tags / product_id / variation_id.
  "condition_include_tags",
  "condition_product_id",
  "condition_variation_id",
];

// Khoá lọc theo user: BE lưu UUID (Ecto.UUID / :binary_id), ES mapping `keyword`. Gửi số
// hoặc tên/email → `terms` không khớp doc nào → 0 đơn im lặng. Chỉ nhận chuỗi UUID; riêng
// assigning_* nhận thêm sentinel no_user / has_user (clause riêng ở apply_es_filter) — CHỈ khi
// đứng một mình: trộn với UUID thì BE bỏ sentinel đi, ["no_user","has_user"] ra 0 đơn.
const USER_ID_KEYS: ReadonlyArray<string> = [
  "creator_id",
  "last_editor_id",
  "send_to_partner_user_id",
  "assigning_sale_id",
  "assigning_care_id",
];
const USER_SENTINELS: Record<string, ReadonlyArray<string>> = {
  assigning_sale_id: ["no_user", "has_user"],
  assigning_care_id: ["no_user", "has_user"],
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCLUDE_FLAG = /^is_exclude_/;
const isUserKey = (key: string) => !EXCLUDE_FLAG.test(key) && (USER_ID_KEYS.includes(key) || key.endsWith(":editor_ids"));

// Khoá động hợp lệ: "<time_key>:ranges", "<time_key>:editor_ids", cờ "is_exclude_<key>".
const DYNAMIC_KEY = /(?::ranges|:editor_ids)$/;

// Giá trị `<time_key>:ranges`: BE đọc bằng parse_ranges/1 (`term["since"]`, `term["until"]`).
// Mảng / chuỗi → Access raise → HTTP 500 "Internal Server Error" không kèm chi tiết; object với
// khoá con khác (gte/lte, from/to) → since/until = nil → BE lọc không giới hạn, ra số sai mà không
// báo lỗi; chuỗi không phải ngày → ES lỗi, safe_agg_query trả 0 đơn. MCP chặn cả ba trường hợp.
// Chuỗi chỉ có ngày ("2026-10-19") cũng chặn: localRangesToUtc không quy được sang UTC, BE giữ
// nguyên → ES hiểu là 00:00 UTC, lệch đúng bằng múi giờ và until mất gần trọn ngày cuối.
// null ở một đầu = không giới hạn đầu đó (parse_ranges cũng ra nil như khi thiếu khoá).
const RANGE_KEY = /:ranges$/;
const RANGE_BOUNDS = ["since", "until"];
const RANGE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const isRangeDate = (v: unknown) =>
  typeof v === "string" && RANGE_DATETIME_RE.test(v.trim()) && !Number.isNaN(Date.parse(v.trim()));

function rangeProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "phải là object { since, until }";
  const keys = Object.keys(value);
  const extra = keys.filter((k) => !RANGE_BOUNDS.includes(k));
  if (extra.length) return `khoá con ${JSON.stringify(extra)} không được BE đọc, chỉ dùng since / until`;
  const r = value as Record<string, unknown>;
  const set = keys.filter((k) => r[k] != null);
  if (!set.length) return "cần ít nhất since hoặc until";
  const bad = set.filter((k) => !isRangeDate(r[k]));
  if (bad.length) return `${bad.join(", ")} phải là chuỗi "YYYY-MM-DDTHH:MM:SS" (có cả giờ)`;
  return undefined;
}

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
  saved_filter_id:
    "bộ lọc đã lưu không phải field của đơn → gọi list_filter_values với filter_key `saved_filter` rồi dùng nguyên `filters` của nó",
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
  const badUserIds: string[] = [];
  const badRanges: string[] = [];

  // Khoá user: scalar → mảng, UUID về chữ thường (ES keyword phân biệt hoa thường, UUID trong
  // DB là chữ thường); giá trị không hợp lệ → ghi lại để báo lỗi cùng lúc.
  const normalizeUserIds = (key: string, value: unknown): unknown => {
    if (value == null) return value;
    const list = Array.isArray(value) ? value : [value];
    const sentinels = USER_SENTINELS[key] ?? [];
    if (list.length === 1 && sentinels.includes(list[0] as string)) return list;
    const bad = list.filter((v) => !(typeof v === "string" && UUID_RE.test(v)));
    if (bad.length) badUserIds.push(`\`${key}\`: ${JSON.stringify(bad)}`);
    return list.map((v) => (typeof v === "string" ? v.toLowerCase() : v));
  };

  for (const [rawKey, value] of Object.entries(filter)) {
    const flagOf = rawKey.replace(EXCLUDE_FLAG, "");
    const key =
      KEY_ALIASES[rawKey] ??
      (EXCLUDE_FLAG.test(rawKey) && KEY_ALIASES[flagOf] ? `is_exclude_${KEY_ALIASES[flagOf]}` : rawKey);
    if (key !== rawKey && key in filter) {
      throw new FilterKeyError(`Không gửi cùng lúc \`${rawKey}\` và \`${key}\` — hai khoá lọc cùng field, chỉ giữ một.`);
    }
    if (isUserKey(key)) {
      out[key] = normalizeUserIds(key, value);
      continue;
    }
    if (DYNAMIC_KEY.test(key) || EXCLUDE_FLAG.test(key) || PASSTHROUGH_KEYS.includes(key)) {
      const problem = RANGE_KEY.test(key) && !EXCLUDE_FLAG.test(key) ? rangeProblem(value) : undefined;
      if (problem) badRanges.push(`\`${key}\` = ${JSON.stringify(value)} (${problem})`);
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

  if (badUserIds.length) {
    throw new FilterKeyError(
      `Giá trị lọc theo user không hợp lệ: ${badUserIds.join("; ")}. ` +
        `Các khoá này nhận UUID của user (chuỗi dạng "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), ` +
        `KHÔNG nhận số, tên hay email — BE so khớp đúng UUID nên giá trị khác ra 0 đơn mà không báo lỗi. ` +
        `Gọi tool find_users (keyword = tên/email) để lấy UUID. ` +
        `assigning_sale_id / assigning_care_id nhận thêm ["no_user"] / ["has_user"] nhưng phải ` +
        `đứng MỘT MÌNH (trộn với UUID thì BE bỏ qua no_user/has_user).`,
    );
  }

  if (badRanges.length) {
    throw new FilterKeyError(
      `Giá trị khoảng thời gian không hợp lệ: ${badRanges.join("; ")}. ` +
        `Dạng đúng: "<time_key>:ranges": { "since": "2026-10-19T00:00:00", "until": "2026-10-25T23:59:59" } ` +
        `theo giờ local của user (kèm param timezone). Mảng hoặc chuỗi khác rỗng làm BE trả HTTP 500; ` +
        `khoá con khác since/until bị BE bỏ qua nên ra số của mọi thời điểm.`,
    );
  }

  return out;
}
