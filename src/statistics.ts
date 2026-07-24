// Decorate response của POST /api/orders/statistics cho người/AI đọc — port logic
// nhãn + tiền tệ từ sea-fulfillment-web/pages/admin/statistic/order-data/index.js
// (resolveLabel, metricCurrency, realVal). Chạy server-side, không phụ thuộc React/i18n.
//
// - group key → nhãn người đọc (status text, sub_status text, marketplace name, shop name).
// - metric số → giá trị thật đã scale theo currency (billing vs reconciliation; PH recon
//   dùng PHP100 → /100). total_quantity không phải tiền → giữ nguyên.

import {
  INT_CURRENCY_LIST,
  MARKETPLACE_SOURCE,
  METRIC_BY_KEY,
  ORDER_STATUS_TEXT,
  SUB_STATUS_TEXT,
  currencyByCountry,
} from "./constants.js";
import type { ShopLite, StatisticsResponse } from "./api.js";

export interface DecorateOptions {
  countryCode: string;
  shopsById?: Record<string, ShopLite>;
}

type KeyPart = { key: unknown; key_as_string?: string };

// key của 1 chiều group → nhãn người đọc (fallback về raw key khi không map được).
function resolveLabel(
  dim: string,
  part: KeyPart | undefined,
  shopsById: Record<string, ShopLite>,
): string {
  const key = part?.key;
  const raw = key == null ? "" : String(key);
  switch (dim) {
    case "status":
      return ORDER_STATUS_TEXT[raw] || raw;
    case "sub_status":
      return SUB_STATUS_TEXT[raw] || raw;
    case "order_source":
    case "marketplace_id":
      return MARKETPLACE_SOURCE[raw] || raw;
    case "shop_id":
      return shopsById[raw]?.name || `Shop #${raw}`;
    case "date":
      // key_as_string đã áp time_zone → 10 ký tự đầu là YYYY-MM-DD local.
      return (part?.key_as_string || "").slice(0, 10) || raw;
    default:
      return part?.key_as_string || raw;
  }
}

export function decorateStatistics(
  data: StatisticsResponse,
  opts: DecorateOptions,
) {
  const { countryCode } = opts;
  const shopsById = opts.shopsById ?? {};
  const groupBy = Array.isArray(data.group_by) ? data.group_by : [];
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];

  const billingCurrency = currencyByCountry(countryCode);
  const reconCurrency = currencyByCountry(countryCode, true);

  // Giá trị thật của 1 metric: chia /100 trừ khi currency thuộc INT_CURRENCY_LIST
  // (khớp FE realVal). Reconciliation dùng reconCurrency (PH → PHP100 ⇒ /100).
  const realVal = (metricKey: string, v: number | undefined): number => {
    const def = METRIC_BY_KEY[metricKey];
    const n = Number(v || 0);
    if (!def || !def.money) return n;
    const currency = def.recon ? reconCurrency : billingCurrency;
    return currency && INT_CURRENCY_LIST.includes(currency) ? n : n / 100;
  };

  const scaleValues = (values: Record<string, number> | undefined) =>
    Object.fromEntries(metrics.map((m) => [m, realVal(m, values?.[m])]));

  const buckets = (data.buckets ?? []).map((b) => ({
    labels: groupBy.map((dim, i) => resolveLabel(dim, b.keys?.[i], shopsById)),
    keys: (b.keys ?? []).map((k) => k?.key),
    count: b.count ?? 0,
    values: scaleValues(b.values),
  }));

  const out: Record<string, unknown> = {
    country_code: countryCode,
    group_by: groupBy,
    metrics,
    currencies: { billing: billingCurrency, reconciliation: reconCurrency },
    total_entries: data.total_entries ?? 0,
    totals: scaleValues(data.totals),
    buckets,
  };
  // Echo mốc thời gian khi group_by date (BE chỉ trả kèm khi có date).
  if (data.time_key) out.time_key = data.time_key;
  if (data.interval) out.interval = data.interval;
  return out;
}
