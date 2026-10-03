// GET /api/rakuten/credentials  ブラウザから楽天を直接呼ぶためのキーを、ログイン済みの人にだけ返す。
// 楽天の「Webアプリケーション」のキーは「許可されたWebサイト」からしか使えないので、
// ブラウザに渡すのは楽天が想定している使い方。ただし誰でも見られないよう、合言葉のログインを必須にする。

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { readRakutenCredentials } from "@/lib/domestic";

export async function GET(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const creds = readRakutenCredentials();
  const headers = { "Cache-Control": "no-store" };
  return typeof creds === "string"
    ? Response.json({ configured: false, error: creds }, { headers })
    : Response.json({ configured: true, ...creds }, { headers });
}
