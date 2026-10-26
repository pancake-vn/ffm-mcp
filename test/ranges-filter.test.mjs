// Test giá trị `<time_key>:ranges`: chỉ nhận object { since, until } là chuỗi ngày. Dạng khác làm
// BE trả HTTP 500 (mảng / chuỗi) hoặc ra số sai mà không báo lỗi (khoá con gte/lte).
// Giả lập BE bằng globalThis.fetch, không gọi BE thật. Chạy: npm test (test import từ dist/).
import { test } from "node:test";
import assert from "node:assert/strict";

const D = new URL("../dist/", import.meta.url).href;
const { validateFilter, FilterKeyError } = await import(D + "filter-schema.js");
const { handleToolCall } = await import(D + "tools.js");

const binding = { host: "https://fulfillment.pancake.vn", auth: { kind: "token", token: "t" } };
let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ success: true, data: { total_entries: 0, buckets: [] } }) };
};

test("ranges hợp lệ: object since/until, nhận cả chỉ một đầu, đầu null, mili giây, dấu cách", () => {
  const filter = {
    "inserted_at:ranges": { since: "2026-10-19T00:00:00", until: "2026-10-25T23:59:59" },
    "updated_at:ranges": { since: "2026-10-19T00:00:00+07:00" },
    "delivered_at:ranges": { until: "2026-10-25T23:59:59.999" },
    "confirmed_at:ranges": { since: null, until: "2026-10-25 23:59:59" },
    "is_exclude_inserted_at:ranges": true,
  };
  assert.deepEqual(validateFilter(filter), filter);
});

for (const [name, value] of [
  ["mảng [since, until]", ["2026-10-19T00:00:00", "2026-10-25T23:59:59"]],
  ["chuỗi", "2026-10-19..2026-10-25"],
  ["khoá con gte/lte", { gte: "2026-10-19T00:00:00", lte: "2026-10-25T23:59:59" }],
  ["object rỗng", {}],
  ["unix epoch", { since: 1760832000, until: 1761436799 }],
  ["chuỗi không phải ngày", { since: "7 ngày trước", until: "hôm nay" }],
  ["ngày không có giờ", { since: "2026-10-19", until: "2026-10-25" }],
  ["cả hai đầu null", { since: null, until: null }],
  ["null", null],
]) {
  test(`ranges không hợp lệ: ${name} → FilterKeyError`, () => {
    assert.throws(() => validateFilter({ "inserted_at:ranges": value }), FilterKeyError);
  });
}

test("order_statistics với ranges dạng mảng: báo lỗi rõ, không gọi BE", async () => {
  calls = [];
  const res = await handleToolCall(
    "order_statistics",
    { country_code: "63", group_by: ["status"], filter: { "inserted_at:ranges": ["2026-10-19T00:00:00", "2026-10-25T23:59:59"] } },
    binding,
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /inserted_at:ranges/);
  assert.match(res.content[0].text, /"since"/);
  assert.equal(calls.length, 0);
});

test("order_statistics với ranges object: gửi BE mốc UTC có Z", async () => {
  calls = [];
  const res = await handleToolCall(
    "order_statistics",
    { country_code: "63", timezone: 7, group_by: ["status"], filter: { "inserted_at:ranges": { since: "2026-10-19T00:00:00", until: "2026-10-25T23:59:59" } } },
    binding,
  );
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0].body.filter["inserted_at:ranges"], { since: "2026-10-18T17:00:00Z", until: "2026-10-25T16:59:59Z" });
});
