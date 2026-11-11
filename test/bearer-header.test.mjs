// Test mọi request gọi BE (callStatistics / fetchShops / fetchUsers / callApi) gửi token bằng
// header `Authorization: Bearer` và KHÔNG đặt `access_token` trên URL (URL hay bị ghi vào log).
// Giả lập BE bằng globalThis.fetch, không gọi BE thật. Chạy: npm test (test import từ dist/).
import { test } from "node:test";
import assert from "node:assert/strict";

const D = new URL("../dist/", import.meta.url).href;
const { callStatistics, fetchShops, fetchUsers, callApi } = await import(D + "api.js");

const TOKEN = "jwt.ffm.token";
const ctx = { host: "https://fulfillment.pancake.vn/", countryCode: "63", auth: { kind: "token", token: TOKEN } };

let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: new URL(url), method: init.method, headers: init.headers });
  return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
};

function assertAuth(call, pathname) {
  assert.equal(call.url.pathname, pathname);
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.equal(call.url.searchParams.get("access_token"), null);
  assert.ok(!call.url.href.includes(TOKEN));
  assert.equal(call.url.searchParams.get("country_code"), "63");
}

test("callStatistics gửi header Bearer, không có access_token trên URL", async () => {
  calls = [];
  await callStatistics(ctx, { group_by: ["status"] });
  assert.equal(calls.length, 1);
  assertAuth(calls[0], "/api/orders/statistics");
});

test("fetchShops gửi header Bearer, không có access_token trên URL", async () => {
  calls = [];
  await fetchShops(ctx);
  assert.equal(calls.length, 1);
  assertAuth(calls[0], "/api/shops");
});

test("fetchUsers gửi header Bearer, không có access_token trên URL", async () => {
  calls = [];
  await fetchUsers(ctx, "Jenny");
  assert.equal(calls.length, 1);
  assertAuth(calls[0], "/api/users/get_users");
});

test("callApi GET và POST gửi header Bearer, không có access_token trên URL", async () => {
  calls = [];
  await callApi(ctx, "GET", "/warehouses", { query: { page_size: 200 } });
  await callApi(ctx, "POST", "/products/get_products", { body: { text: "áo" } });
  assert.equal(calls.length, 2);
  assertAuth(calls[0], "/api/warehouses");
  assertAuth(calls[1], "/api/products/get_products");
});
