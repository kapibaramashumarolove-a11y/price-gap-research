// 合言葉（環境変数 APP_PASSWORD）によるかんたんなログイン。サーバー側専用。
// 合言葉が合っていたら、合言葉から作った署名（HMAC）を HttpOnly の Cookie に入れる。
// 合言葉そのものは Cookie に入れないので、Cookie を見ても合言葉は分からない。
// 合言葉を変えると署名も変わるため、それまでのログインはすべて無効になる。

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "price-gap-auth";
/** ログインを保つ期間（30 日） */
export const AUTH_MAX_AGE_SEC = 60 * 60 * 24 * 30;

const TOKEN_MESSAGE = "price-gap-research:session:v1";

export type AuthMode =
  /** 合言葉が設定されていて、ログインが必要 */
  | "enabled"
  /** 合言葉が未設定の開発環境（npm run dev）。ログイン不要 */
  | "disabled"
  /** 合言葉が未設定の本番環境。安全のため誰も使えないようにする */
  | "misconfigured";

export function getAppPassword(env: Record<string, string | undefined> = process.env): string {
  return (env.APP_PASSWORD ?? "").trim();
}

export function getAuthMode(env: Record<string, string | undefined> = process.env): AuthMode {
  if (getAppPassword(env) !== "") return "enabled";
  return env.NODE_ENV === "production" ? "misconfigured" : "disabled";
}

/** 合言葉から Cookie に入れる値を作る */
export function sessionToken(password: string): string {
  return createHmac("sha256", password).update(TOKEN_MESSAGE).digest("hex");
}

/** 長さに関係なく、比較にかかる時間から中身を推測されないように比べる */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isCorrectPassword(input: string, password: string): boolean {
  return password !== "" && safeEqual(input, password);
}

/** Cookie の値が正しいログインかどうか。合言葉が未設定の開発環境では常に true */
export function isAuthenticated(
  cookieValue: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const mode = getAuthMode(env);
  if (mode === "disabled") return true;
  if (mode === "misconfigured" || !cookieValue) return false;
  return safeEqual(cookieValue, sessionToken(getAppPassword(env)));
}

/** ログイン後の移動先。外部サイトへ飛ばされないよう、このサイト内のパスだけ許可する */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

// ---- 合言葉の総当たり対策 ----
// 同じ接続元から一定回数まちがえると、しばらくログインできなくする。
// サーバーのメモリに持つだけなので、サーバーが入れ替わるとリセットされる（簡易的な対策）。

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; firstAt: number }>();

export function isLockedOut(clientKey: string, now: number = Date.now()): boolean {
  const entry = failures.get(clientKey);
  if (!entry) return false;
  if (now - entry.firstAt > LOCK_MS) {
    failures.delete(clientKey);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export function recordFailure(clientKey: string, now: number = Date.now()) {
  const entry = failures.get(clientKey);
  if (!entry || now - entry.firstAt > LOCK_MS) {
    failures.set(clientKey, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

export function clearFailures(clientKey: string) {
  failures.delete(clientKey);
}
