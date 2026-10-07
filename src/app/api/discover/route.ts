// POST /api/discover  全自動バルクリサーチの起点になる商品（JAN）を集める。
// 本文（JSON）: { source: "keepa" | "yahoo", category: "all" | "electronics" | …, limit: 20 | 50 | 100 }
// 応答: { items: { jan, title, imageUrl?, priceJpy?, note }[], warnings: string[], tokensLeft? }
// 楽天（高ポイント）は「許可されたWebサイト」の確認のため、ブラウザから直接呼ぶ（src/lib/rakuten.ts）。

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { categoryPattern, DISCOVERY_CATEGORIES, DISCOVERY_LIMITS, type DiscoveryCategory } from "@/lib/discovery";
import { discoverYahooRanking, DomesticApiError } from "@/lib/domestic";
import { discoverKeepa, KeepaApiError, readKeepaKey } from "@/lib/keepa";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { source?: unknown; category?: unknown; limit?: unknown } | null;
  const category = DISCOVERY_CATEGORIES.some((c) => c.id === body?.category) ? (body!.category as DiscoveryCategory) : "all";
  const limit = DISCOVERY_LIMITS.includes(Number(body?.limit) as (typeof DISCOVERY_LIMITS)[number]) ? Number(body?.limit) : 20;
  const headers = { "Cache-Control": "no-store" };

  try {
    if (body?.source === "keepa") {
      const key = readKeepaKey();
      if (!key) return Response.json({ error: "Amazon（Keepa）: 環境変数 KEEPA_API_KEY が設定されていません。" }, { status: 400 });
      return Response.json(await discoverKeepa(categoryPattern(category, "amazon"), limit, key), { headers });
    }
    if (body?.source === "yahoo") {
      return Response.json(await discoverYahooRanking(categoryPattern(category, "yahoo"), limit), { headers });
    }
    return Response.json({ error: "source には keepa か yahoo を指定してください。" }, { status: 400 });
  } catch (err) {
    if (err instanceof KeepaApiError || err instanceof DomesticApiError) return Response.json({ error: err.message }, { status: 502 });
    console.error("discover failed:", err);
    return Response.json({ error: "商品の抽出中にエラーが発生しました。" }, { status: 500 });
  }
}
