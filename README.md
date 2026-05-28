# ffm-mcp

MCP server cho **sea-fulfillment** (Pancake FFM). Cắm vào trợ lý AI (Claude
Desktop, Claude Code, Cursor, …) để hỏi và lấy dữ liệu đơn hàng bằng lời
nói bình thường — không cần viết code.

Server tự đăng nhập bằng `username` + `password`, gọi API
`POST /api/orders/get_orders`, và **normalize** order theo đúng các trường
FE dùng để export Excel (`OrderExportExcel.formatData`) — trả ra object
phẳng dễ đọc, dễ xuất bảng.

> **Đi nhanh:** [§1 Chuẩn bị](#1-chuẩn-bị) → [§2 Thông tin đăng
> nhập](#2-thông-tin-đăng-nhập) → [§3 Cắm vào AI client](#3-cắm-vào-ai-client)
> → [§4 Thử kết nối](#4-thử-kết-nối). Mục [§6 Thư viện prompt](#6-thư-viện-prompt)
> có sẵn câu lệnh copy-paste.

---

## 1. Chuẩn bị

Cần có sẵn:

- **Node.js 18+** trên máy (kiểm tra: `node -v`). Đây là yêu cầu duy nhất —
  không cần clone repo hay build tay (xem §3).
- **Một tài khoản sea-fulfillment** (username/email/SĐT + password) có quyền
  xem đơn hàng.
- Biết **host** của tenant mình và **country_code** (phone-code) đang vận
  hành — xem bảng ở [§2.2](#22-host--tenant) và [§2.3](#23-country_code).

---

## 2. Thông tin đăng nhập

Server tự quản lý `access_token` — bạn **chỉ cần cấu hình 3 biến môi
trường**. Pancake JWT (30 ngày) được fetch + cache trong process, tự refresh
khi sắp hết hạn hoặc khi BE trả 401.

| Biến môi trường | Bắt buộc | Giá trị |
|---|---|---|
| `SEA_FULFILLMENT_USERNAME` | ✅ | Username, email, hoặc số điện thoại đăng nhập. |
| `SEA_FULFILLMENT_PASSWORD` | ✅ | Mật khẩu (plain text). |
| `SEA_FULFILLMENT_HOST` | ✅ | Base URL BE của tenant — vd `https://fulfillment.pancake.vn`. Không có default. Xem [§2.2](#22-host--tenant). |

> `country_code` **KHÔNG nằm ở env** — truyền theo từng câu hỏi (mỗi tool
> call). Lý do: 1 tài khoản có thể quản nhiều quốc gia; để default dễ hỏi
> nhầm nước. Thường bạn chỉ cần nói "đơn ở Philippines" và AI tự điền
> `country_code=63`.

> ⚠️ **Bảo mật:** mật khẩu được lưu trong file cấu hình của AI client (vd
> `~/.claude.json`, `claude_desktop_config.json`). KHÔNG commit file này lên
> git public, cẩn thận khi share màn hình / sync iCloud. Nên tạo user riêng
> quyền tối thiểu cho automation thay vì dùng tài khoản admin chính.

### 2.1. Cách auto-login hoạt động

1. Tool call đầu tiên → server `POST {host}/api/users/login/password` với
   `{username, password}`.
2. BE trả `{ success: true, access_token: "<jwt>", user: {...} }`. Server
   decode payload JWT đọc claim `exp` (= `iat + 30 ngày`), cache theo key
   `host::username`.
3. Các call sau dùng cache, refresh trước hạn 5 phút để tránh race.
4. Nếu BE trả 401 → invalidate cache + force re-login + retry 1 lần.

Cache là in-memory per-process: restart client → mất cache, login lại lần kế.

`app_id` được BE tự nhận diện theo hostname trong request — bạn **không cần**
truyền `app_id`, chỉ cần login đúng host của tenant.

### 2.2. `host` / tenant

Base URL gồm scheme. Các host BE accept:

| `SEA_FULFILLMENT_HOST` | `app_id` | Tenant |
|---|---|---|
| `https://fulfillment.pancake.vn` | 99 | Pancake FFM (production) |
| `https://g-solution.vn` | 1 | G-Solution |
| `https://afgwarehouse.net` | 2 | AFG Warehouse |
| `https://app.mspeedyexpress.com` | 3 | M-Speedy Express |
| `https://lynexpress.co` | 4 | Lyn Express |
| `https://buber.pancake.vn` | 5 | Buber |
| `https://admin.ifgfulfillmentglobal.com` | 6 | IFG Fulfillment Global |
| `https://bigate.co` | 9 | Bigate |

> Login phải đúng host của tenant mình; login cross-host sẽ trả
> `Wrong username or password`.

### 2.3. `country_code`

Phone-code (string) — truyền theo từng câu hỏi, **không dùng ISO 2 chữ**:

| `country_code` | Quốc gia | Tiền tệ |
|---|---|---|
| `"63"` | Philippines (PH) | PHP |
| `"66"` | Thailand (TH) | THB |
| `"60"` | Malaysia (MY) | MYR |
| `"62"` | Indonesia (ID) | IDR |
| `"65"` | Singapore (SG) | SGD |

BE còn accept `"856"` (Laos) nhưng MCP chưa có currency map → tiền fallback
chia `/100`, có thể sai với LAK. KHÔNG dùng `"VN"` / `"84"` / `"VND"`.

---

## 3. Cắm vào AI client

**Cách nhanh nhất — chạy thẳng từ GitHub, không cần clone/build.** `npx` tự
tải repo và build lần đầu. Chỉ cần Node 18+ (xem §1).

### 3.1. Claude Code (CLI)

Chạy 1 lệnh, thay 3 giá trị in hoa bằng thông tin của bạn:

```bash
claude mcp add ffm --scope user \
  --env SEA_FULFILLMENT_USERNAME=YOUR_USERNAME_OR_EMAIL \
  --env SEA_FULFILLMENT_PASSWORD=YOUR_PASSWORD \
  --env SEA_FULFILLMENT_HOST=https://fulfillment.pancake.vn \
  -- npx -y github:pancake-vn/ffm-mcp
```

Kiểm tra:

```bash
claude mcp list
# → ffm: npx -y github:pancake-vn/ffm-mcp  ✓ Connected
```

Trong session, gõ `/mcp` để xem trạng thái. Tool xuất hiện là
`mcp__ffm__get_orders` và `mcp__ffm__get_orders_normalized`.

### 3.2. Claude Desktop (macOS / Windows)

Mở **Settings → Developer → Edit Config** (hoặc sửa file trực tiếp):
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ffm": {
      "command": "npx",
      "args": ["-y", "github:pancake-vn/ffm-mcp"],
      "env": {
        "SEA_FULFILLMENT_USERNAME": "YOUR_USERNAME_OR_EMAIL",
        "SEA_FULFILLMENT_PASSWORD": "YOUR_PASSWORD",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn"
      }
    }
  }
}
```

Lưu xong **thoát hẳn** Claude Desktop rồi mở lại (macOS nhấn `Cmd+Q` — bấm X
chưa đủ). Thấy icon 🔌 dưới ô chat với `ffm` ✓ là xong.

> 💡 **Gotcha macOS:** app GUI không kế thừa `PATH` của shell, nên `npx` cài
> qua `nvm` đôi khi không tìm thấy. Nếu báo lỗi "command not found", thay
> `"command": "npx"` bằng đường dẫn tuyệt đối (chạy `which npx` để lấy, vd
> `/Users/me/.nvm/versions/node/v20.15.0/bin/npx`) và thêm key
> `"PATH"` vào `env` trỏ tới thư mục `bin` của Node.

### 3.3. Claude Cowork

Cowork dùng **chung danh sách MCP server với Claude Desktop**. Sau khi đã
cắm `ffm` theo §3.2, bạn dùng được ngay trong cả cuộc trò chuyện thường lẫn
chế độ Cowork — **không cần thiết lập lại**.

> Nếu Cowork không thấy server: kiểm tra đã lưu config §3.2 và **thoát hẳn**
> Claude Desktop (`Cmd+Q`) rồi mở lại. Cowork đọc config lúc khởi động app.

### 3.4. Cursor

**Settings → MCP → Add new MCP server**, hoặc sửa `~/.cursor/mcp.json`
(global) / `<project>/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ffm": {
      "command": "npx",
      "args": ["-y", "github:pancake-vn/ffm-mcp"],
      "env": {
        "SEA_FULFILLMENT_USERNAME": "YOUR_USERNAME_OR_EMAIL",
        "SEA_FULFILLMENT_PASSWORD": "YOUR_PASSWORD",
        "SEA_FULFILLMENT_HOST": "https://fulfillment.pancake.vn"
      }
    }
  }
}
```

Reload Cursor (Cmd+Shift+P → `Developer: Reload Window`).

### 3.5. Client khác (Cline, Continue, Windsurf, Zed, OpenAI Agents SDK, …)

Mọi MCP client hỗ trợ **stdio transport** đều dùng chung pattern:

```
command: npx
args:    ["-y", "github:pancake-vn/ffm-mcp"]
env:
  SEA_FULFILLMENT_USERNAME   (bắt buộc)
  SEA_FULFILLMENT_PASSWORD   (bắt buộc)
  SEA_FULFILLMENT_HOST       (bắt buộc, vd https://fulfillment.pancake.vn)
```

Một vài client lồng config khác cấu trúc (Zed dùng `context_servers` +
`command.path`; Continue dùng `experimental.modelContextProtocolServers`) —
chỉ cần map `command` / `args` / `env` đúng vị trí.

Debug nhanh bằng MCP Inspector:

```bash
npx @modelcontextprotocol/inspector \
  -e SEA_FULFILLMENT_USERNAME=YOUR_USERNAME_OR_EMAIL \
  -e SEA_FULFILLMENT_PASSWORD=YOUR_PASSWORD \
  -e SEA_FULFILLMENT_HOST=https://fulfillment.pancake.vn \
  npx -y github:pancake-vn/ffm-mcp
```

### 3.6. (Nâng cao) Cài local từ source

Chỉ cần khi muốn chạy offline / chỉnh code:

```bash
git clone https://github.com/pancake-vn/ffm-mcp.git
cd ffm-mcp
npm install && npm run build
```

Rồi thay `"command": "npx", "args": ["-y", "github:pancake-vn/ffm-mcp"]`
bằng `"command": "node", "args": ["/absolute/path/to/ffm-mcp/dist/index.js"]`
trong mọi config ở trên.

---

## 4. Thử kết nối

Mở một cuộc trò chuyện mới và gõ thử:

> Liệt kê 5 đơn hàng gần nhất ở Philippines.

> Hôm nay có bao nhiêu đơn ở trạng thái shipped (PH)?

Lần đầu gọi tool, client sẽ hỏi "có cho phép gọi tool này không?" → chọn
**Allow**. Nếu danh sách đơn hoặc con số hiện ra là kết nối đã thành công —
từ đây bạn hỏi và ra lệnh bằng lời nói bình thường.

---

## 5. Project Instruction mẫu

Trong Claude, **Project** là nơi gom các cuộc trò chuyện cùng chủ đề và đặt
sẵn một bộ hướng dẫn chung. Đặt hướng dẫn tốt giúp AI trả lời sát cách vận
hành của bạn, không phải nhắc lại mỗi lần. Tạo Project mới, mở phần
**Instructions** và dán mẫu dưới đây (thay phần trong ngoặc vuông):

```markdown
# Hướng dẫn cho trợ lý vận hành fulfillment

## Bối cảnh
- Tenant / host: [vd fulfillment.pancake.vn]
- Quốc gia vận hành: [vd Philippines — country_code 63]. Mặc định dùng nước
  này khi tôi không nói rõ.
- Tiền tệ hiển thị: [vd PHP].

## Cách trả lời
- Luôn trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào việc.
- Khi liệt kê nhiều đơn, trình bày dạng bảng: mã đơn, khách, tracking,
  partner, COD, trạng thái.
- Ngày giờ theo dd/mm/yyyy.

## Nguyên tắc về dữ liệu
- Luôn dùng số liệu thật lấy từ FFM, không ước lượng hay phỏng đoán.
- Nếu không tìm thấy dữ liệu, nói rõ "không có dữ liệu" — không tự bịa.
- Khi lọc theo khoảng thời gian, hỏi lại tôi mốc since/until nếu chưa rõ.

## Khi báo cáo
- Nêu rõ khoảng thời gian và country_code của số liệu đang báo cáo.
- Số tiền đã được normalize sẵn (chia /100 nếu cần) — báo nguyên giá trị
  trả về, không tự nhân/chia thêm.
```

---

## 6. Thư viện prompt

Câu lệnh copy-paste sẵn cho các tình huống hay gặp. Thay phần trong ngoặc
vuông, AI sẽ tự dịch sang tham số tool tương ứng.

**Liệt kê đơn theo trạng thái:**

> Liệt kê đơn ở trạng thái [shipped] tại [Philippines] trong [7 ngày qua],
> sắp xếp mới nhất lên đầu, hiện mã đơn, khách, tracking, partner, COD.

**Xuất Excel:**

> Lấy toàn bộ đơn [đã giao] ở [PH] trong [tháng 4] và xuất ra bảng đầy đủ
> các trường để tôi copy sang Excel.

**Lọc theo COD:**

> Có bao nhiêu đơn COD trên [500000] chưa đối soát với courier ở [PH]?

**Đối soát:**

> Liệt kê đơn có customer_reconciliation_status = [reconciled] trong
> [30 ngày qua] ở [PH], tổng COD bao nhiêu?

**Tra cứu 1 đơn:**

> Cho tôi trạng thái và lịch sử xử lý của đơn [mã đơn / SĐT khách] ở [PH].

**Lọc theo shop / partner:**

> Đơn của shop [1234] giao qua partner [tên/ID] trong [tuần này] có bao
> nhiêu, tổng giá trị?

---

## 7. Tools (tham khảo)

### `get_orders`

Pass-through tới BE — trả raw response (`data`, `page`, `total_pages`, …).
Dùng khi cần dữ liệu thô / field BE chưa được normalize.

| field | type | note |
|---|---|---|
| `country_code` | **string** (bắt buộc) | Phone-code (`"63"`, `"66"`…). Xem §2.3. |
| `host` | string? | override env `SEA_FULFILLMENT_HOST`. |
| `filter` | object? | object chứa filter keys — xem §7.1. |
| `page` | number? | pagination (1-based). |
| `page_size` | number? | default FE 30 (table) / 500 (export). Max ~2000. |
| `load_full` | boolean? | true → BE trả full order schema. Cần cho normalize. |
| `is_summarize` | boolean? | true → BE chỉ trả `id` + counters. |
| `extra` | object? | merge vào body request (vd `sort_by`, `sort_direction`). |

#### 7.1. `filter` chi tiết

**Pagination + search:**

| Key | Type | Note |
|---|---|---|
| `page` | number | 1-based |
| `page_size` | number | default 30 ở FE table |
| `keyword` | string[] | full-text search (display_id, phone, name, …) |
| `order_ids` | number[] | filter list ID cụ thể (export flow) |

**Status / counter:**

| Key | Type | Note |
|---|---|---|
| `statuses` | string[] | `new`, `confirmed`, `printed`, `packing`, `pending`, `shipped`, `delivered`, `returning`, `returned`, `cancel`, … |
| `sub_status` | string | sub-status filter |
| `printed_count` | string/number | vd `0` để lọc đơn chưa in |
| `processing_count` | string/number | count đơn đang xử lý |

**Date range — dynamic key theo `time_key`:**

| Key | Type | Note |
|---|---|---|
| `time_key` | string | Field timestamp filter theo: `inserted_at`, `updated_at`, `assign_sale_at`, `picked_up_at`, `send_to_partner_at`, `delivered_at`, `first_assign_sale_at`. |
| `<time_key>:ranges` | `{ since, until }` | **ISO 8601 NaiveDateTime string** `"YYYY-MM-DDTHH:MM:SS"`. VD `"inserted_at:ranges": { "since": "2026-04-15T00:00:00", "until": "2026-05-15T23:59:59" }`. KHÔNG dùng unix epoch hay timezone offset — BE sẽ silently trả mảng rỗng. |
| `<time_key>:editor_ids` | number[] | optional — lọc thêm theo user thao tác trong khoảng. |

**Advance filter** — mỗi key chỉ accept đúng enum dưới đây, KHÔNG free-form:

| Key | Value | Label FE | Note |
|---|---|---|---|
| `shop_id` | `number` hoặc `"no_shop"` | POS Shop / No Shop | shop_id từ Pancake POS. |
| `partner_id` | `number` hoặc `"no_courier"` | Courier / No Courier | |
| `service_types` | `string` | Service Type | Từ `ffmSettings` type `customer_service_type`, hoặc `"No Service Type"`. |
| `tags` | `number[]` (tag ID) hoặc `"no_tag"` | Tag / No tag | include/exclude qua `is_exclude_tags`. |
| `product_id` / `variation_id` | `number` | Product / Variation | |
| `total_quantity` | `number` | Total Quantity | Number trực tiếp, không `{min,max}`. |
| `cod` | `"no_cod"` / `"has_cod"` / `"<op>_<amount>"` | COD | `<op>` ∈ `eq` / `gt_or_eq` / `lt_or_eq`. VD `"gt_or_eq_50000"`. |
| `is_duplicated_phone` | `true` / `false` | Duplicated Phone | boolean (KHÔNG phải string). |
| `is_duplicated_ip` | `true` / `false` | Duplicated IP | boolean. |
| `courier_reconciliation_status` | `"importing"` / `"courier_reconciling"` / `"courier_reconciled"` / `"courier_not_yet_reconciled"` | Courier Reconciliation Status | Value chứa `"not_yet"` → BE đảo thành must_not query. |
| `customer_reconciliation_status` | `"new"` / `"sent_email"` / `"reconciled"` / `"processing"` / `"completed"` / `"done"` / `"customer_not_yet_reconciled"` | Customer Reconciliation Status | Cùng logic `not_yet`. |
| `assigning_sale_id` / `assigning_care_id` | `number` hoặc `"no_user"` / `"has_user"` | Assigning Sale/Care | |
| `delivery_address_id` | `number` | Delivery Address | |
| `waybill_number` | `"no_waybill_number"` / `"matched_waybill_number"` | No / Matched Waybill Number | **Enum, KHÔNG phải tracking string.** |
| `combo_product` | `number` | Combo | |
| `order_source` | `"non_marketplace"` / `"-3"` / `"-4"` / `"-9"` | Non-Marketplace / Shopee / Lazada / TikTok | |
| `saved_filter_id` | `number` | Saved Filter | |
| `slot_warehouse_id` | `number` | Warehouse | |
| `pending_reason_id` | `number` hoặc `-1` | Pending Reason | `-1` = Other reason. |
| `cancel_reason_id` | `number` hoặc `-2` | Cancel Reason | `-2` = Other reason. |
| `shift` | `"morning"` / `"afternoon"` / `"evening"` | Shift | |
| `category_id` | `number` hoặc `"no_category"` | Category | |
| `business_countries_ids` | `string` (country_code) hoặc `"no_business_countries"` | Countries | |

**Exclude:** thêm flag `is_exclude_<key>: true` để BE đảo `must` → `must_not`:

```json
{ "filter": { "tags": [123], "is_exclude_tags": true } }
```

**Sort:** truyền qua `extra` (MCP tool chỉ nhận `filter` ở top-level):

```json
{ "filter": { "statuses": ["shipped"] }, "extra": { "sort_by": "inserted_at", "sort_direction": "desc" } }
```

### `get_orders_normalized`

Tự bật `load_full=true`, gọi BE, rồi chạy port của
`OrderExportExcel.formatData`. Trả mảng order phẳng — dùng khi user muốn
liệt kê / xuất bảng / Excel.

Output gồm các trường: `id`, `display_id`, `status` (text), `shop`,
`customer_name`, `phone_number`, `full_address`, `total_quantity`,
`weight`, `tracking_number`, `partner_name`, `cod`, `total_price`,
`send_to_partner_at`, `shipped_at`, `completed_at`,
`courier_reconciliation_status`, `customer_reconciliation_status`, `tags`,
`service_types`, … (tiền đã chia `/100` nếu currency không thuộc
`INT_CURRENCY_LIST`; datetime trả ISO string).

Input thêm so với `get_orders`:

| field | type | note |
|---|---|---|
| `paginate` | boolean? | true → loop tới hết hoặc đạt `max_pages`. |
| `max_pages` | number? | default 20. |

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

## 8. Troubleshooting

| Triệu chứng | Xử lý |
|---|---|
| `Missing credentials` | Chưa set `SEA_FULFILLMENT_USERNAME` / `SEA_FULFILLMENT_PASSWORD`. Xem §2. |
| `Missing host` | Chưa set `SEA_FULFILLMENT_HOST`. Xem §2.2. |
| `login failed: Wrong username or password` | Sai mật khẩu, hoặc login sai tenant (host không khớp). |
| `get_orders HTTP 401` | Token bị revoke giữa chừng (đổi password / force logout). Server đã auto-retry; nếu vẫn fail, kiểm tra password env. |
| `get_orders HTTP 403` | Token đúng nhưng `country_code` không thuộc nước user được phép. |
| Tool không xuất hiện | `claude mcp list` xem status. `npx` báo lỗi → xem gotcha PATH ở §3.2. |
| `command not found: npx` (Claude Desktop macOS) | App GUI không có PATH của shell — dùng đường dẫn tuyệt đối tới `npx` + set `PATH` trong `env`. Xem §3.2. |
| Server log `0_VN_orders_alias` | Truyền `country_code=VN/84` — sai. Phải là `63 / 66 / 60 / 62 / 65`. |
| `npx` lỗi cài (TAR_ENTRY_ERROR / module not found) | Cache npx hỏng. Xóa `~/.npm/_npx` rồi restart client để cài lại. |
| Lọc theo ngày trả về rỗng | `:ranges` phải là ISO datetime `"YYYY-MM-DDTHH:MM:SS"`, không phải unix epoch. Xem §7.1. |

---

## 9. Dev

```bash
npm install
npm run dev    # tsc watch
node dist/index.js

# Inspector UI:
npx @modelcontextprotocol/inspector node dist/index.js
```

Cấu trúc:
- `src/index.ts` — MCP server entry, tool routing.
- `src/api.ts` — HTTP client `callGetOrders` + `fetchAllOrders`.
- `src/normalize.ts` — port `OrderExportExcel.formatData`.
- `src/constants.ts` — `INT_CURRENCY_LIST`, `SUPPORTED_COUNTRIES`,
  `SUPPORTED_HOSTS`, `ORDER_STATUS_TEXT`, `RECONCILIATION_KEYS`.
