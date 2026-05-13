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
