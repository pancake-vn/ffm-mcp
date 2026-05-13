# sea-fulfillment-orders-mcp

MCP server (stdio) wrap API `POST /api/orders/get_orders` của
[sea-fulfillment](https://github.com/pancake-vn/sea-fulfillment) BE
(controller [lib/sea_fulfillment_web/controllers/order_controller.ex:11](https://github.com/pancake-vn/sea-fulfillment/blob/develop/lib/sea_fulfillment_web/controllers/order_controller.ex#L11))
và normalize order theo các field mà
[sea-fulfillment-web `components/OrderExportExcel.js`](https://github.com/pancake-vn/sea-fulfillment-web/blob/develop/components/OrderExportExcel.js)
đang dùng cho file Excel export (`formatData`).

> Repo này độc lập với `sea-fulfillment` / `sea-fulfillment-web`. Không phụ
> thuộc code Elixir hay Next.js — chỉ gọi HTTP API bằng `fetch`.

## Cài đặt

```bash
cd sea-fulfillment-orders-mcp
npm install
npm run build
```

## Auth

Server cần `access_token` của Pancake (giống token FE sea-fulfillment-web đang
dùng cho query `?access_token=…`).

Cách truyền (theo thứ tự ưu tiên):
1. Tham số `access_token` trong tool call.
2. Biến môi trường `SEA_FULFILLMENT_ACCESS_TOKEN`.

`country_code` mặc định `"63"` (Philippines, app_id=0). Override bằng
`SEA_FULFILLMENT_COUNTRY_CODE` hoặc tham số tool `country_code`. Giá trị BẮT
BUỘC nằm trong supported countries (`63 / 66 / 60 / 62 / 65`).

Host mặc định `https://fulfillment.pancake.vn`, override bằng
`SEA_FULFILLMENT_HOST` hoặc tham số `host`.

## Cấu hình client MCP

Ví dụ Claude Code (`~/.claude.json` hoặc project `.claude.json`):

```json
{
  "mcpServers": {
    "sea-fulfillment-orders": {
      "command": "node",
      "args": ["/absolute/path/to/sea-fulfillment-orders-mcp/dist/index.js"],
      "env": {
        "SEA_FULFILLMENT_ACCESS_TOKEN": "<token>",
        "SEA_FULFILLMENT_COUNTRY_CODE": "63"
      }
    }
  }
}
```

## Tools

### `get_orders`
Pass-through tới BE. Trả raw response (`data`, `page`, `total_pages`, …).

Input:
| field | type | note |
|-------|------|------|
| `access_token` | string? | optional, fallback env |
| `country_code` | string? | default `"63"` |
| `host` | string? | override base URL |
| `filter` | object? | request body field `filter`, vd `{ "order_ids": [1,2] }`, `{ "statuses": ["shipped"] }` |
| `page` | number? | |
| `page_size` | number? | |
| `load_full` | boolean? | true → BE trả full schema (cần cho normalize) |
| `is_summarize` | boolean? | |
| `extra` | object? | merge thêm field vào body |

### `get_orders_normalized`
Tự bật `load_full=true`, gọi BE, rồi normalize qua port của
`OrderExportExcel.formatData`. Output là mảng order phẳng với các trường:

- Base: `id`, `display_id`, `status` (text), `status_key`, `index`,
  `requested_tracking_id`, `platform_order_id`
- Shop: `shop_id`, `pos_shop_id`, `pos_shop_name`, `shop`
- Customer / address: `customer_name`, `phone_number`, `province_name`,
  `district_name`, `commune_name`, `postal_code`, `full_address`, `country_code`
- Items: `total_quantity`, `total_weight` (gram), `weight` (kg),
  `product_name`, `remarks`, `items` (raw)
- Money (đã chia /100 nếu currency không thuộc `INT_CURRENCY_LIST`):
  `surcharge`, `cod`, `total_price`, `transfer_money`
- Partner / shipping: `tracking_number`, `partner_name`, `delivery_status`,
  `send_to_partner_at`, `shipped_at`, `completed_at`, `confirmed_at`,
  `courier_weight`
- Reconciliation: `courier_reconciliation_status`,
  `customer_reconciliation_status`, `courier_reconciliation` (map theo
  `RECONCILIATION_KEYS`), `customer_reconciliation`,
  `customer_reconciliation_cod`
- Date: `inserted_at`, `updated_at`, `assign_sale_at`,
  `first_assign_sale_at`, `expected_receipt_date`, `assign_care_at`
- Tags / reason / user: `tags` (name array), `call_status`, `cancel_reason`,
  `assigning_sale_id`, `assigning_care_id`
- Misc: `telesale_note`, `service_types`

Datetime trả ISO string — client tự format theo locale nếu cần (FE bản gốc
gọi `handleExportDateTime(value, datetimeFormat)`).

Input (thêm vào input của `get_orders`):
| field | type | note |
|-------|------|------|
| `paginate` | boolean? | true → loop tới hết hoặc đạt `max_pages` |
| `max_pages` | number? | default 20 |

Output shape:

```json
{
  "country_code": "63",
  "count": 12,
  "pagination": { "page": 1, "page_size": 50, "total": 12, "total_pages": 1 },
  "orders": [ /* NormalizedOrder[] */ ]
}
```

Khi `paginate=true`, `pagination` là `null` (đã gộp).

## Lưu ý

- `access_token` được put vào query string giống FE (`?access_token=`).
  Đảm bảo MCP client config được lưu an toàn — token có quyền đầy đủ user.
- `country_code` chỉ chấp nhận supported countries — `"VN"` / `"84"` / `"VND"`
  sai schema BE.
- Logic chia tiền `/100` dựa trên `currencyByCountry(country_code)` so với
  `INT_CURRENCY_LIST` (đồng bộ `sea-fulfillment-web/utils/tools.js`).
- `reconciliationDiv` đọc theo `partner.currency` (giữ giống FE) — nếu BE
  không trả `partner.currency` cho 1 order, fallback `/100`.

## Dev

```bash
npm run dev    # tsc watch
node dist/index.js
```

Test nhanh bằng `npx @modelcontextprotocol/inspector node dist/index.js`.
