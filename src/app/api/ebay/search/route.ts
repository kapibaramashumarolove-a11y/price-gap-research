// GET /api/ebay/search?q=キーワード
// サーバー側で eBay Browse API を呼び、出品中の価格（中央値・最安値・件数）を返す。
// eBay のキーはサーバーの中だけで使い、ブラウザには返さない。

import type { NextRequest } from "next/server";
import { EbayApiError, searchActiveListingPrices } from "@/lib/ebay";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (q.trim() === "") {
    return Response.json({ error: "検索キーワード (q) を指定してください。" }, { status: 400 });
  }
  if (q.length > 200) {
    return Response.json({ error: "検索キーワードが長すぎます（200 文字まで）。" }, { status: 400 });
  }

  try {
    return Response.json(await searchActiveListingPrices(q));
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
