// キーワード検索の結果から JAN ごとにまとめる（「JAN が分からない商品」を探すための補助）。

import { isValidJan } from "./jan";
import { isMultiUnitListing, isUsedListing } from "./lookup";
import type { RawDomesticOffer } from "./rakuten";

export type JanCandidate = { jan: string; title: string; imageUrl?: string; minPriceJpy: number; count: number };

/** 見つかった出品を JAN ごとにまとめる（JAN のないもの・セット売りは除く）。出品の多い順 */
export function findJansByKeyword(offers: RawDomesticOffer[]): JanCandidate[] {
  const byJan = new Map<string, JanCandidate>();
  for (const o of offers) {
    if (!o.jan || !isValidJan(o.jan) || isMultiUnitListing(o.title) || isUsedListing(o)) continue;
    const prev = byJan.get(o.jan);
    if (prev) {
      prev.count++;
      prev.minPriceJpy = Math.min(prev.minPriceJpy, o.priceJpy);
    } else {
      byJan.set(o.jan, { jan: o.jan, title: o.title, imageUrl: o.imageUrl, minPriceJpy: o.priceJpy, count: 1 });
    }
  }
  return [...byJan.values()].sort((a, b) => b.count - a.count).slice(0, 30);
}
