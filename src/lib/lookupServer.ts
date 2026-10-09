// /api/jan で使う、本物の API につないだ LookupDeps（サーバー側専用）。

import { isRakutenConfigured, isYahooConfigured, searchRakuten, searchYahoo } from "./domestic";
import type { LookupDeps } from "./lookup";

export function defaultLookupDeps(siteOrigin: string | undefined, env: Record<string, string | undefined> = process.env): LookupDeps {
  return {
    yahoo: isYahooConfigured(env) ? (jan) => searchYahoo({ jan }, env) : undefined,
    rakuten: isRakutenConfigured(env) ? (jan) => searchRakuten({ keyword: jan, siteOrigin }, env) : undefined,
  };
}
