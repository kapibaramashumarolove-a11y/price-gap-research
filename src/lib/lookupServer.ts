// /api/jan で使う、本物の API につないだ LookupDeps（サーバー側専用）。

import { lookupAmazon, readAmazonCredentials, type AmazonLookup } from "./amazon";
import { isRakutenConfigured, isYahooConfigured, searchRakuten, searchYahoo } from "./domestic";
import { lookupKeepa, readKeepaKey } from "./keepa";
import type { LookupDeps } from "./lookup";

/**
 * Amazon の調べ方。SP-API（出品ごとの価格・ポイント・正確な手数料）があればそれを使い、
 * Keepa もあれば販売回数（ランキング上昇回数）などを足す。SP-API がなければ Keepa だけで調べる。
 */
export function amazonSource(env: Record<string, string | undefined> = process.env): ((jan: string) => Promise<AmazonLookup>) | undefined {
  const spApi = readAmazonCredentials(env);
  const keepaKey = readKeepaKey(env);
  if (spApi && keepaKey) {
    return async (jan) => {
      const [sp, keepa] = await Promise.all([lookupAmazon(jan, spApi), lookupKeepa(jan, keepaKey).catch(() => undefined)]);
      const k = keepa?.product;
      if (sp.product && k && k.asin === sp.product.asin) {
        sp.product = { ...sp.product, salesRankDrops30: k.salesRankDrops30, salesRankDrops90: k.salesRankDrops90, monthlySold: k.monthlySold, amazonSelling: k.amazonSelling };
      }
      return sp;
    };
  }
  if (spApi) return (jan) => lookupAmazon(jan, spApi);
  if (keepaKey) return (jan) => lookupKeepa(jan, keepaKey);
  return undefined;
}

export function defaultLookupDeps(siteOrigin: string | undefined, env: Record<string, string | undefined> = process.env): LookupDeps {
  return {
    amazon: amazonSource(env),
    yahoo: isYahooConfigured(env) ? (jan) => searchYahoo({ jan }, env) : undefined,
    rakuten: isRakutenConfigured(env) ? (jan) => searchRakuten({ keyword: jan, siteOrigin }, env) : undefined,
  };
}
