// Port logic OrderExportExcel.formatData (sea-fulfillment-web/components/OrderExportExcel.js)
// thành pure function chạy server-side, không phụ thuộc React/Redux/i18n.
//
// Input: raw order từ BE get_orders (load_full=true, đã có shipping_info, items,
// partner, shop, status_histories, tags_detail …).
//
// Output: object phẳng chứa các trường mà OrderExportExcel writeRow sử dụng.

import {
  COUNTRY_HAD_COMMUNE_POSTCODE,
  INT_CURRENCY_LIST,
  ORDER_STATUS_TEXT,
  RECONCILIATION_KEYS,
  currencyByCountry,
} from "./constants.js";

type AnyObj = Record<string, any>;

export interface NormalizeOptions {
  countryCode: string;
  // datetime format string giữ lại để callsite tự format; ở đây trả ISO string.
  datetimeFormat?: string;
  index?: number; // 1-based trong batch
}

function safeNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  // BE trả ISO string thì giữ nguyên; nếu là epoch ms thì convert.
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (v instanceof Date) return v.toISOString();
  return null;
}

function minByCreatedAt(list: AnyObj[] | undefined): AnyObj | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.reduce((best, cur) => {
    if (!best) return cur;
    const a = new Date(best.created_at ?? 0).getTime();
    const b = new Date(cur.created_at ?? 0).getTime();
    return b < a ? cur : best;
  }, undefined as AnyObj | undefined);
}

function tagNamesFromDetail(tagsDetail: AnyObj[] | undefined, status: string | undefined): string[] {
  if (!Array.isArray(tagsDetail)) return [];
  // OrderExportExcel dùng getNamesTagsByIds(order.tags_detail, status) — ở đây trả về
  // name + translate (nếu có) theo status; giữ behavior an toàn: ưu tiên translate[status]
  // → translate.default → name.
  return tagsDetail
    .map((t) => {
      const translate = (t?.translate ?? {}) as AnyObj;
      const byStatus = status ? translate[status] : undefined;
      const fallback = translate.default;
      return byStatus || fallback || t?.name;
    })
    .filter((x): x is string => Boolean(x));
}

// Re-implement logic format address giống FE để giá trị full_address khớp file Excel.
function deriveAddress(shipping: AnyObj | undefined): {
  fullAddress: string;
  province: string;
  district: string;
  commune: string;
} {
  if (!shipping) return { fullAddress: "", province: "", district: "", commune: "" };

  const {
    full_address,
    address,
    province_id,
    district_id,
    commune_id,
    province_name,
    district_name,
    commune_name,
  } = shipping;

  const parts = (full_address || "").split(", ");
  let commune = commune_id ? parts[parts.length - 3] : "";
  let district = district_id ? parts[parts.length - 2] : "";
  let province = province_id ? parts[parts.length - 1] : "";

  const upper = (s: string | undefined) => (s ? String(s).toUpperCase().split("/")[0] : "");

  province = upper(province_name || province);
  district = upper(district_name || district);
  commune = upper(commune_name || commune);

  const fullAddress = [address, commune, district, province].filter(Boolean).join(", ");
  return { fullAddress, province, district, commune };
}

export interface NormalizedOrder {
  // base
  id: number | string | null;
  display_id: number | string | null;
  status: string | null; // text
  status_key: string | null;
  index: number;
  requested_tracking_id: string | null;
  platform_order_id: string | null;

  // shop
  shop_id: number | string | null;
  pos_shop_id: string | null;
  pos_shop_name: string | null;
  shop: string | null;

  // customer / address
  customer_name: string | null;
  phone_number: string | null;
  province_name: string;
  district_name: string;
  commune_name: string;
  postal_code: string | null;
  full_address: string;
  country_code: string | null;

  // items aggregate
  total_quantity: number;
  total_weight: number; // gram
  weight: number; // kg (giống FE row.weight)
  product_name: string;
  remarks: string;

  // money (đã / numberDiv theo currency)
  surcharge: number;
  cod: number;
  total_price: number;
  transfer_money: number;

