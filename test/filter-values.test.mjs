// Test tool list_filter_values: mỗi bộ lọc gọi đúng API của web FFM và trả đúng dạng value web
// gửi BE. Kèm test mô tả filter (giá trị reconciliation status) và khoá condition_*.
// Giả lập BE bằng globalThis.fetch, không gọi BE thật. Chạy: npm test (test import từ dist/).
import { test } from "node:test";
import assert from "node:assert/strict";

const D = new URL("../dist/", import.meta.url).href;
const { handleToolCall, TOOL_DEFS } = await import(D + "tools.js");
const { validateFilter } = await import(D + "filter-schema.js");

const binding = { host: "https://fulfillment.pancake.vn", auth: { kind: "token", token: "t" } };

let calls = [];
const routes = {
  "GET /api/ffm_settings": (q) =>
    ({
      order_pending_reason: [
        { id: 11, type: "order_pending_reason", settings: { reason: "Customer bussy" } },
        { id: 12, type: "order_pending_reason", settings: { reason: "Khách gọi không nghe máy" } },
      ],
      customer_service_type: [{ id: 5, settings: { name: "COD Express" } }],
    })[q.get("type")] ?? [],
  "GET /api/partners": () => [
    { id: 3, name: "jnt", common_settings: { custom_name: "J&T Express" } },
    { id: 8, name: "hidden" },
  ],
  "GET /api/orders/tag_group_options": () => [
    { label: "System", children: [{ key: "a", label: "Urgent", tag_name: "urgent" }] },
    { label: "Shop A", children: [{ key: "b", label: "Urgent", tag_name: "urgent" }, { key: "c", label: "VIP", tag_name: "vip" }] },
  ],
  "GET /api/geo/districts": (q) => [{ id: `d-${q.get("province_id")}`, name: "Makati" }],
  "GET /api/saved_filters": () => [{ id: 7, name: "PH đơn huỷ", filters: { status: ["cancel"] } }],
  "GET /api/warehouses": () => Array.from({ length: 205 }, (_, i) => ({ id: i + 1, name: `WH ${i + 1}` })),
};
const rawRoutes = {
  "POST /api/products/get_products": () => ({
    success: true,
    products: { data: [{ id: 99, name: "Áo thun", custom_id: "AT01" }], total_entries: 350 },
  }),
  "POST /api/variations/get_variations": () => ({
    success: true,
    data: [{ id: 501, custom_id: "AT01-RED", product: { name: "Áo thun" }, fields: [{ name: "Color", value: "Red" }] }],
  }),
  "GET /api/products/combo": () => ({
    success: true,
    total_entries: 2,
    entries: [
      { id: 1, pos_combo_id: "c-77", name: "Combo hè", shop_id: 1 },
      { id: 2, pos_combo_id: "c-77", name: "Combo hè", shop_id: 2 },
    ],
  }),
};

globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const route = `${init.method} ${u.pathname}`;
  calls.push({ route, query: u.searchParams, body: init.body ? JSON.parse(init.body) : null });
  const ok = (json) => ({ ok: true, status: 200, json: async () => json });
  if (rawRoutes[route]) return ok(rawRoutes[route](u.searchParams));
  if (routes[route]) return ok({ success: true, data: routes[route](u.searchParams) });
  throw new Error("unexpected " + route);
};

async function call(args) {
  calls = [];
  const res = await handleToolCall("list_filter_values", { country_code: "63", ...args }, binding);
  return { res, json: res.isError ? null : JSON.parse(res.content[0].text) };
}

test("pending_reason_id: id FFMSetting + Other = -1, tìm không dấu", async () => {
  const { json } = await call({ filter_key: "pending_reason_id" });
  assert.equal(calls[0].query.get("type"), "order_pending_reason");
  assert.equal(calls[0].query.get("country_code"), "63");
  assert.deepEqual(json.values.map((v) => v.value), [11, 12, -1]);
  assert.equal(json.send_as, "pending_reason_id");

  const { json: found } = await call({ filter_key: "pending_reason_id", keyword: "khach goi" });
  assert.deepEqual(found.values.map((v) => v.value), [12]);
});

