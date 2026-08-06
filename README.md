# ffm-mcp

MCP server cho **sea-fulfillment** (Pancake FFM). Cắm vào trợ lý AI (Claude
Desktop, Claude Code, Cursor, …) để **thống kê dữ liệu đơn hàng** bằng lời
nói bình thường — không cần viết code.

Server tự đăng nhập bằng `username` + `password`, gọi API
`POST /api/orders/statistics` — đúng endpoint của trang **"Order Data
Statistics manual query (No AI)"** trên web. Trả về **số liệu tổng hợp**
(đếm đơn + tổng theo nhóm), KHÔNG trả full order doc: gom nhóm theo trạng
thái / shop / marketplace / ngày, tổng các field số (COD, phí đối soát, …).
Kết quả được **decorate** sẵn — nhãn người đọc (status text, tên shop,
marketplace) + tiền tệ scale đúng currency.

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

> **2 cách cắm:**
> - **(A) Remote connector** — nếu Pancake đã deploy `mcp-ffm.pancake.vn`: chỉ
>   dán 1 URL, đăng nhập qua trình duyệt, không cần Node trên máy. Mượt nhất cho
>   end-user. Xem [§10](#10-remote-server-http--oauth).
> - **(B) Local (stdio)** — chạy npx trên máy mình, đặt creds trong file config.
>   Hướng dẫn dưới đây. Hợp cho dev / khi chưa có remote server.

**Cách nhanh nhất (local) — chạy thẳng từ GitHub, không cần clone/build.** `npx`
tự tải repo và build lần đầu. Chỉ cần Node 18+ (xem §1).

> ⚠️ Repo này **private** → `npx github:pancake-vn/ffm-mcp` chỉ chạy được trên máy
> đã có quyền truy cập GitHub repo (SSH key hoặc `gh auth login`). End-user không có
> quyền repo nên dùng **(A) Remote connector** ([§10](#10-remote-server-http--oauth)) —
> không cần repo, chỉ cần URL + đăng nhập.

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
`mcp__ffm__order_statistics`.

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

> Đếm số đơn theo trạng thái ở Philippines.

> Tổng COD theo shop trong 30 ngày qua (PH), biểu đồ giúp tôi.

Lần đầu gọi tool, client sẽ hỏi "có cho phép gọi tool này không?" → chọn
**Allow**. Nếu bảng số liệu tổng hợp hiện ra là kết nối đã thành công —
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
- Khi báo cáo số liệu tổng hợp, trình bày dạng bảng: nhóm (label) + số đơn +
  các metric tổng; kèm dòng tổng (totals) nếu có.
- Ngày giờ theo dd/mm/yyyy.

## Nguyên tắc về dữ liệu
- Luôn dùng số liệu thật lấy từ FFM, không ước lượng hay phỏng đoán.
- Nếu không có bucket nào, nói rõ "không có dữ liệu" — không tự bịa.
- Khi lọc/gom theo khoảng thời gian, hỏi lại tôi mốc since/until nếu chưa rõ.

## Khi báo cáo
- Nêu rõ khoảng thời gian và country_code của số liệu đang báo cáo.
- Số tiền đã được scale sẵn theo currency (trường `currencies` trong kết quả)
  — báo nguyên giá trị trả về, không tự nhân/chia thêm.
```

---

## 6. Thư viện prompt

Câu lệnh copy-paste sẵn cho các tình huống hay gặp. Thay phần trong ngoặc
vuông, AI sẽ tự dịch sang tham số tool tương ứng.

**Đếm đơn theo trạng thái:**

> Đếm số đơn theo trạng thái ở [Philippines].

**Tổng COD theo shop:**

> Tổng COD theo shop trong [30 ngày qua] ở [PH], sắp theo COD giảm dần.

**Số đơn mỗi ngày (histogram):**

> Số đơn tạo mỗi ngày trong [7 ngày qua] ở [PH] (gom theo ngày, dùng
> inserted_at).

**Cross-tab (2 chiều):**

> Đếm đơn theo trạng thái × shop trong [tháng này] ở [PH].

**Đối soát:**

> Tổng phí đối soát courier (courier_total_fee) theo shop ở [PH] trong
> [30 ngày qua], kèm số đơn mỗi shop.

**Lọc rồi tổng hợp:**

> Trong các đơn COD trên [500000] chưa đối soát courier ở [PH], đếm theo
> trạng thái và tổng COD.

> Đơn của shop [1234] trong [tuần này] ở [PH] — tổng số đơn và tổng COD.

---

## 7. Tools (tham khảo)

MCP chỉ có **1 tool**: `order_statistics` (POST `/api/orders/statistics`) — thống
kê tổng hợp, KHÔNG list/xuất từng đơn.

### `order_statistics`

Gom nhóm + tổng hợp qua ES aggregation, trả count tổng + số liệu per-nhóm (KHÔNG
trả full order doc → nhẹ). `app_id`/`country_code` bị BE ép theo session (multi-tenant).

| field | type | note |
|---|---|---|
| `country_code` | **string** (bắt buộc) | Phone-code (`"63"`, `"66"`…). Xem §2.3. |
| `host` | string? | override env `SEA_FULFILLMENT_HOST`. |
| `filter` | object? | Lọc đơn TRƯỚC khi tổng hợp — cùng schema `apply_es_filter` của get_orders. Xem §7.1. |
| `group_by` | string \| string[]? | Chiều gom nhóm (tối đa 2): `status` \| `sub_status` \| `order_source` \| `shop_id` \| `date`. Rỗng → chỉ trả tổng. `date` PHẢI đứng một mình (histogram). VD `["status","shop_id"]`. |
| `metrics` | string[]? | Field số cần sum. Default `["cod"]`. Số đơn (count) luôn có sẵn. Xem §7.2. |
| `time_key` | string? | Khi `group_by` chứa `date`: mốc timestamp để chia bucket (default `updated_at`). Nhận: `inserted_at`, `confirmed_at`, `send_to_partner_at`, `picked_up_at`, `delivered_at`, `assign_sale_at`, `first_assign_sale_at`, `assign_care_at`, `expected_receipt_date`, `updated_at`. ⚠️ Khác với `filter.time_key` (xem §7.1) — đây là tham số của tool, không nằm trong `filter`. |
| `interval` | string? | Khi `group_by` chứa `date`: `day` \| `week` \| `month` (default `day`). |
| `timezone` | number \| string? | Offset giờ local của user (`7`, `8`, `"+07:00"`). Dùng để hiểu date-range filter là giờ local nào (quy sang mốc UTC tuyệt đối) **và** làm `time_zone` cho histogram. LUÔN truyền khi có date range / group_by `date`. Xem cảnh báo ở §7.1. |
| `size` | number? | Số bucket tối đa mỗi tầng terms (default 100, cap 1000). |

#### 7.1. `filter` chi tiết

> `filter` dùng chung schema với get_orders (`apply_es_filter`). Các key phân
> trang (`page`, `page_size`) KHÔNG áp dụng cho statistics — số bucket điều
> khiển bằng `size`, không phân trang.

**Search:**

| Key | Type | Note |
|---|---|---|
| `keyword` | string[] | Tìm theo display_id, phone, tracking_number, platform_order_id, ip, note, note_print. **Tra 1 mã vận đơn / SĐT thì dùng khoá này** (không có khoá `tracking_number` / `phone_number`). |
| `order_ids` | number[] | filter list order ID cụ thể |

**Status / counter:**

| Key | Type | Note |
|---|---|---|
| `status` | string[] | **Tên khoá là `status`, KHÔNG phải `statuses`.** `new`, `need_attention`, `waiting`, `need_confirm`, `sale_pending`, `confirmed`, `wait_print`, `printed`, `packing`, `pending`, `shipped`, `delivered`, `returning`, `returned`, `cancel`. |
| `sub_status` | string[] | sub-status (đóng gói / giao vận / khớp tồn) |
| `printed_count` | string[] | `"0"` chưa in; `"gt_or_eq_2"`, `"lt_or_eq_1"` |
| `processing_count` | string[] | cùng cú pháp `printed_count` |

**Pseudo-status (CHỈ có ở statistics)** — đặt **một mình** trong `status`, BE dịch sang
truy vấn đặc biệt (`pop_pseudo_status`):

| Giá trị | Ý nghĩa |
|---|---|
| `["confirmed_same_day"]` | Đơn tạo & confirm trong **cùng một ngày** (theo timezone user) |
| `["canceled_after_confirm"]` | Đơn đang `cancel` nhưng **đã từng** `confirmed` (huỷ sau chốt) |

**Khoảng thời gian — tên khoá là `<field>:ranges`:**

Chọn mốc thời gian bằng **tên khoá**, không phải bằng `time_key`. `<field>` ∈
`inserted_at`, `updated_at`, `confirmed_at`, `send_to_partner_at`, `picked_up_at`,
`delivered_at`, `assign_sale_at`, `first_assign_sale_at`, `assign_care_at`,
`expected_receipt_date`, `call_later_at`, `sla_due_at`, `order_status`.

| Key | Type | Note |
|---|---|---|
| `<field>:ranges` | `{ since, until }` | ISO `"YYYY-MM-DDTHH:MM:SS"` theo **giờ LOCAL** của user (nếu truyền param `timezone`, không thì giờ của `country_code` — vd `63` → PH UTC+8). MCP quy sang **mốc UTC tuyệt đối có hậu tố `Z`** trước khi gọi BE (xem cảnh báo dưới). VD `"inserted_at:ranges": { "since": "2026-04-15T00:00:00", "until": "2026-05-15T23:59:59" }`. KHÔNG dùng unix epoch — BE silently trả rỗng. Tự thêm `Z`/offset thì coi là absolute, MCP không shift nữa. |
| `<field>:editor_ids` | number[] | Lọc thêm theo user thao tác trong khoảng (`inserted_at`→creator_id, `updated_at`→last_editor_id, `send_to_partner_at`→send_to_partner_user_id, `order_status`→user trong status_histories). |
| `time_key` | string | **KHÔNG phải để chọn field range.** Chỉ có 2 tác dụng: `"send_to_partner_at"` → thêm điều kiện đơn đã gửi partner; `"order_status:<status>"` → lọc đơn từng qua status đó. Muốn lọc khoảng ngày thì dùng `<field>:ranges` ở trên. |

> ⚠️ **Vì sao MCP gắn `Z`** (fix 2026-08-05): BE statistics tự gắn offset vào chuỗi
> range **naive** theo `params["timezone"]` (`Services.EsV2.Order.normalize_range_timezone/2`,
> commit `d3a66159`). Nếu client đã quy đổi local→UTC mà vẫn gửi chuỗi naive kèm
> `timezone: "+08:00"` thì BE shift **lần thứ hai** → cửa sổ lệch đúng bằng offset
> (PH/MY/SG +8 sai rõ, TH +7 may mắn ít lộ). MCP gửi mốc tuyệt đối có `Z` (BE giữ
> nguyên) và **chỉ** gửi `timezone` xuống BE khi `group_by` chứa `date` — lúc đó nó
> dùng cho `time_zone` của date_histogram.
>
> `timezone` là param **top-level của tool** (ngoài `filter`): `7`, `8`, `"+07:00"`.
> Nên LUÔN truyền khi filter có `*:ranges`. Thiếu → fallback timezone của
> `country_code` (có thể lệch ranh giới ngày).

**Advance filter — nhóm PHẢI LÀ MẢNG** (BE dựng `terms` / so `term == ["x"]`; gửi
scalar ⇒ 0 đơn im lặng, MCP tự wrap giúp):

| Key | Value | Note |
|---|---|---|
| `shop_id` | `number[]` | `[13]` — KHÔNG phải `13`. |
| `partner_id` | `number[]` hoặc `["no_courier"]` | Courier. |
| `service_types` | `string[]` hoặc `["No Service Type"]` | Từ `ffmSettings` type `customer_service_type`. |
| `include_tags` / `exclude_tags` | `string[]` = **TÊN tag**, kèm `"no_tag"` | ⚠️ **KHÔNG có khoá `tags`.** BE query `tags.name` nên phải gửi **tên**, không phải tag ID. `include_tags` gộp AND/OR qua `condition_include_tags` (`"and"`/`"or"`, mặc định `or`). |
| `product_id` / `variation_id` | `number[]` | AND/OR qua `condition_product_id` / `condition_variation_id`. |
| `combo_product` | `number[]` | Combo. |
| `assigning_sale_id` / `assigning_care_id` | `number[]` hoặc `["no_user"]` / `["has_user"]` | Sale/Care phụ trách. |
| `order_source` | `["non_marketplace"]` / `["-3"]` / `["-4"]` / `["-9"]` | Non-Marketplace / Shopee / Lazada / TikTok. Trộn được, vd `["non_marketplace","-3"]`. |
| `total_quantity` | `number[]` | Số lượng chính xác, không `{min,max}`. |
| `slot_warehouse_id` | `number[]` | Warehouse. |
| `pending_reason_id` | `number[]` (hoặc `[-1]`) | `-1` = Other reason. |
| `cancel_reason_id` | `number[]` (hoặc `[-2]`) | `-2` = Other reason. |
| `marketplace_id` | `string[]` | Lọc thẳng theo sàn (tương đương `order_source` nhưng không có nhánh `non_marketplace`). |
| `province_id` / `district_id` / `commune_id` | `number[]` | Địa chỉ giao (nested `shipping_info`). |
| `display_id`, `platform_order_id`, `printed_count`, `processing_count`, `creator_id`, `last_editor_id`, `send_to_partner_user_id`, `call_later_status`, `ssc_id` | mảng | Map thẳng sang field cùng tên trong ES. |

**Advance filter — nhóm SCALAR:**

| Key | Value | Note |
|---|---|---|
| `cod` | `"no_cod"` / `"has_cod"` / `"<op>_<amount>"` | `<op>` ∈ `eq` / `gt_or_eq` / `lt_or_eq`. VD `"gt_or_eq_50000"`. |
| `waybill_number` | `"no_waybill_number"` / `"matched_waybill_number"` | **Enum, KHÔNG phải mã vận đơn** — tra mã cụ thể thì dùng `keyword`. |
| `courier_reconciliation_status` | `"importing"` / `"courier_reconciling"` / `"courier_reconciled"` / `"courier_not_yet_reconciled"` | Value chứa `"not_yet"` → BE đảo thành must_not. |
| `customer_reconciliation_status` | `"new"` / `"sent_email"` / `"reconciled"` / `"processing"` / `"completed"` / `"done"` / `"customer_not_yet_reconciled"` | Cùng logic `not_yet`. |
| `is_duplicated_phone` / `is_duplicated_ip` | `true` / `false` | boolean (KHÔNG phải string). |
| `need_attention_tags` | `string` (1 tên tag) | |
| `sub_sale_pending_reason` | `number` | Map sang `pending_reason_id`. |
| `no_address` / `no_detail_address` / `no_commune` | toggle | Đơn thiếu Tỉnh/Thành, địa chỉ chi tiết, Phường/Xã. |

> ❌ **Các khoá KHÔNG tồn tại** trong ES order index — dùng sẽ ra **0 đơn im lặng**,
> MCP chặn sẵn: `tags` (→ `include_tags`/`exclude_tags`), `category_id`, `shift`,
> `saved_filter_id`, `business_countries_ids`, `delivery_address_id`,
> `tracking_number`/`phone_number` (→ `keyword`).

**Exclude:** thêm flag `is_exclude_<key>: true` để BE đảo `must` → `must_not`:

```json
{ "filter": { "partner_id": [7], "is_exclude_partner_id": true } }
```

Riêng tag thì exclude bằng khoá riêng, không phải cờ:

```json
{ "filter": { "exclude_tags": ["Hàng dễ vỡ"] } }
```

> **Sort không áp dụng** cho statistics — kết quả là bucket tổng hợp, không phải danh
> sách đơn. Muốn giới hạn số bucket thì dùng `size`.

#### 7.1.1. ⚠️ Sai tên khoá / sai kiểu → **0 đơn, KHÔNG báo lỗi**

`apply_es_filter` phía BE có clause catch-all: khoá lạ vẫn được dựng thành
`terms: %{<khoá lạ> => …}` trên field không tồn tại trong mapping ES → match 0 doc
và trả về bình thường. Đây là loại lỗi nguy hiểm nhất vì **ra SỐ SAI chứ không ra lỗi**
— người đọc tưởng "kỳ đó không có đơn".

| Viết sai | Kết quả | Viết đúng |
|---|---|---|
| `filter.statuses: ["delivered"]` | **0 đơn**, im lặng | `filter.status: ["delivered"]` |
| `filter.shop_id: 13` (số lẻ) | **0 đơn**, im lặng | `filter.shop_id: [13]` |
| `filter.tags: [123]` | **0 đơn**, im lặng | `filter.include_tags: ["tên tag"]` |
| `filter.tracking_number: "SPX…"` | **0 đơn**, im lặng | `filter.keyword: ["SPX…"]` |

**MCP chặn sẵn giúp bạn** — khoá lạ trả lỗi kèm cách sửa, vd:

```
Khoá filter không hợp lệ: `tags` → dùng `include_tags` / `exclude_tags`,
giá trị là TÊN tag (BE query `tags.name`), KHÔNG phải tag ID
```

Khoá dạng danh sách nhận scalar thì MCP tự wrap thành mảng (`shop_id: 13` →
`[13]`) nên không còn ra 0 đơn oan. Danh sách khoá đầy đủ theo nhóm xem 2 bảng
Advance filter ở trên.

> Việc BE tự validate và báo lỗi khi gặp khoá lạ là thay đổi phía `sea-fulfillment`
> (dùng chung `apply_es_filter` với `get_orders` → blast radius toàn hệ thống), chưa
> nằm trong phạm vi repo này.

#### 7.2. `metrics` chi tiết

Whitelist field số được phép sum (subset của `@statistic_metric_fields` BE).
Số đơn (`count`) luôn có sẵn, không cần khai. Tiền được scale sẵn theo currency.

| Nhóm | Keys |
|---|---|
| Basic | `total_quantity` (không phải tiền → giữ nguyên) |
| Billing | `cod`, `transfer_money`, `shipping_fee`, `discount`, `surcharge`, `extra_price` |
| Courier reconciliation | `courier_<k>` với `<k>` ∈ `shipping_fee`, `shipping_fee_tax`, `cod_fee`, `cod_fee_tax`, `insurance_fee`, `return_fee`, `return_fee_tax`, `ffm_fee`, `total_fee` |
| Customer reconciliation | `customer_<k>` (cùng list `<k>` như trên) |

> Billing metric dùng currency của country; reconciliation metric dùng
> reconciliation currency (PH → `PHP100`, chia `/100`). Field `currencies`
> trong kết quả cho biết currency đang áp cho từng nhóm.

#### 7.3. Output

```json
{
  "country_code": "63",
  "group_by": ["status"],
  "metrics": ["cod"],
  "currencies": { "billing": "PHP", "reconciliation": "PHP100" },
  "total_entries": 1234,
  "totals": { "cod": 5678900 },
  "buckets": [
    { "labels": ["Delivered"], "keys": ["delivered"], "count": 800, "values": { "cod": 4000000 } },
    { "labels": ["Canceled"],  "keys": ["cancel"],    "count": 120, "values": { "cod": 0 } }
  ]
}
```

- `labels` — nhãn người đọc mỗi chiều (status text, tên shop, marketplace,
  ngày `YYYY-MM-DD`); `keys` — raw key tương ứng (dùng khi cần id gốc).
- **Đơn thiếu giá trị vẫn có bucket riêng**, nên tổng `count` các bucket luôn
  khớp `total_entries`: `order_source` → `non_marketplace` / "Non-marketplace"
  (đơn Facebook, tự tạo — thường là nhóm lớn nhất), `sub_status` →
  `no_sub_status`, `shop_id` → `-1` / "No shop". Bucket `non_marketplace` khớp
  đúng vocabulary của filter `order_source: ["non_marketplace"]`.
- `values` / `totals` — tiền đã scale theo currency (không chia thêm).
- Khi `group_by` chứa `date`, output kèm `time_key` + `interval` đã dùng.

---

## 8. Troubleshooting

| Triệu chứng | Xử lý |
|---|---|
| `Missing credentials` | Chưa set `SEA_FULFILLMENT_USERNAME` / `SEA_FULFILLMENT_PASSWORD`. Xem §2. |
| `Missing host` | Chưa set `SEA_FULFILLMENT_HOST`. Xem §2.2. |
| `login failed: Wrong username or password` | Sai mật khẩu, hoặc login sai tenant (host không khớp). |
| `statistics HTTP 401` | Token bị revoke giữa chừng (đổi password / force logout). Server đã auto-retry; nếu vẫn fail, kiểm tra password env. |
| `statistics HTTP 403` | Token đúng nhưng `country_code` không thuộc nước user được phép. |
| Tool không xuất hiện | `claude mcp list` xem status. `npx` báo lỗi → xem gotcha PATH ở §3.2. |
| `command not found: npx` (Claude Desktop macOS) | App GUI không có PATH của shell — dùng đường dẫn tuyệt đối tới `npx` + set `PATH` trong `env`. Xem §3.2. |
| Server log `0_VN_orders_alias` | Truyền `country_code=VN/84` — sai. Phải là `63 / 66 / 60 / 62 / 65`. |
| `npx` lỗi cài (TAR_ENTRY_ERROR / module not found) | Cache npx hỏng. Xóa `~/.npm/_npx` rồi restart client để cài lại. |
| Lọc theo ngày trả về rỗng | `:ranges` phải là ISO datetime `"YYYY-MM-DDTHH:MM:SS"`, không phải unix epoch. Xem §7.1. |

---

## 9. Dev

```bash
npm install
npm run dev          # tsc watch
node dist/index.js   # stdio
node dist/http.js    # remote (cần PUBLIC_URL + OAUTH_SIGNING_SECRET)

# Inspector UI (stdio):
npx @modelcontextprotocol/inspector node dist/index.js
```

Cấu trúc:
- `src/index.ts` — stdio entry (auth = username/password env).
- `src/http.ts` — remote entry: Express + OAuth (`mcpAuthRouter`) + Streamable HTTP.
- `src/oauth-provider.ts` — `OAuthServerProvider` bọc login FFM + trang Authorize.
- `src/token.ts` — session JWT tự ký (HMAC) nhúng JWT FFM + host.
- `src/tools.ts` — tool def `order_statistics` + `buildServer` + `handleToolCall` (dùng chung 2 entry).
- `src/api.ts` — HTTP client (`callStatistics`/`fetchShops`, auth password|token).
- `src/statistics.ts` — decorate response statistics (nhãn người đọc + scale tiền tệ).
- `src/filter.ts` — quy đổi date-range filter local→UTC tuyệt đối (`Z`) + `esOffsetString` cho histogram.
- `src/filter-schema.ts` — whitelist khoá filter: chặn khoá sai tên, wrap scalar→mảng (xem §7.1.1).
- `src/constants.ts` — `SUPPORTED_COUNTRIES`, `SUPPORTED_HOSTS`, `METRIC_DEFS`, currency map…

---

## 10. Remote server (HTTP + OAuth)

Cho phép cắm kiểu **"Add custom connector → dán URL → Authorize"** như Pancake POS:
không cần Node trên máy user, đăng nhập 1 lần qua trình duyệt. Server là tầng trung
gian gọi BE FFM (login + statistics), **không sửa gì ở BE**.

### 10.1. Kết nối (end-user)

Claude Desktop → **Settings → Connectors → Add custom connector** → dán
`https://mcp-ffm.pancake.vn/mcp` → trình duyệt mở trang Authorize → **chọn tenant**
(fulfillment.pancake.vn, g-solution.vn, bigate.co…) + nhập username/password FFM →
xong. Hỏi thử: *"liệt kê 5 đơn gần nhất ở Philippines"*.

Token phát ra sống ~30 ngày (khớp hạn JWT FFM); hết hạn thì Authorize lại.

### 10.2. Self-host / deploy

```bash
docker build -t ffm-mcp .
docker run -p 8080:8080 \
  -e PUBLIC_URL=https://mcp-ffm.pancake.vn \
  -e OAUTH_SIGNING_SECRET=<random-secret-dài> \
  ffm-mcp
```

Đặt sau reverse proxy có HTTPS (domain ở `PUBLIC_URL`). Env:

| Env | Bắt buộc | Ý nghĩa |
|---|---|---|
| `PUBLIC_URL` | ✅ | Issuer URL công khai (cho OAuth metadata + redirect), vd `https://mcp-ffm.pancake.vn`. |
| `OAUTH_SIGNING_SECRET` | ✅ | Secret HMAC ký session token. Đổi secret = vô hiệu mọi session cũ. |
| `PORT` | — | Default 8080. |

> Host **không** đặt qua env — user chọn tenant trên trang Authorize, host được nhúng
> vào token. Không lưu username/password server-side; chỉ giữ JWT FFM trong token đã ký.

**Deploy bằng pm2 (Node, không Docker)** — cấu hình host/repo/path trong
`ecosystem.config.cjs` (block `deploy.production`), nginx
(`deploy/nginx/mcp-ffm.pancake.vn.conf`) proxy về VM:8080.

Lần đầu (1 lần) — sửa `user`/`host`/`path` trong `ecosystem.config.cjs` cho khớp VM, rồi:

```bash
npm run setup    # pm2 SSH vào VM, clone repo vào <path>/source
# tạo env file trên VM (chứa secret, ngoài git). LƯU Ý: phải chown về user
# chạy pm2 (vd cc) — file root:root 600 thì node --env-file đọc "not found".
ssh <user>@<host> 'SECRET=$(openssl rand -hex 32); \
  printf "PUBLIC_URL=https://mcp-ffm.pancake.vn\nOAUTH_SIGNING_SECRET=%s\nPORT=8080\n" "$SECRET" \
    | sudo tee /etc/ffm-mcp.env >/dev/null && \
  sudo chown <user>:<user> /etc/ffm-mcp.env && sudo chmod 600 /etc/ffm-mcp.env'
```

> `ssh_options: "ForwardAgent=yes"` trong `ecosystem.config.cjs` forward ssh-agent của
> máy dev để VM clone private repo — máy dev phải `ssh-add` key có quyền repo trước.

Mỗi lần update từ local, chỉ 1 lệnh (push trước):

```bash
git push && npm run deploy
# đọc host/repo/path từ ecosystem.config.cjs → SSH vào VM →
# git reset <path>/source về commit mới nhất + npm ci + build + pm2 startOrReload
```

### 10.3. Endpoints

- `POST /mcp` — MCP Streamable HTTP (Bearer-protected).
- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` — metadata.
- `/authorize`, `/token`, `/register` — OAuth (SDK lo); `/login/submit` — nhận form đăng nhập.
- `GET /healthz` — health check.

> v1: client OAuth (DCR) + authorization code lưu in-memory → restart làm Claude
> re-register (tự động). Session token là JWT stateless nên **không** mất khi restart.
> Chưa hỗ trợ refresh token (hết hạn → Authorize lại).
