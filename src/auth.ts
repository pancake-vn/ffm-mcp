// Auto-login + token cache cho ffm-mcp.
//
// Flow:
//   1. Tool call → resolveAccessToken(host, username, password).
//   2. Có cache hợp lệ → return ngay.
//   3. Không cache (hoặc sắp expire < REFRESH_SKEW_SECONDS) → gọi
//      POST /api/users/login/password (router.ex:35), parse JWT lấy `exp`,
//      cache lại.
//   4. Trong api.ts: nếu BE trả 401 → invalidate cache + force re-login +
//      retry 1 lần.
//
// In-flight dedup: nếu nhiều call cùng key cùng lúc, chỉ chạy 1 login.

interface CachedToken {
  accessToken: string;
  expEpoch: number; // unix seconds
}

// Refresh khi còn ≤ 5 phút trước expiry để tránh edge race.
const REFRESH_SKEW_SECONDS = 300;

const cache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();

function cacheKey(host: string, username: string): string {
  return `${host.replace(/\/+$/, "")}::${username}`;
}

function decodeJwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    // base64url → base64. Buffer.from chấp nhận cả 2, miễn pad đúng.
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const obj = JSON.parse(json);
    return typeof obj.exp === "number" ? obj.exp : null;
  } catch {
    return null;
  }
}

async function performLogin(
  host: string,
  username: string,
  password: string,
): Promise<CachedToken> {
  const url = `${host.replace(/\/+$/, "")}/api/users/login/password`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `login HTTP ${res.status} (${url}): ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    success?: boolean;
    access_token?: string;
    message?: string;
  };
  if (!json?.success || !json.access_token) {
    throw new Error(
      `login failed: ${json?.message || JSON.stringify(json).slice(0, 300)}`,
    );
  }
  const exp =
    decodeJwtExp(json.access_token) ??
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // fallback 30d (Tools.exp_30_days)
  return { accessToken: json.access_token, expEpoch: exp };
}

export async function resolveAccessToken(
  host: string,
  username: string,
  password: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  const key = cacheKey(host, username);
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get(key);

  if (!opts.force && cached && cached.expEpoch - now > REFRESH_SKEW_SECONDS) {
    return cached.accessToken;
  }

  // Dedup các login đồng thời cùng key.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = performLogin(host, username, password).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }
  const fresh = await pending;
  cache.set(key, fresh);
  return fresh.accessToken;
}

export function invalidateToken(host: string, username: string): void {
  cache.delete(cacheKey(host, username));
}
