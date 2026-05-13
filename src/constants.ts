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

export function currencyByCountry(countryCode: string | undefined): string | undefined {
  if (!countryCode) return undefined;
  return SUPPORTED_COUNTRIES.find((c) => c.countryCode === String(countryCode))?.currency;
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

// reconciliationKeys tương ứng với utils/excel.js — dùng cho courier_* / customer_*.
export const RECONCILIATION_KEYS: ReadonlyArray<string> = [
  "shipping_fee",
  "return_shipping_fee",
  "cod",
  "insurance_fee",
  "vat",
  "total",
];

export const COUNTRY_HAD_COMMUNE_POSTCODE: ReadonlyArray<string> = [
  "60",
  "61",
  "82",
  "966",
  "91",
  "65",
];
