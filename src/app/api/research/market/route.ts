// POST /api/research/market  商品指定（kind: item）の eBay 相場だけを調べる。
// 画面は国内（楽天・Yahoo!）を検索する前にこれを呼び、相場から付属品を除くための最低価格を決める。
// 本文（JSON）は ResearchRequest（src/lib/researchTypes.ts）。

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { lookUpItemMarket } from "@/lib/research";
import { parseResearchRequest } from "@/lib/researchRequest";

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const parsed = parseResearchRequest(await request.json().catch(() => null));
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  if (parsed.kind !== "item") return Response.json({ error: "商品指定の検索条件だけに使えます。" }, { status: 400 });

  try {
    const market = await lookUpItemMarket(parsed);
    return typeof market === "string" ? Response.json({ error: market }, { status: 502 }) : Response.json({ market });
  } catch (err) {
    console.error("market lookup failed:", err);
    return Response.json({ error: "eBay の相場を調べる途中でエラーが発生しました。" }, { status: 500 });
  }
}
