// Quy đổi date range trong filter từ GIỜ LOCAL của country → UTC trước khi gọi BE.
//
// Vì sao: BE parse `<time_key>:ranges` qua NaiveDateTime.from_iso8601! (bỏ hậu tố Z)
// rồi so trực tiếp với cột lưu UTC (vd o.inserted_at). Web gửi UTC (dayjs .toISOString()
// → "...Z") nên khớp. MCP phải làm y vậy, nếu không cửa sổ bị lệch theo offset (PH +8).
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

// "YYYY-MM-DDTHH:MM:SS" (giờ local) hoặc absolute (có Z/offset) → naive UTC "YYYY-MM-DDTHH:MM:SS".
function toUtcNaive(value: string, offsetHours: number): string {
  const s = String(value).trim();
  const iso = hasExplicitTz(s) ? s : `${s}${offsetSuffix(offsetHours)}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value; // không parse được → giữ nguyên, để BE tự xử lý
  return d.toISOString().slice(0, 19); // bỏ ms + Z → naive UTC
}

function convertBoundary(v: unknown, offsetHours: number): unknown {
  return typeof v === "string" ? toUtcNaive(v, offsetHours) : v;
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
