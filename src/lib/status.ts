// 楽天・Yahoo! の API キーが「設定されているか」だけを返す（値は絶対に返さない）。画面の「接続状況」に使う。

import { isRakutenConfigured, isYahooConfigured } from "./domestic";
import { isPhotoAiConfigured } from "./photo";

export type ConfigStatus = { rakuten: boolean; yahoo: boolean; /** 写真から商品を読み取る AI（ANTHROPIC_API_KEY） */ photoAi: boolean };

export function configStatus(env: Record<string, string | undefined> = process.env): ConfigStatus {
  return { rakuten: isRakutenConfigured(env), yahoo: isYahooConfigured(env), photoAi: isPhotoAiConfigured(env) };
}
