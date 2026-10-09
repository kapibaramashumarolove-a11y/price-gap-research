// 写真（商品の箱・値札・ラベル・ネットショップの画面のスクショなど）から、検索に使う JAN・型番・商品名を読み取る（サーバー側専用）。
// バーコードはまずブラウザで読む（src/components/ArbitrageDashboard.tsx）。読めなかった写真だけを Claude に送る。
// キー（ANTHROPIC_API_KEY）を扱うので、ブラウザ側からは import しないこと。

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { cleanEnvValue } from "./env";
import { isValidJan, normalizeText } from "./jan";

export const PHOTO_MODEL = "claude-opus-5-5";
/** 送ってよい画像の大きさ（base64 の文字数）。ブラウザで縮めてから送るので、通常はずっと小さい */
export const MAX_IMAGE_BASE64 = 4_000_000;
export const PHOTO_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type PhotoMediaType = (typeof PHOTO_MEDIA_TYPES)[number];

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

export function isPhotoAiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return cleanEnvValue(env.ANTHROPIC_API_KEY) !== "";
}

const ProductSchema = z.object({
  jan: z.string().describe("写真にはっきり写っている JAN（EAN）コードの数字 13 桁または 8 桁。読めない・写っていなければ空文字"),
  model: z.string().describe("型番・品番（例: ZV-E10, HAC-001, DS-1）。分からなければ空文字"),
  name: z.string().describe("商品名（メーカー名・ブランド名を含む、ネットショップで検索しやすい短い名前）。分からなければ空文字"),
  brand: z.string().describe("メーカー名・ブランド名。分からなければ空文字"),
});

export type PhotoProduct = { jan?: string; model?: string; name?: string; brand?: string; query?: string };

const PROMPT = `この写真に写っている商品を、日本のネットショップ（楽天市場・Yahoo!ショッピング）で検索するための情報を読み取ってください。
- 写真は商品の箱・パッケージ・値札・ラベル、またはネットショップの商品ページのスクリーンショットです。
- JAN（バーコードの下の 13 桁または 8 桁の数字）が読める場合だけ jan に入れてください。推測で数字を作らないでください。
- 型番・品番は写真に書かれているとおりに入れてください。
- 商品名は、検索窓に入れてそのまま見つかるような短い名前にしてください（色・容量など商品を見分ける情報は残す）。
- 商品が写っていない、または読み取れない項目は空文字にしてください。`;

/** 写真から JAN・型番・商品名を読み取り、検索に使う言葉（query）も作る */
export async function readProductFromPhoto(
  imageBase64: string,
  mediaType: PhotoMediaType,
  client: Anthropic = new Anthropic({ apiKey: cleanEnvValue(process.env.ANTHROPIC_API_KEY) || undefined }),
): Promise<PhotoProduct> {
  let response;
  try {
    response = await client.beta.messages.parse({
      model: PHOTO_MODEL,
      max_tokens: 2000,
      // 文字を読み取るだけなので、考える量は少なくてよい（速く・安く）
      output_config: { effort: "low", format: betaZodOutputFormat(ProductSchema) },
      // 安全のための拒否が出たときは、同じリクエストを別のモデルでやり直す
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new PhotoError("写真の読み取り: ANTHROPIC_API_KEY が正しくありません。");
    if (err instanceof Anthropic.RateLimitError) throw new PhotoError("写真の読み取り: アクセスが多すぎます。少し待ってからもう一度試してください。");
    if (err instanceof Anthropic.BadRequestError) throw new PhotoError("写真の読み取り: この画像は読み取れませんでした（形式・大きさを確認してください）。");
    if (err instanceof Anthropic.APIError) throw new PhotoError(`写真の読み取り: 失敗しました（HTTP ${err.status}）。`);
    throw new PhotoError("写真の読み取り: 接続できませんでした。");
  }
  if (response.stop_reason === "refusal") throw new PhotoError("写真の読み取り: この画像は読み取れませんでした。");
  const parsed = response.parsed_output;
  if (!parsed) throw new PhotoError("写真の読み取り: 商品の情報を読み取れませんでした。");

  const clean = (v: string) => normalizeText(v).slice(0, 100) || undefined;
  const digits = parsed.jan.replace(/\D/g, "");
  const jan = isValidJan(digits) ? digits : undefined;
  const model = clean(parsed.model);
  const name = clean(parsed.name);
  const brand = clean(parsed.brand);
  // 検索には型番を優先（型番は付属品と見分けやすい）。型番がなければ商品名
  const query = jan ?? (model ? [brand, model].filter(Boolean).join(" ") : name);
  return { jan, model, name, brand, query };
}
