// すべてのページと API の前に動き、合言葉でログインしていない人を止める。
// 念のため、eBay を呼ぶ API（/api/ebay/search）の中でも同じ確認をしている。

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, getAuthMode, isAuthenticated } from "@/lib/auth";
import { canonicalRedirectUrl } from "@/lib/canonicalHost";

/** ログインしていなくても開けるパス */
const PUBLIC_PATHS = new Set(["/login", "/api/login"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // デプロイごとに変わる URL で開かれたら、変わらない本番 URL へ移す（楽天の「許可されたWebサイト」と揃えるため）
  const requestHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const canonical = canonicalRedirectUrl(requestHost, request.nextUrl, request.method);
  if (canonical) return NextResponse.redirect(canonical, 308);

  if (getAuthMode() === "misconfigured") {
    const message = "環境変数 APP_PASSWORD が設定されていないため、このサイトは使えません。";
    return isApi
      ? Response.json({ error: message }, { status: 503 })
      : new Response(message, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();

  if (isApi) {
    return Response.json({ error: "ログインが必要です。ページを開き直して合言葉を入力してください。" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname + search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // 画面の表示に必要な静的ファイル（CSS・JS・フォント・アイコン）は除く
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
