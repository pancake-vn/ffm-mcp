// Đồng bộ với sea-fulfillment-web utils/tools.js
// - intCurrencyList: list currency không chia /100 khi format (giữ nguyên integer).
// - SUPPORTED_COUNTRIES: phone-code → currency (CLAUDE.md §7).
// - ORDER_STATUS_TEXT: map status key → text (i18n English, default tab).

export const INT_CURRENCY_LIST: ReadonlyArray<string> = [
  "VND",
  "TWD",
  "LAK",
  "PHP",
  "MMK",
  "JPY",
  "INR",
  "COP",
  "IDR",
  "CLP",
];

// sea-fulfillment lib/app/constant.ex:93-99 — supported_countries (có currency map).
export const SUPPORTED_COUNTRIES: ReadonlyArray<{
  countryCode: string;
  short: string;
  name: string;
  currency: string;
}> = [
  { countryCode: "63", short: "PH", name: "Philippines", currency: "PHP" },
  { countryCode: "66", short: "TH", name: "Thailand", currency: "THB" },
  { countryCode: "60", short: "MY", name: "Malaysia", currency: "MYR" },
  { countryCode: "62", short: "ID", name: "Indonesia", currency: "IDR" },
  { countryCode: "65", short: "SG", name: "Singapore", currency: "SGD" },
];

// sea-fulfillment lib/app/constant.ex:70 — supported_country_codes (BE accept,
// rộng hơn supported_countries). Laos "856" BE accept nhưng không có currency
// trong SUPPORTED_COUNTRIES → MCP fallback /100.
export const EXTRA_ACCEPTED_COUNTRY_CODES: ReadonlyArray<string> = ["856"];

// sea-fulfillment lib/app/constant.ex:72-83 — supported_hosts.
// MCP `host` param có thể truyền full URL (`https://<hostname>` hoặc
// `https://<hostname>:4004` cho local).
export const SUPPORTED_HOSTS: ReadonlyArray<{
  hostname: string;
  appId: number;
  prefix: string;
}> = [
  { hostname: "fulfillment.pancake.vn", appId: 99, prefix: "PFFM" },
  { hostname: "localhost", appId: 0, prefix: "FFM" },
  { hostname: "ffm_running_app", appId: 0, prefix: "FFM" },
  { hostname: "g-solution.vn", appId: 1, prefix: "GIP" },
  { hostname: "afgwarehouse.net", appId: 2, prefix: "AFG" },
  { hostname: "app.mspeedyexpress.com", appId: 3, prefix: "MSX" },
  { hostname: "lynexpress.co", appId: 4, prefix: "LYN" },
  { hostname: "buber.pancake.vn", appId: 5, prefix: "BUBER" },
  { hostname: "admin.ifgfulfillmentglobal.com", appId: 6, prefix: "IFG" },
  { hostname: "bigate.co", appId: 9, prefix: "BIG" },
];

// billing currency theo country; reconciliation currency của PH là "PHP100" (đồng bộ
// sea-fulfillment-web utils/tools.js:223) — PHP100 KHÔNG thuộc INT_CURRENCY_LIST nên tiền
// đối soát PH bị chia /100, khác billing PHP (integer, không chia).
export function currencyByCountry(
  countryCode: string | undefined,
  isReconciliation = false,
): string | undefined {
  if (!countryCode) return undefined;
  if (isReconciliation && String(countryCode) === "63") return "PHP100";
  return SUPPORTED_COUNTRIES.find((c) => c.countryCode === String(countryCode))?.currency;
}

// UTC offset (giờ) theo country — dùng để quy đổi date range local → UTC giống web
// (dayjs .toISOString()). BE so since/until với cột lưu UTC nên phải gửi UTC.
// Các nước này không có DST → offset cố định. ID dùng WIB (Jakarta, +7).
const COUNTRY_UTC_OFFSET: Record<string, number> = {
  "63": 8, // PH
  "66": 7, // TH
  "60": 8, // MY
  "62": 7, // ID (WIB)
  "65": 8, // SG
  "856": 7, // Laos
};

export function utcOffsetByCountry(countryCode: string | undefined): number {
  if (!countryCode) return 0;
  return COUNTRY_UTC_OFFSET[String(countryCode)] ?? 0;
}

export const ORDER_STATUS_TEXT: Record<string, string> = {
  new: "New",
  need_attention: "Need attention",
  waiting: "Restocking",
  need_confirm: "Need confirmation",
  sale_pending: "Pending",
  confirmed: "Confirmed",
  wait_print: "Wait to print",
  printed: "Printed",
  packing: "Packing",
  pending: "Waiting for pickup",
  shipped: "Shipped",
  delivered: "Delivered",
  returning: "Returning",
  returned: "Returned",
  cancel: "Canceled",
};

