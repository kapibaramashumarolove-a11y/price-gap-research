// POST /api/jan  1 つの JAN を Amazon・楽天・Yahoo! でまとめて調べる。
// 本文（JSON）: { jan: "4902370548495", rakuten?: ブラウザで調べた楽天の結果,
//               amazonCache?: 前回の応答の amazonCache, cacheHours?: キャッシュを使ってよい時間（1〜24） }
// 応答: JanLookup（src/lib/malls.ts）。利益の計算は画面側（src/lib/arbitrage.ts）で行う。

import type { NextRequest } from "next/server";
import { parseClientAmazonCache } from "@/lib/amazonCache";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { normalizeJan } from "@/lib/jan";
import { lookupJan } from "@/lib/lookup";
import { defaultLookupDeps } from "@/lib/lookupServer";
import { parseClientRakuten } from "@/lib/rakuten";

// Amazon の価格 API は 2 秒に 1 回までなので、待ち時間を含めて余裕を持たせる
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // proxy.ts でも確認しているが、API の利用枠を守るためここでも確認する
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { jan?: unknown; rakuten?: unknown; amazonCache?: unknown; cacheHours?: unknown } | null;
  const jan = normalizeJan(body?.jan);
  if (!jan) {
    return Response.json(
      { error: jan === null ? "JAN コードが正しくありません（13 桁または 8 桁、チェックデジットを確認してください）。" : "JAN コードを入力してください。" },
      { status: 400 },
    );
  }

  try {
    // 楽天はブラウザで検索した結果が送られてくる（src/lib/rakuten.ts の説明を参照）。送られてこなければサーバーから呼ぶ
    // 一定時間内に調べた Amazon（Keepa）のデータがブラウザから送られてきたら、それを使って Keepa を呼ばない（トークン 0）
    const deps = defaultLookupDeps(request.nextUrl.origin);
    const cached = deps.amazon ? parseClientAmazonCache(body?.amazonCache, body?.cacheHours) : undefined;
    if (cached) deps.amazon = async () => cached;
    const result = await lookupJan(jan, parseClientRakuten(body?.rakuten), deps);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("jan lookup failed:", err);
    return Response.json({ error: "調査中にエラーが発生しました。サーバーのログを確認してください。" }, { status: 500 });
  }
}
