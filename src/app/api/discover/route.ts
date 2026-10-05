// POST /api/discover  売れ筋から探す。ブラウザで取得した楽天ランキングの商品から JAN・型番を取り出し、
// eBay の相場と比べて利益を計算する（お宝候補だけ売れ行きも調べる）。
// 本文（JSON）: { items: ランキングの商品（rank 付き）, settings: 計算条件, criteria: お宝の条件, internationalShippingJpy? }

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { parseClientRanked } from "@/lib/rakuten";
import { discoverFromRanking } from "@/lib/research";
import { MAX_DISCOVER_ITEMS, parseCriteria, parseSettings } from "@/lib/researchRequest";

// 最大 30 商品の eBay 検索と、お宝候補の売れ行きを調べるので、時間に余裕を持たせる
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const items = parseClientRanked(body?.items, MAX_DISCOVER_ITEMS);
  if (items.length === 0) return Response.json({ error: "ランキングの商品がありません。" }, { status: 400 });
  const shipping = Number(body?.internationalShippingJpy);

  try {
    return Response.json(
      await discoverFromRanking(items, {
        settings: parseSettings(body?.settings),
        criteria: parseCriteria(body?.criteria),
        internationalShippingJpy: Number.isFinite(shipping) && shipping >= 0 ? shipping : undefined,
      }),
    );
  } catch (err) {
    console.error("discover failed:", err);
    return Response.json({ error: "売れ筋の調査中にエラーが発生しました。" }, { status: 500 });
  }
}