// sub_status là polymorphic: stock-match (matched/mismatched) + tiến trình đóng gói
// (packingOrderStatus) + courier delivery sub-status (orderSubStatus). Đồng bộ FE
// labelMaps.sub_status (order-data/index.js:236-243). Text tiếng Anh (default tab).
export const SUB_STATUS_TEXT: Record<string, string> = {
  matched: "Matched",
  mismatched: "Mismatched",
  // Bucket BE gom doc THIẾU sub_status (terms agg `missing`) — không phải giá trị lưu trong DB.
  no_sub_status: "No sub status",
  // packingOrderStatus
  to_pack: "To pack",
  packing: "Packing",
  on_hold: "On hold",
  packed: "Packed",
  handed_over: "Handed over",
  // orderSubStatus (courier delivery)
  picked_up: "Picked up",
  processing_on_the_way: "Processing on the way",
  on_the_way: "On the way",
  out_for_delivery: "Out for delivery",
  delay_delivery: "Delay delivery",
  undeliverable: "Undeliverable",
  inform_recipient: "Inform recipient",
  contact_delivery_company: "Contact delivery company",
  waiting_on_the_way: "Waiting on the way",
  waiting_for_return: "Waiting for return",
  import_returning_warehouse: "Import returning warehouse",
  waiting_returning_transit: "Waiting returning transit",
  returning: "Returning",
  return_fail: "Return fail",
  returning_fail: "Returning fail",
  delivered: "Delivered",
  delivered_cod: "Delivered COD",
  returned: "Returned",
  returned_cod: "Returned COD",
};

// order_source / marketplace_id → tên marketplace (sea-fulfillment-web utils/tools.js:1601).
export const MARKETPLACE_SOURCE: Record<string, string> = {
  "-3": "Shopee",
  "-4": "Lazada",
  "-9": "TikTok",
  // Bucket BE gom đơn KHÔNG có marketplace_id (Facebook / tự tạo) — trùng vocabulary của
  // filter `order_source: ["non_marketplace"]` nên gom nhóm ra key nào lọc lại được key đó.
  non_marketplace: "Non-marketplace",
};

// shop_id là field integer nên sentinel `missing` của BE phải là số — dùng -1 (cùng quy ước
// với pending_reason_id -1 / cancel_reason_id -2), không thể va với id thật (bigserial > 0).
export const NO_SHOP_KEY = "-1";

// group_by dimensions hợp lệ (khớp @statistic_group_fields BE). `date` chỉ dùng đơn.
export const GROUP_FIELDS: ReadonlyArray<string> = [
  "status",
  "sub_status",
  "order_source",
  "shop_id",
  "assigning_sale_id",
  "assigning_care_id",
  "creator_id",
  "date",
];
export const GROUP_LABELS: Record<string, string> = {
  status: "Status",
  sub_status: "Sub status",
  order_source: "Order source",
  shop_id: "Shop",
  assigning_sale_id: "Assigning Sale",
  assigning_care_id: "Assigning Care",
  creator_id: "Created By",
  date: "Date",
};

// Chiều group_by có key là UUID user → resolve sang tên qua /users/get_users.
export const USER_GROUP_FIELDS: ReadonlyArray<string> = [
  "assigning_sale_id",
  "assigning_care_id",
  "creator_id",
];
// Sentinel `missing` của BE cho đơn chưa gán user (cùng giá trị filter ["no_user"]).
export const NO_USER_KEY = "no_user";

// Mốc thời gian cho group_by "date" / date-range filter (khớp @statistic_date_time_keys BE).
export const DATE_FIELD_KEYS: ReadonlyArray<string> = [
  "inserted_at",
  "confirmed_at",
  "send_to_partner_at",
  "picked_up_at",
  "delivered_at",
  "assign_sale_at",
  "first_assign_sale_at",
  "assign_care_at",
  "expected_receipt_date",
  "updated_at",
];

// Whitelist metric (đồng bộ @statistic_metric_fields BE order.ex:1441). money=true → format
// theo currency; recon=true → dùng reconciliation currency (PHP100 với PH → /100).
export interface MetricDef {
  key: string;
  label: string;
  money: boolean;
  recon?: boolean;
}
const RECON_KEYS: ReadonlyArray<[string, string]> = [
  ["shipping_fee", "Shipping Fee"],
  ["shipping_fee_tax", "Shipping Fee Tax"],
  ["cod_fee", "COD Fee"],
  ["cod_fee_tax", "COD Fee Tax"],
  ["insurance_fee", "Insurance Fee"],
  ["return_fee", "Return Fee"],
  ["return_fee_tax", "Return Fee Tax"],
  ["ffm_fee", "FFM Fee"],
  ["total_fee", "Total Fee"],
];
export const METRIC_DEFS: ReadonlyArray<MetricDef> = [
  { key: "cod", label: "COD", money: true },
  { key: "transfer_money", label: "Bank Transfer", money: true },
  { key: "shipping_fee", label: "Shipping Fee", money: true },
  { key: "discount", label: "Discount", money: true },
  { key: "surcharge", label: "Surcharge", money: true },
  { key: "extra_price", label: "Extra Price", money: true },
  { key: "total_quantity", label: "Total Quantity", money: false },
  ...RECON_KEYS.map(([k, l]) => ({ key: `courier_${k}`, label: `Courier ${l}`, money: true, recon: true })),
  ...RECON_KEYS.map(([k, l]) => ({ key: `customer_${k}`, label: `Customer ${l}`, money: true, recon: true })),
];
export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(
  METRIC_DEFS.map((m) => [m.key, m]),
);
export const METRIC_KEYS: ReadonlyArray<string> = METRIC_DEFS.map((m) => m.key);
