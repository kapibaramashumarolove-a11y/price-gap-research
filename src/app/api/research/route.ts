// POST /api/research  国内（楽天・Yahoo!）の商品を検索し、同じ商品ごとに eBay の相場を付けて返す。
// 本文（JSON）は ResearchRequest（src/lib/researchTypes.ts）。

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { runResearch } from "@/lib/research";
import { parseResearchRequest } from "@/lib/researchRequest";

// 楽天・Yahoo! と eBay（最大 30 商品）を順に呼ぶので、時間に余裕を持たせる
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // proxy.ts でも確認しているが、API の利用枠を守るためここでも確認する
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }

  const parsed = parseResearchRequest(await request.json().catch(() => null));
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });

  try {
    return Response.json(await runResearch(parsed));
  } catch (err) {
    console.error("research failed:", err);
    return Response.json({ error: "リサーチ中にエラーが発生しました。サーバーのログを確認してください。" }, { status: 500 });
  }
}
