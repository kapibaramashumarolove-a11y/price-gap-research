// POST /api/logout  ログイン用の Cookie を消してログイン画面へ戻す。

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", request.url), 303);
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