test("partner_id: bỏ partner 8, nhãn lấy custom_name, có no_courier", async () => {
  const { json } = await call({ filter_key: "partner_id" });
  assert.deepEqual(json.values, [
    { value: "no_courier", label: "No courier" },
    { value: 3, label: "J&T Express" },
  ]);
});

test("tag: value là TÊN tag, gộp tên trùng giữa các nhóm, exclude_tags giữ send_as", async () => {
  const { json } = await call({ filter_key: "exclude_tags" });
  assert.equal(json.send_as, "exclude_tags");
  assert.deepEqual(json.values.map((v) => v.value), ["no_tag", "urgent", "vip"]);
});

test("product_id: bắt buộc keyword, gửi text lên BE, đọc products.data", async () => {
  const { res } = await call({ filter_key: "product_id" });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);

  const { json } = await call({ filter_key: "product_id", keyword: "áo" });
  assert.deepEqual(calls[0].body, { text: "áo", page_size: 200 });
  assert.deepEqual(json.values, [{ value: 99, label: "Áo thun", custom_id: "AT01" }]);
  // BE phân trang: tổng thật lấy từ total_entries → báo truncated.
  assert.equal(json.total, 350);
  assert.ok(json.truncated);
});

test("variation_id: đọc mảng trong data, kèm thuộc tính biến thể", async () => {
  const { json } = await call({ filter_key: "variation_id", keyword: "AT01" });
  assert.deepEqual(calls[0].body, { text: "AT01", get_all: true });
  assert.deepEqual(json.values, [{ value: 501, label: "Áo thun", custom_id: "AT01-RED", fields: "Color: Red" }]);
});

test("combo_product: value là pos_combo_id, đọc entries", async () => {
  const { json } = await call({ filter_key: "combo_product", keyword: "hè" });
  assert.equal(calls[0].query.get("keyword"), "hè");
  assert.deepEqual(json.values.map((v) => v.value), ["c-77"]); // 2 shop cùng combo POS → gộp 1
  assert.equal(json.truncated, undefined);
});

test("district_id: cần parent_id, gửi province_id", async () => {
  const { res } = await call({ filter_key: "district_id" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /parent_id/);

  const { json } = await call({ filter_key: "district_id", parent_id: "p1" });
  assert.equal(calls[0].query.get("province_id"), "p1");
  assert.deepEqual(json.values, [{ value: "d-p1", label: "Makati" }]);
});

test("sub_status: danh sách tĩnh, không gọi BE, không có no_sub_status", async () => {
  const { json } = await call({ filter_key: "sub_status" });
  assert.equal(calls.length, 0);
  assert.ok(json.values.some((v) => v.value === "out_for_delivery"));
  assert.ok(!json.values.some((v) => v.value === "no_sub_status"));
});

test("saved_filter: lấy bộ lọc của màn order-data kèm filters", async () => {
  const { json } = await call({ filter_key: "saved_filter_id" });
  assert.equal(calls[0].query.get("table_key"), "order-data");
  assert.deepEqual(json.values, [{ value: 7, label: "PH đơn huỷ", filters: { status: ["cancel"] } }]);
});

test("danh sách dài: cắt ở 200 và báo truncated", async () => {
  const { json } = await call({ filter_key: "slot_warehouse_id" });
  assert.equal(json.total, 205);
  assert.equal(json.values.length, 200);
  assert.ok(json.truncated);
});

test("filter_key không hỗ trợ → báo lỗi kèm danh sách khoá", async () => {
  const { res } = await call({ filter_key: "warehouse" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /slot_warehouse_id/);
});

test("mô tả filter: reconciliation status đúng giá trị cột order_partners", () => {
  const desc = TOOL_DEFS.find((t) => t.name === "order_statistics").inputSchema.properties.filter.description;
  assert.match(desc, /'customer_reconciling'\|'customer_reconciled'/);
  assert.doesNotMatch(desc, /sent_email|'importing'/);
  assert.ok(TOOL_DEFS.some((t) => t.name === "list_filter_values"));
});

test("condition_* (AND/OR) đi qua validateFilter", () => {
  const filter = { include_tags: ["urgent", "vip"], condition_include_tags: "and", condition_product_id: "or" };
  assert.deepEqual(validateFilter(filter), filter);
});
