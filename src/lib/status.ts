// 楽天・Yahoo! の API キーが「設定されているか」だけを返す（値は絶対に返さない）。画面の「接続状況」に使う。

import { isRakutenConfigured, isYahooConfigured } from "./domestic";

export type ConfigStatus = { rakuten: boolean; yahoo: boolean };

export function configStatus(env: Record<string, string | undefined> = process.env): ConfigStatus {
  return { rakuten: isRakutenConfigured(env), yahoo: isYahooConfigured(env) };
}
