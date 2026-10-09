// POST /api/photo  写真から JAN・型番・商品名を読み取る（バーコードが読めなかった写真用。ANTHROPIC_API_KEY が必要）。
// 本文（JSON）: { image: "data:image/jpeg;base64,...." }（ブラウザで縮めてから送る）
// 応答: { jan?, model?, name?, brand?, query? }

import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";
import { isPhotoAiConfigured, MAX_IMAGE_BASE64, PHOTO_MEDIA_TYPES, PhotoError, readProductFromPhoto, type PhotoMediaType } from "@/lib/photo";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value)) {
    return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  if (!isPhotoAiConfigured()) {
    return Response.json({ error: "写真の読み取り（AI）を使うには、Vercel の環境変数に ANTHROPIC_API_KEY を登録してください。" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as { image?: unknown } | null;
  const match = typeof body?.image === "string" ? body.image.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (!match || !PHOTO_MEDIA_TYPES.includes(match[1] as PhotoMediaType)) {
    return Response.json({ error: "画像（JPEG・PNG・WebP・GIF）を送ってください。" }, { status: 400 });
  }
  if (match[2].length > MAX_IMAGE_BASE64) return Response.json({ error: "画像が大きすぎます。" }, { status: 413 });

  try {
    return Response.json(await readProductFromPhoto(match[2], match[1] as PhotoMediaType), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof PhotoError) return Response.json({ error: err.message }, { status: 502 });
    console.error("photo read failed:", err);
    return Response.json({ error: "写真の読み取り中にエラーが発生しました。" }, { status: 500 });
  }
}
