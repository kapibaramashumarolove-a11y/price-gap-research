// GET /api/ebay/search?q=キーワード[&condition=1000,3000]
// condition はコンディション ID のカンマ区切り（省略時は新品のみ、"all" で絞り込みなし）。
// サーバー側で eBay Browse API を呼び、出品中の価格（中央値・最安値・件数）を返す。
// eBay のキーはサーバーの中だけで使い、ブラウザには返さない。

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { EbayApiError, searchActiveListingPrices } from "@/lib/ebay";
import { parseConditionIds } from "@/lib/ebayConditions";

export async function GET(request: NextRequest) {
  // proxy.ts でも確認しているが、eBay の利用枠を守るためここでも確認する
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (q.trim() === "") {
    return Response.json({ error: "検索キーワード (q) を指定してください。" }, { status: 400 });
  }
  if (q.length > 200) {
    return Response.json({ error: "検索キーワードが長すぎます（200 文字まで）。" }, { status: 400 });
  }

  const conditionIds = parseConditionIds(request.nextUrl.searchParams.get("condition"));
  if (conditionIds === null) {
    return Response.json({ error: "condition に未対応のコンディション ID が含まれています。" }, { status: 400 });
  }

  try {
    return Response.json(await searchActiveListingPrices(q, { conditionIds }));
  } catch (err) {
    if (err instanceof EbayApiError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("eBay search failed:", err);
    return Response.json(
      { error: "eBay への接続中にエラーが発生しました。サーバーのログを確認してください。" },
      { status: 502 },
    );
  }
}
