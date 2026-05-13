# ffm-mcp

MCP server cho **sea-fulfillment** (Pancake FFM).

- Gọi API `POST /api/orders/get_orders` ([sea-fulfillment/lib/sea_fulfillment_web/controllers/order_controller.ex:11](https://github.com/pancake-vn/sea-fulfillment/blob/develop/lib/sea_fulfillment_web/controllers/order_controller.ex#L11))
  bằng `access_token` + `country_code`.
- Normalize order theo logic
  [sea-fulfillment-web/components/OrderExportExcel.js](https://github.com/pancake-vn/sea-fulfillment-web/blob/develop/components/OrderExportExcel.js)
  (`formatData`) — trả ra object phẳng với các field dùng để export Excel.
- Transport **stdio**, tương thích mọi AI client hỗ trợ MCP: Claude Code,
  Claude Desktop, Cursor, Cline, Continue, Windsurf, Zed, OpenAI Agents
  SDK, …

---

## 1. Cài đặt

```bash
git clone <repo-url> ffm-mcp
cd ffm-mcp
npm install
npm run build
```

Yêu cầu Node 18+ (cần global `fetch`).

Sau bước này có binary chạy được:

```bash
node /absolute/path/to/ffm-mcp/dist/index.js
# → [ffm-mcp] ready on stdio
```

Hoặc symlink global cho gọn:

```bash
npm link            # tạo bin `ffm-mcp` trên PATH
ffm-mcp             # chạy server
```

---

## 2. Cấu hình auth

Server cần `access_token` (Pancake) — token giống FE
[sea-fulfillment-web actions/order.js:62](https://github.com/pancake-vn/sea-fulfillment-web/blob/develop/actions/order.js#L62)
dùng query `?access_token=…`.

| Biến / tham số | Mặc định | Note |
|---|---|---|
| `SEA_FULFILLMENT_ACCESS_TOKEN` | _(bắt buộc)_ | Có thể override bằng tham số `access_token` mỗi tool call. |
| `SEA_FULFILLMENT_HOST` | _(bắt buộc)_ | Base URL BE — **KHÔNG có default**. 10 supported_hosts khác tenant (xem §2.2), default âm thầm dễ gửi token sai tenant. Override bằng tham số `host` mỗi tool call. |
| `SEA_FULFILLMENT_COUNTRY_CODE` | `63` | Phone-code, xem §2.1. |

### 2.1. `country_code`

Phone-code (string) — KHÔNG dùng ISO 2 chữ. Đồng bộ
[sea-fulfillment lib/app/constant.ex:93-99](https://github.com/pancake-vn/sea-fulfillment/blob/develop/lib/app/constant.ex#L93-L99)
(`supported_countries` — có currency map):

| `country_code` | Country | Short | Currency |
|---|---|---|---|
| `"63"` | Philippines | PH | PHP |
| `"66"` | Thailand | TH | THB |
| `"60"` | Malaysia | MY | MYR |
| `"62"` | Indonesia | ID | IDR |
| `"65"` | Singapore | SG | SGD |

Ngoài ra BE còn accept (theo
[`supported_country_codes`](https://github.com/pancake-vn/sea-fulfillment/blob/develop/lib/app/constant.ex#L70)):

| `country_code` | Country | Note |
|---|---|---|
| `"856"` | Laos | BE accept nhưng MCP không có currency map → tiền fallback chia `/100` (có thể sai với LAK). |

> KHÔNG dùng `"VN"`, `"84"`, `"VND"` — Vietnam KHÔNG nằm trong supported
> countries (CLAUDE.md §7).

### 2.2. `host`

Base URL gồm scheme. Đồng bộ
[sea-fulfillment lib/app/constant.ex:72-83](https://github.com/pancake-vn/sea-fulfillment/blob/develop/lib/app/constant.ex#L72-L83)
(`supported_hosts`):

| Host (`SEA_FULFILLMENT_HOST`) | `app_id` | Prefix | Note |
|---|---|---|---|
| `https://fulfillment.pancake.vn` | 99 | PFFM | Production Pancake FFM |
| `https://g-solution.vn` | 1 | GIP | G-Solution |
| `https://afgwarehouse.net` | 2 | AFG | AFG Warehouse |
| `https://app.mspeedyexpress.com` | 3 | MSX | M-Speedy Express |
| `https://lynexpress.co` | 4 | LYN | Lyn Express |
| `https://buber.pancake.vn` | 5 | BUBER | Buber |
| `https://admin.ifgfulfillmentglobal.com` | 6 | IFG | IFG Fulfillment Global |
| `https://bigate.co` | 9 | BIG | Bigate |

> `app_id` được BE auto-detect từ hostname trong request — bạn không cần
> truyền `app_id` thủ công. Đảm bảo `access_token` được issue đúng cho host
> đó (token cross-host sẽ trả 401/403).

> **Bảo mật:** `access_token` cho phép thao tác đầy đủ user. Lưu trong env
> hoặc config client — đừng commit thẳng.

---

## 3. Cắm vào AI client

Đường dẫn ví dụ giả định bạn build ở `/Users/me/ffm-mcp` — đổi tuyệt đối
phù hợp máy bạn. Mọi client đều cùng pattern: chạy `node dist/index.js`,
truyền env vars.

### 3.1. Claude Code (Anthropic CLI)

**Cách 1 — CLI (recommend):**

```bash
# Scope user (mọi project):
claude mcp add ffm \
  --scope user \
  --env SEA_FULFILLMENT_ACCESS_TOKEN=YOUR_TOKEN \
  --env SEA_FULFILLMENT_HOST=https://fulfillment.pancake.vn \
  --env SEA_FULFILLMENT_COUNTRY_CODE=63 \
  -- node /absolute/path/to/ffm-mcp/dist/index.js

# Hoặc scope project (chỉ repo hiện tại, commit kèm code được):
claude mcp add ffm \
  --scope project \
  --env SEA_FULFILLMENT_ACCESS_TOKEN=YOUR_TOKEN \
  --env SEA_FULFILLMENT_HOST=https://fulfillment.pancake.vn \
  -- node /absolute/path/to/ffm-mcp/dist/index.js
```

Verify:

```bash
claude mcp list
# → ffm: node /absolute/path/to/ffm-mcp/dist/index.js  ✓ Connected
```

**Cách 2 — sửa tay file config** (`~/.claude.json` hoặc project
`.claude.json`):

```json
{
  "mcpServers": {
    "ffm": {
      "command": "node",
      "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
      "env": {
        "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
        "SEA_FULFILLMENT_COUNTRY_CODE": "63"
      }
    }
  }
}
```

Trong session Claude Code, gõ `/mcp` để xem trạng thái. Tool sẽ xuất hiện
là `mcp__ffm__get_orders` và `mcp__ffm__get_orders_normalized`.

### 3.2. Claude Desktop (claude.ai macOS / Windows)

File config:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ffm": {
      "command": "node",
      "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
      "env": {
        "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
        "SEA_FULFILLMENT_COUNTRY_CODE": "63"
      }
    }
  }
}
```

Restart Claude Desktop → icon 🔌 dưới chat box → thấy `ffm` ✓.

### 3.3. Cursor

Mở **Settings → MCP → Add new MCP server**, hoặc edit file:
`~/.cursor/mcp.json` (global) / `<project>/.cursor/mcp.json` (per project).

```json
{
  "mcpServers": {
    "ffm": {
      "command": "node",
      "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
      "env": {
        "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
        "SEA_FULFILLMENT_COUNTRY_CODE": "63"
      }
    }
  }
}
```

Restart Cursor (Cmd+Shift+P → `Developer: Reload Window`).

### 3.4. Cline (VS Code extension)

Cline UI → **MCP Servers → Edit Configuration**, hoặc edit:
`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
(macOS; Linux/Windows tương tự).

```json
{
  "mcpServers": {
    "ffm": {
      "command": "node",
      "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
      "env": {
        "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
        "SEA_FULFILLMENT_COUNTRY_CODE": "63"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### 3.5. Continue (VS Code / JetBrains)

Edit `~/.continue/config.json` (hoặc `.continue/config.json` per project):

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
          "env": {
            "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
            "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
            "SEA_FULFILLMENT_COUNTRY_CODE": "63"
          }
        }
      }
    ]
  }
}
```

### 3.6. Windsurf (Codeium)

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ffm": {
      "command": "node",
      "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
      "env": {
        "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
        "SEA_FULFILLMENT_COUNTRY_CODE": "63"
      }
    }
  }
}
```

### 3.7. Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "ffm": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/ffm-mcp/dist/index.js"],
        "env": {
          "SEA_FULFILLMENT_ACCESS_TOKEN": "YOUR_TOKEN",
          "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn",
          "SEA_FULFILLMENT_COUNTRY_CODE": "63"
        }
      },
      "settings": {}
    }
  }
}
```

### 3.8. Client khác (OpenAI Agents SDK, custom MCP host)

Mọi MCP client hỗ trợ **stdio transport** đều dùng được. Pattern chung:

```
command: node
args:    ["/absolute/path/to/ffm-mcp/dist/index.js"]
env:
  SEA_FULFILLMENT_ACCESS_TOKEN  (bắt buộc)
  SEA_FULFILLMENT_HOST          (bắt buộc, vd https://fulfillment.pancake.vn)
  SEA_FULFILLMENT_COUNTRY_CODE  (optional, default 63)
```

Debug nhanh bằng MCP Inspector:

```bash
npx @modelcontextprotocol/inspector \
  -e SEA_FULFILLMENT_ACCESS_TOKEN=YOUR_TOKEN \
  -e SEA_FULFILLMENT_HOST=https://fulfillment.pancake.vn \
  -e SEA_FULFILLMENT_COUNTRY_CODE=63 \
  node /absolute/path/to/ffm-mcp/dist/index.js
```

---

## 4. Tools

### `get_orders`

Pass-through tới BE — trả raw response (`data`, `page`, `total_pages`, …).

| field | type | note |
|---|---|---|
| `access_token` | string? | optional, fallback env |
| `country_code` | string? | default `"63"` |
| `host` | string? | override base URL |
| `filter` | object? | vd `{ "order_ids": [1,2] }`, `{ "statuses": ["shipped"] }` |
| `page` | number? | |
| `page_size` | number? | |
| `load_full` | boolean? | true → BE trả full schema (cần cho normalize) |
| `is_summarize` | boolean? | |
| `extra` | object? | merge vào body request |

### `get_orders_normalized`

Tự bật `load_full=true`, gọi BE, rồi chạy port của
`OrderExportExcel.formatData`. Output là mảng order phẳng với các trường:

- **Base:** `id`, `display_id`, `status` (text), `status_key`, `index`,
  `requested_tracking_id`, `platform_order_id`
- **Shop:** `shop_id`, `pos_shop_id`, `pos_shop_name`, `shop`
- **Customer / address:** `customer_name`, `phone_number`, `province_name`,
  `district_name`, `commune_name`, `postal_code`, `full_address`,
  `country_code`
- **Items:** `total_quantity`, `total_weight` (gram), `weight` (kg),
  `product_name`, `remarks`, `items` (raw)
- **Money** (đã chia `/100` nếu currency không thuộc `INT_CURRENCY_LIST`):
  `surcharge`, `cod`, `total_price`, `transfer_money`
- **Partner / shipping:** `tracking_number`, `partner_name`,
  `delivery_status`, `send_to_partner_at`, `shipped_at`, `completed_at`,
  `confirmed_at`, `courier_weight`
- **Reconciliation:** `courier_reconciliation_status`,
  `customer_reconciliation_status`, `courier_reconciliation`
  (map theo `RECONCILIATION_KEYS`), `customer_reconciliation`,
  `customer_reconciliation_cod`
- **Date:** `inserted_at`, `updated_at`, `assign_sale_at`,
  `first_assign_sale_at`, `expected_receipt_date`, `assign_care_at`
- **Tags / reason / user:** `tags` (name array), `call_status`,
  `cancel_reason`, `assigning_sale_id`, `assigning_care_id`
- **Misc:** `telesale_note`, `service_types`

Datetime trả ISO string — client tự format theo locale (FE bản gốc dùng
`handleExportDateTime`).

Input thêm so với `get_orders`:

| field | type | note |
|---|---|---|
| `paginate` | boolean? | true → loop tới hết hoặc đạt `max_pages` |
| `max_pages` | number? | default 20 |

Output:

```json
{
  "country_code": "63",
  "count": 12,
  "pagination": { "page": 1, "page_size": 50, "total": 12, "total_pages": 1 },
  "orders": [ /* NormalizedOrder[] */ ]
}
```

Khi `paginate=true`, `pagination` là `null` (đã gộp).

---

## 5. Ví dụ prompt

Sau khi cắm xong, hỏi assistant:

> Lấy 5 đơn shipped gần nhất ở shop 1234 và liệt kê tracking_number,
> partner_name, full_address, total_price.

Assistant sẽ gọi `get_orders_normalized` với
`filter={ shop_ids: [1234], statuses: ["shipped"] }`, `page_size=5`,
rồi trả về danh sách.

> Có bao nhiêu đơn COD trên 500K chưa reconcile với courier?

→ assistant gọi với `filter={ courier_reconciliation_status:
"not_reconciled" }` + `paginate=true`, lọc `cod > 500` rồi đếm.

---

## 6. Troubleshooting

| Triệu chứng | Xử lý |
|---|---|
| `Missing access_token` | Truyền tham số `access_token` hoặc set env `SEA_FULFILLMENT_ACCESS_TOKEN`. |
| `Missing host` | Set env `SEA_FULFILLMENT_HOST` (vd `https://fulfillment.pancake.vn`) hoặc truyền `host` mỗi call. Xem §2.2. |
| `get_orders HTTP 401` | Token hết hạn / sai. Login lại Pancake FE, copy token mới. |
| `get_orders HTTP 403` | Token đúng nhưng `country_code` không match country user được phép. |
| Tool không xuất hiện trong Claude Code | `claude mcp list` xem status. Nếu `✗ Failed`, chạy lệnh ở mục 1 verify binary `node dist/index.js` chạy được. |
| Server log `0_VN_orders_alias` | Bạn truyền `country_code=VN/84` — sai. Phải là `63 / 66 / 60 / 62 / 65`. |
| Tiền bị nhân 100 sai | Check `country_code` truyền đúng — logic chia `/100` đọc currency theo country (xem `INT_CURRENCY_LIST` trong [src/constants.ts](src/constants.ts)). |

---

## 7. Dev

```bash
npm run dev    # tsc watch
node dist/index.js

# Inspector UI:
npx @modelcontextprotocol/inspector node dist/index.js
```

Source map:
- [src/index.ts](src/index.ts) — MCP server entry, tool routing.
- [src/api.ts](src/api.ts) — HTTP client `callGetOrders` + `fetchAllOrders`.
- [src/normalize.ts](src/normalize.ts) — port `OrderExportExcel.formatData`.
- [src/constants.ts](src/constants.ts) — `INT_CURRENCY_LIST`,
  `SUPPORTED_COUNTRIES`, `ORDER_STATUS_TEXT`, `RECONCILIATION_KEYS`.
