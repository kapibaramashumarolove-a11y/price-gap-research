// POST /api/jan-search  キーワードから JAN を探す（Yahoo!ショッピングの商品データの JAN を使う）。
// 本文（JSON）: { keyword: "ニンテンドースイッチ" }
// 応答: { items: JanCandidate[] }（型番一致 → 付属品でない → 出品の多い順。src/lib/janSearch.ts）

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { DomesticApiError, searchYahoo } from "@/lib/domestic";
import { findJansByKeyword } from "@/lib/janSearch";

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { keyword?: unknown } | null;
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim().slice(0, 100) : "";
  if (!keyword) return Response.json({ error: "キーワードを入力してください。" }, { status: 400 });

  try {
    return Response.json({ items: findJansByKeyword(await searchYahoo({ keyword }), keyword) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DomesticApiError) return Response.json({ error: err.message }, { status: 502 });
    console.error("jan search failed:", err);
    return Response.json({ error: "検索中にエラーが発生しました。" }, { status: 500 });
  }
}