  // partner / shipping
  tracking_number: string | null;
  partner_name: string | null;
  delivery_status: string | null;
  send_to_partner_at: string | null;
  shipped_at: string | null;
  completed_at: string | null;
  confirmed_at: string | null;
  courier_weight: number | string;

  // reconciliation
  courier_reconciliation_status: string | null;
  customer_reconciliation_status: string | null;
  courier_reconciliation: Record<string, number | null>;
  customer_reconciliation: Record<string, number | null>;
  customer_reconciliation_cod: number | null;

  // misc dates
  inserted_at: string | null;
  updated_at: string | null;
  assign_sale_at: string | null;
  first_assign_sale_at: string | null;
  expected_receipt_date: string | null;
  assign_care_at: string | null;

  // tags / reasons / users
  tags: string[];
  call_status: string | null;
  cancel_reason: string | null;
  assigning_sale_id: number | string | null;
  assigning_care_id: number | string | null;

  telesale_note: string | null;
  service_types: string | null;

  // raw items kept để client tự split row nếu cần
  items: AnyObj[];
}

export function normalizeOrder(order: AnyObj, opts: NormalizeOptions): NormalizedOrder {
  const shipping = order?.shipping_info ?? {};
  const allItems: AnyObj[] = Array.isArray(order?.items) ? order.items : [];
  // FE filter !composite_pos_id để bỏ child của combo khi gộp dòng.
  const items = allItems.filter((it) => !it?.composite_pos_id);

  const currency = currencyByCountry(opts.countryCode);
  const numberDiv = currency && INT_CURRENCY_LIST.includes(currency) ? 1 : 100;

  const totalQuantity = items.reduce((acc, it) => acc + safeNumber(it?.quantity), 0);
  const totalWeightGram = items.reduce(
    (acc, it) => acc + safeNumber(it?.variation_info?.weight) * safeNumber(it?.quantity),
    0,
  );
  const weightKg = totalWeightGram / 1000;

  const remarks = items
    .map((it) => {
      const v = it?.variation_info ?? {};
      return `${safeNumber(it?.quantity)} x ${v?.custom_id ?? ""} - ${v?.name ?? ""}`;
    })
    .join("; ");

  const productName = items.map((it) => it?.variation_info?.name).filter(Boolean).join("; ");

  const { fullAddress, province, district, commune } = deriveAddress(shipping);

  const partner = order?.partner ?? null;
  const deliveryStatus = Array.isArray(partner?.updates) && partner.updates[0]?.status
    ? partner.updates[0].status
    : null;

  const sendToPartnerHistories = Array.isArray(order?.status_histories)
    ? order.status_histories.filter((h: AnyObj) => h?.new_status === "shipped")
    : [];
  const shippedAt =
    partner?.picked_up_at ||
    minByCreatedAt(sendToPartnerHistories)?.created_at ||
    null;

  const confirmedHistories = Array.isArray(order?.status_histories)
    ? order.status_histories.filter((h: AnyObj) => h?.new_status === "confirmed")
    : [];
  const confirmedAt = minByCreatedAt(confirmedHistories)?.created_at ?? null;

  const courierFee: AnyObj = partner?.courier_fee_info ?? {};
  const customerFee: AnyObj = partner?.customer_fee_info ?? {};
  const reconciliationDiv =
    partner?.currency && INT_CURRENCY_LIST.includes(partner.currency) ? 1 : 100;

  const courierReconciliation: Record<string, number | null> = {};
  const customerReconciliation: Record<string, number | null> = {};
  for (const k of RECONCILIATION_KEYS) {
    courierReconciliation[k] = courierFee[k] != null ? courierFee[k] / reconciliationDiv : null;
    customerReconciliation[k] = customerFee[k] != null ? customerFee[k] / reconciliationDiv : null;
  }

  const tagNames = tagNamesFromDetail(order?.tags_detail, order?.status);

  const reasonInfo: AnyObj[] = Array.isArray(order?.reason_info) ? order.reason_info : [];
  const callStatus = reasonInfo.find((r) => r?.id === order?.pending_reason_id)?.note ?? null;
  const cancelReason = reasonInfo.find((r) => r?.id === order?.cancel_reason_id)?.note ?? null;

  const rawPhone: string | undefined = shipping?.phone_number;
  const phone = rawPhone
    ? String(rawPhone).replace("+66", "0").replace(/\s/g, "")
    : null;

  const shopPosId = order?.shop?.pos_shop_id ?? null;
  const shopName: string | undefined = order?.shop?.name;
  const posShopName = shopName ? shopName.split(" - ")[0] : null;
  const shopCombined = order?.shop ? `${shopPosId} - ${shopName}` : null;

  const isCommunePostcodeCountry =
    shipping?.country_code && COUNTRY_HAD_COMMUNE_POSTCODE.includes(String(shipping.country_code));
  const postalCode = isCommunePostcodeCountry
    ? (shipping?.commune_id ?? "")
    : (shipping?.postal_code ?? "");

  return {
    id: order?.id ?? null,
    display_id: order?.display_id ?? null,
    status: order?.status ? ORDER_STATUS_TEXT[order.status] ?? order.status : null,
    status_key: order?.status ?? null,
    index: opts.index ?? 1,
    requested_tracking_id:
      order?.shop_id != null && order?.display_id != null
        ? `S${order.shop_id}O${order.display_id}`
        : null,
    platform_order_id: order?.platform_order_id ?? null,

    shop_id: order?.shop_id ?? null,
    pos_shop_id: shopPosId,
    pos_shop_name: posShopName,
    shop: shopCombined,

    customer_name: shipping?.full_name ?? null,
    phone_number: phone,
    province_name: province,
    district_name: district,
    commune_name: commune,
    postal_code: postalCode === "" ? null : String(postalCode),
    full_address: fullAddress,
    country_code: shipping?.country_code ?? null,

    total_quantity: totalQuantity,
    total_weight: totalWeightGram,
    weight: weightKg,
    product_name: productName,
    remarks,

    surcharge: safeNumber(order?.surcharge) / numberDiv,
    cod: safeNumber(order?.cod) / numberDiv,
    total_price: safeNumber(order?.total_price) / numberDiv,
    transfer_money: safeNumber(order?.transfer_money) / numberDiv,

    tracking_number: partner?.tracking_number ?? null,
    partner_name: partner?.partner?.name ?? null,
    delivery_status: deliveryStatus,
    send_to_partner_at: toIsoOrNull(partner?.inserted_at),
    shipped_at: toIsoOrNull(shippedAt),
    completed_at: toIsoOrNull(partner?.completed_at),
    confirmed_at: toIsoOrNull(confirmedAt),
    courier_weight: partner?.total_weight ?? "-",

    courier_reconciliation_status: partner?.courier_reconciliation_status ?? null,
    customer_reconciliation_status: partner?.customer_reconciliation_status ?? null,
    courier_reconciliation: courierReconciliation,
    customer_reconciliation: customerReconciliation,
    customer_reconciliation_cod:
      customerFee?.cod != null ? customerFee.cod / reconciliationDiv : null,

    inserted_at: toIsoOrNull(order?.inserted_at),
    updated_at: toIsoOrNull(order?.updated_at),
    assign_sale_at: toIsoOrNull(order?.assign_sale_at),
    first_assign_sale_at: toIsoOrNull(order?.first_assign_sale_at),
    expected_receipt_date: toIsoOrNull(order?.expected_receipt_date),
    assign_care_at: toIsoOrNull(order?.assign_care_at),

    tags: tagNames,
    call_status: callStatus,
    cancel_reason: cancelReason,
    assigning_sale_id: order?.assigning_sale_id ?? null,
    assigning_care_id: order?.assigning_care_id ?? null,

    telesale_note: order?.telesale_note ?? null,
    service_types: Array.isArray(order?.service_types) ? order.service_types.join(", ") : null,

    items: allItems,
  };
}

export function normalizeOrders(orders: AnyObj[], opts: NormalizeOptions): NormalizedOrder[] {
  return orders.map((o, i) => normalizeOrder(o, { ...opts, index: (opts.index ?? 1) + i }));
}
