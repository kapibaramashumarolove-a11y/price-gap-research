import { describe, expect, it } from "vitest";
import { parseClientAmazonCache } from "./amazonCache";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const cache = {
  fetchedAt: "2026-10-08T06:00:00Z",
  product: {
    asin: "B0TEST0001",
    title: "テスト商品",
    url: "https://www.amazon.co.jp/dp/B0TEST0001",
    buyBoxPriceJpy: 9800,
    salesRankDrops30: 12,
    referralFeePercent: 10,
    buyBoxIsFba: false,
    variationShareBasis: "sold",
    evil: "<script>",
  },
  offers: [
    { mall: "amazon", title: "x", priceJpy: 9800, shipping: "free", pointsJpy: 99999, url: "https://www.amazon.co.jp/dp/B0TEST0001", shopName: "FBA" },
    { mall: "amazon", priceJpy: 1, url: "javascript:alert(1)" },
  ],
};

describe("parseClientAmazonCache", () => {
  it("決めた時間内のキャッシュを使い、知らない項目や危ない値は捨てる", () => {
    const result = parseClientAmazonCache(cache, 12, NOW)!;
    expect(result.fromCache).toBe(true);
    expect(result.fetchedAt).toBe("2026-10-08T06:00:00.000Z");
    expect(result.product).toEqual({
      asin: "B0TEST0001",
      title: "テスト商品",
      url: "https://www.amazon.co.jp/dp/B0TEST0001",
      imageUrl: undefined,
      buyBoxPriceJpy: 9800,
      salesRankDrops30: 12,
      referralFeePercent: 10,
      buyBoxIsFba: false,
      variationShareBasis: "sold",
    });
    // ポイントは価格を超えない・危ない URL の出品は捨てる
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].pointsJpy).toBe(9800);
    expect(result.warnings[0]).toMatch(/6 時間前に Keepa で取得したデータ.*トークン 0/);
  });

  it("古い・未来の日時・時間 0・形がおかしいものは使わない（Keepa で取り直す）", () => {
    expect(parseClientAmazonCache(cache, 4, NOW)).toBeUndefined();
    expect(parseClientAmazonCache(cache, 0, NOW)).toBeUndefined();
    expect(parseClientAmazonCache({ ...cache, fetchedAt: "2026-10-09T00:00:00Z" }, 12, NOW)).toBeUndefined();
    expect(parseClientAmazonCache({ ...cache, product: { asin: "bad", url: "https://evil.example/" } }, 12, NOW)).toBeUndefined();
    expect(parseClientAmazonCache(undefined, 12, NOW)).toBeUndefined();
    // 24 時間より長くは使わない
    expect(parseClientAmazonCache({ ...cache, fetchedAt: "2026-10-07T06:00:00Z" }, 48, NOW)).toBeUndefined();
  });

  it("「Amazon に登録なし」の結果も使い回す", () => {
    const result = parseClientAmazonCache({ fetchedAt: cache.fetchedAt, offers: [] }, 12, NOW)!;
    expect(result.product).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("登録されていません"))).toBe(true);
  });
});
