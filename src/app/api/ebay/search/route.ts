// GET /api/ebay/search?q=型番やキーワード
// 画面(ブラウザ)から呼ばれ、サーバー側で eBay Browse API を検索して集計結果を返す。
// eBay のキーはサーバーの中だけで使い、ブラウザには送らない。
import type { NextRequest } from "next/server";
import { EbayApiError, searchEbayPrices } from "@/lib/ebay";

const MAX_QUERY_LENGTH = 100;

export async function GET(request: NextRequest) {
  const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (query === "") {
    return Response.json({ error: "検索キーワード（型番など）を入力してください。" }, { status: 400 });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: `検索キーワードは ${MAX_QUERY_LENGTH} 文字以内にしてください。` },
      { status: 400 },
    );
  }

  try {
    return Response.json(await searchEbayPrices(query));
  } catch (e) {
    if (e instanceof EbayApiError) {
      return Response.json({ error: e.message }, { status: 502 });
    }
    console.error("Unexpected error in /api/ebay/search", e);
    return Response.json({ error: "予期しないエラーが発生しました。" }, { status: 500 });
  }
}
