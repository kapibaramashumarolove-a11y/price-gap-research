// GET /api/status  各モールの API キーが設定されているか（値は返さない）。画面の「接続状況」に使う。

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { configStatus } from "@/lib/status";

export async function GET(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  return Response.json(configStatus(), { headers: { "Cache-Control": "no-store" } });
}
