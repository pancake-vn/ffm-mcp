// Test lọc / gom nhóm theo user: kiểm tra UUID ở filter, tool find_users, nhãn tên user khi
// group_by assigning_sale_id. Giả lập BE bằng globalThis.fetch, không gọi BE thật.
// Chạy: npm test (build dist trước, test import từ dist/).
import { test } from "node:test";
import assert from "node:assert/strict";

const D = new URL("../dist/", import.meta.url).href;
const { validateFilter, FilterKeyError } = await import(D + "filter-schema.js");
const { handleToolCall } = await import(D + "tools.js");

const JENNY = "0b7c2f4e-1a2b-4c3d-8e9f-001122334455";
const MIKA = "9f8e7d6c-5b4a-4c3d-8e2f-665544332211";
const binding = { host: "https://fulfillment.pancake.vn", auth: { kind: "token", token: "t" } };

const users = [
  { id: JENNY, first_name: "Jenny", last_name: null, username: null, email: "jenny@gmail.com", group: "SALE" },
  { id: MIKA, first_name: null, last_name: null, username: null, email: "mika@gmail.com", group: "CS" },
];

let calls = [];
let statsResponse = {};
let usersDenied = false;
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ path: u.pathname, body });
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  if (u.pathname === "/api/users/get_users") {
    // Plug Authorize: role không có quyền user.view → HTTP 400 "Not enough permission".
    if (usersDenied) return { ok: false, status: 400, text: async () => '{"success":false,"message":"Not enough permission"}' };
    const kw = body.filter.keyword?.[0];
    return ok({ data: kw ? users.filter((x) => x.email === kw || x.first_name === kw) : users });
  }
  if (u.pathname === "/api/orders/statistics") return ok(statsResponse);
  throw new Error("unexpected " + u.pathname);
};

test("filter theo user: nhận UUID và no_user/has_user đứng một mình, scalar được bọc thành mảng", () => {
  assert.deepEqual(
    validateFilter({ assigning_sale_id: JENNY, assigning_care_id: ["no_user"], "inserted_at:editor_ids": MIKA }),
    { assigning_sale_id: [JENNY], assigning_care_id: ["no_user"], "inserted_at:editor_ids": [MIKA] },
  );
  assert.deepEqual(validateFilter({ assigning_sale_id: "has_user" }), { assigning_sale_id: ["has_user"] });
});

test("cờ exclude của khoá user (is_exclude_<field>:editor_ids / is_exclude_assigning_sale_id) là boolean, không bị nhầm là UUID", () => {
  assert.deepEqual(
    validateFilter({
      "is_exclude_inserted_at:editor_ids": true,
      "is_exclude_assigning_sale_id": true,
      "is_exclude_assigning_care_id": false,
    }),
    {
      "is_exclude_inserted_at:editor_ids": true,
      "is_exclude_assigning_sale_id": true,
      "is_exclude_assigning_care_id": false,
    },
  );
});

test("filter theo user: UUID chữ hoa được đổi về chữ thường (ES keyword phân biệt hoa thường)", () => {
  assert.deepEqual(validateFilter({ creator_id: [JENNY.toUpperCase()] }), { creator_id: [JENNY] });
});

test("filter theo user: số, tên, email bị từ chối kèm hướng dẫn find_users", () => {
  for (const f of [
    { assigning_sale_id: [12] },
    { assigning_care_id: ["Jenny"] },
    { creator_id: "jenny@gmail.com" },
    { creator_id: ["no_user"] }, // no_user chỉ hợp lệ với assigning_*
    { "updated_at:editor_ids": [5] },
    { "updated_at:editor_ids": 5 }, // scalar cũng được kiểm tra sau khi bọc thành mảng
    { assigning_sale_id: ["has_user", JENNY] }, // BE bỏ has_user khi trộn với UUID
    { assigning_care_id: ["no_user", "has_user"] }, // BE dựng should rỗng → 0 đơn
  ]) {
    assert.throws(() => validateFilter(f), (e) => e instanceof FilterKeyError && /find_users/.test(e.message));
  }
});

test("find_users gửi get_all + keyword, trả id / tên / email gọn", async () => {
  calls = [];
  const r = await handleToolCall("find_users", { country_code: "63", keyword: " Jenny " }, binding);
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls[0].body, { get_all: true, filter: { keyword: ["Jenny"] } });
  const out = JSON.parse(r.content[0].text);
  assert.deepEqual(out, { total: 1, users: [{ id: JENNY, name: "Jenny", email: "jenny@gmail.com", username: null, group: "SALE" }] });
});

test("find_users không keyword → gửi filter rỗng, user không có tên thì lấy email", async () => {
  calls = [];
  const out = JSON.parse((await handleToolCall("find_users", { country_code: "63" }, binding)).content[0].text);
  assert.deepEqual(calls[0].body, { get_all: true, filter: {} });
  assert.equal(out.users.find((x) => x.id === MIKA).name, "mika@gmail.com");
});

test("group_by assigning_sale_id: nhãn là tên user, no_user → 'No user', UUID lạ giữ nguyên", async () => {
  const STRANGER = "11111111-2222-4333-8444-555555555555";
  statsResponse = {
    total_entries: 6,
    group_by: ["assigning_sale_id"],
    metrics: ["cod"],
    totals: { cod: 0 },
    buckets: [
      { keys: [{ key: JENNY }], count: 3, values: { cod: 0 } },
      { keys: [{ key: "no_user" }], count: 2, values: { cod: 0 } },
      { keys: [{ key: STRANGER }], count: 1, values: { cod: 0 } },
    ],
  };
  calls = [];
  const r = await handleToolCall("order_statistics", { country_code: "63", group_by: "assigning_sale_id" }, binding);
  const out = JSON.parse(r.content[0].text);
  assert.deepEqual(out.buckets.map((b) => b.labels[0]), ["Jenny", "No user", `User ${STRANGER}`]);
  assert.deepEqual(calls.map((c) => c.path), ["/api/orders/statistics", "/api/users/get_users"]);
});

test("group_by không theo user → không gọi API user", async () => {
  statsResponse = { total_entries: 0, group_by: ["status"], metrics: ["cod"], totals: { cod: 0 }, buckets: [] };
  calls = [];
  await handleToolCall("order_statistics", { country_code: "63", group_by: "status" }, binding);
  assert.deepEqual(calls.map((c) => c.path), ["/api/orders/statistics"]);
});

test("role không có quyền user.view: gom theo user vẫn trả số liệu, nhãn là UUID", async () => {
  statsResponse = {
    total_entries: 3,
    group_by: ["assigning_sale_id"],
    metrics: ["cod"],
    totals: { cod: 0 },
    buckets: [{ keys: [{ key: JENNY }], count: 3, values: { cod: 0 } }],
  };
  usersDenied = true;
  try {
    const r = await handleToolCall("order_statistics", { country_code: "63", group_by: "assigning_sale_id" }, binding);
    assert.equal(r.isError, undefined);
    assert.deepEqual(JSON.parse(r.content[0].text).buckets[0].labels, [`User ${JENNY}`]);
    // find_users thì báo lỗi rõ ràng thay vì trả [] (dễ hiểu nhầm là không có user).
    const f = await handleToolCall("find_users", { country_code: "63", keyword: "Jenny" }, binding);
    assert.equal(f.isError, true);
    assert.match(f.content[0].text, /Not enough permission/);
  } finally {
    usersDenied = false;
  }
});
