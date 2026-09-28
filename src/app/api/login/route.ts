// POST /api/login  合言葉が合っていればログイン用の Cookie を付けてトップへ戻す。
// ログイン画面（/login）のフォームから送られる。JavaScript なしでも動くよう、結果はリダイレクトで返す。

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE_SEC,
  clearFailures,
  getAppPassword,
  isCorrectPassword,
  isLockedOut,
  recordFailure,
  safeNextPath,
  sessionToken,
} from "@/lib/auth";

/** まちがえたときに少し待たせて、総当たりを遅くする */
const FAILURE_DELAY_MS = 1000;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const input = String(form.get("password") ?? "");
  const next = safeNextPath(String(form.get("next") ?? ""));
  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  const loginUrl = (error: string) => {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", error);
    if (next !== "/") url.searchParams.set("next", next);
    return url;
  };

  if (isLockedOut(clientKey)) {
    return NextResponse.redirect(loginUrl("locked"), 303);
  }

  const password = getAppPassword();
  if (!isCorrectPassword(input, password)) {
    recordFailure(clientKey);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return NextResponse.redirect(loginUrl(isLockedOut(clientKey) ? "locked" : "wrong"), 303);
  }

  clearFailures(clientKey);
  const res = NextResponse.redirect(new URL(next, request.url), 303);
  res.cookies.set(AUTH_COOKIE, sessionToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE_SEC,
  });
  return res;
}
