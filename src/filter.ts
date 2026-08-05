// Quy đổi date range trong filter từ GIỜ LOCAL của country → mốc UTC TUYỆT ĐỐI
// (chuỗi kết thúc bằng "Z") trước khi gọi BE.
//
// Vì sao PHẢI có hậu tố "Z": BE statistics tự gắn offset vào chuỗi naive theo
// params["timezone"] (SeaFulfillment Services.EsV2.Order.normalize_range_timezone/2,
// commit d3a66159). Nếu MCP đã convert local→UTC mà gửi chuỗi NAIVE kèm timezone
// "+08:00" thì BE shift LẦN 2 → cửa sổ lệch đúng bằng offset (PH/MY/SG +8 sai rõ).
// Chuỗi có sẵn "Z"/±HH:MM được BE giữ nguyên (put_offset/2) → gắn "Z" là cách an toàn,
// đúng bất kể BE có bước normalize đó hay không.
//
// Hợp đồng: caller (Claude) truyền since/until theo giờ LOCAL (timezone của user nếu
// biết, không thì giờ của country), không tz. Nếu chuỗi đã có Z hoặc ±HH:MM → coi là
// absolute, chỉ chuẩn hoá về UTC (không shift lần 2).

import { utcOffsetByCountry } from "./constants.js";

const RANGE_KEY = /:ranges$/;

// Resolve offset (giờ) để quy đổi local → UTC:
//   - timezone param (do Claude truyền theo locale user) ưu tiên — vd 7, "+07:00", "8".
//   - thiếu/không parse được → fallback offset của country.
export function resolveUtcOffset(
  timezone: number | string | undefined,
  countryCode: string,
): number {
  const parsed = parseOffset(timezone);
  return parsed ?? utcOffsetByCountry(countryCode);
}

function parseOffset(tz: number | string | undefined): number | undefined {
  if (tz == null) return undefined;
  if (typeof tz === "number") return Number.isFinite(tz) ? tz : undefined;
  const m = tz.trim().match(/^([+-]?)(\d{1,2})(?::?(\d{2}))?$/); // "7","+8","-5","+07:00"
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) + (m[3] ? parseInt(m[3], 10) / 60 : 0));
}

function hasExplicitTz(s: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function offsetSuffix(hours: number): string {
  const sign = hours >= 0 ? "+" : "-";
  const abs = Math.abs(hours);
  const h = Math.trunc(abs);
  const m = Math.round((abs - h) * 60);
  return `${sign}${pad2(h)}:${pad2(m)}`;
}

// Offset (giờ) → chuỗi "+HH:MM" cho ES date_histogram `time_zone` (statistics group_by date).
export function esOffsetString(offsetHours: number): string {
  return offsetSuffix(offsetHours);
}

// "YYYY-MM-DDTHH:MM:SS" (giờ local) hoặc absolute (có Z/offset) → UTC tuyệt đối
// "YYYY-MM-DDTHH:MM:SSZ". Giữ "Z" để BE KHÔNG gắn thêm offset (xem comment đầu file).
function toUtcAbsolute(value: string, offsetHours: number): string {
  const s = String(value).trim();
  const iso = hasExplicitTz(s) ? s : `${s}${offsetSuffix(offsetHours)}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value; // không parse được → giữ nguyên, để BE tự xử lý
  return `${d.toISOString().slice(0, 19)}Z`; // bỏ ms, giữ Z → UTC tuyệt đối
}

function convertBoundary(v: unknown, offsetHours: number): unknown {
  return typeof v === "string" ? toUtcAbsolute(v, offsetHours) : v;
}

// Convert mọi key `<time_key>:ranges` (và `ranges`) trong filter sang UTC.
// Hỗ trợ cả dạng object { since, until } và array [since, until].
// `offsetHours` = giờ local của since/until (lấy từ resolveUtcOffset).
export function localRangesToUtc(
  filter: Record<string, unknown> | undefined,
  offsetHours: number,
): Record<string, unknown> | undefined {
  if (!filter || typeof filter !== "object") return filter;
  const off = offsetHours;
  const out: Record<string, unknown> = { ...filter };
  for (const [key, val] of Object.entries(out)) {
    if (!(RANGE_KEY.test(key) || key === "ranges")) continue;
    if (Array.isArray(val)) {
      out[key] = val.map((x) => convertBoundary(x, off));
    } else if (val && typeof val === "object") {
      const r = val as Record<string, unknown>;
      out[key] = {
        ...r,
        ...("since" in r ? { since: convertBoundary(r.since, off) } : {}),
        ...("until" in r ? { until: convertBoundary(r.until, off) } : {}),
      };
    }
  }
  return out;
}
