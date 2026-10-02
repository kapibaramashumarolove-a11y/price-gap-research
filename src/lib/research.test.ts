import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawDomesticOffer } from "./domestic";
import { DomesticApiError } from "./domestic";
import type { EbayItemSummary } from "./ebay";
import { clearEbayCache, groupOffers, percentile, runResearch, type ResearchDeps } from "./research";

function offer(partial: Partial<RawDomesticOffer> & Pick<RawDomesticOffer, "title" | "priceJpy">): RawDomesticOffer {
  return {
    source: "yahoo",
    shipping: "free",
    url: `https://example.com/${encodeURIComponent(partial.title)}`,
    shopName: "shop",
    searchText: partial.title,
    ...partial,
  };
}

function ebayItem(title: string, price: number): EbayItemSummary {
  return { title, price: { value: String(price), currency: "USD" }, itemWebUrl: `https://www.ebay.com/itm/${price}` };
}

beforeEach(() => clearEbayCache());

describe("percentile", () => {
  it("安い方から 25%・中央値を求める", () => {
    expect(percentile([100, 200, 300, 400, 500], 0.25)).toBe(200);
    expect(percentile([10, 20], 0.25)).toBe(12.5);
    expect(percentile([], 0.25)).toBeNull();
  });
});

describe("groupOffers", () => {
  it("除外・識別できないものを数え、同じ JAN をまとめて安い順に並べる", () => {
    const { groups, excluded, unidentified } = groupOffers({ kind: "sealed", ngWords: [] }, [
      offer({ title: "テラスタルフェスex BOX", priceJpy: 20480, jan: "4521329362342" }),
      offer({ title: "テラスタルフェスex BOX シュリンク付き", priceJpy: 19180, jan: "4521329362342" }),
      offer({ title: "ポケモンカード BOXくじ 全200口", priceJpy: 12700 }),
      offer({ title: "ポケモンカード BOX 未開封", priceJpy: 9999 }),
    ]);
    expect(excluded).toBe(1);
    expect(unidentified).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].offers.map((o) => o.priceJpy)).toEqual([19180, 20480]);
  });

  it("カードはタイトルだけで識別する（説明文の別番号は使わない）", () => {
    const { groups, unidentified } = groupOffers({ kind: "psa10", ngWords: [] }, [
      offer({ title: "【PSA10】ピカチュウ AR", priceJpy: 50000, searchText: "【PSA10】ピカチュウ AR 関連: 205/172" }),
    ]);
    expect(groups).toHaveLength(0);
    expect(unidentified).toBe(1);
  });
});

describe("runResearch", () => {
  function deps(overrides: Partial<ResearchDeps> = {}): ResearchDeps {
    return {
      searchRakuten: vi.fn(async () => [
        offer({ source: "rakuten", title: "【PSA10】ピカチュウ AR 205/172", priceJpy: 60000, shipping: "extra" }),
      ]),
      searchYahoo: vi.fn(async () => [
        offer({ title: "ピカチュウ AR 205/172 PSA10 鑑定品", priceJpy: 58000 }),
        offer({ title: "【PSA10】リーリエ SR 397/190", priceJpy: 90000 }),
      ]),
      searchEbay: vi.fn(async ({ q }) => ({
        total: 103,
        items: q?.startsWith("205/172")
          ? [
              ebayItem("PSA 10 Pikachu AR 205/172 S12a VSTAR Universe Japanese", 420),
              ebayItem("Pikachu AR 205/172 PSA 10", 500),
              ebayItem("Pokemon Pikachu VSTAR Universe 205/172 AR Japanese PSA 10", 600),
              ebayItem("Pikachu AR 205/172 PSA 9", 200),
            ]
          : [],
      })),
      now: () => Date.parse("2026-10-02T00:00:00Z"),
      ...overrides,
    };
  }

  it("同じカードを楽天・Yahoo! からまとめ、eBay の相場（関係ない出品は除外）を付ける", async () => {
    const d = deps();
    const res = await runResearch({ kind: "psa10", keyword: "ポケモンカード PSA10", ngWords: [] }, d);

    expect(res.stats).toEqual({ rakuten: 1, yahoo: 2, excluded: 0, unidentified: 0 });
    expect(res.candidates.map((c) => c.key)).toEqual(["psa10:205/172", "psa10:397/190"]);

    const pikachu = res.candidates[0];
    expect(pikachu.offers.map((o) => [o.source, o.priceJpy])).toEqual([
      ["yahoo", 58000],
      ["rakuten", 60000],
    ]);
    expect(pikachu.ebay).toMatchObject({ query: "205/172 PSA 10 japanese", total: 103, count: 3, minUsd: 420, medianUsd: 500, p25Usd: 460 });
    expect(pikachu.ebay?.soldUrl).toContain("LH_Sold=1");
    expect(res.candidates[1].ebay?.count).toBe(0);
  });

  it("片方のサイトが失敗しても、もう片方の結果と注意を返す", async () => {
    const res = await runResearch(
      { kind: "psa10", keyword: "x", ngWords: [] },
      deps({ searchRakuten: vi.fn(async () => Promise.reject(new DomesticApiError("楽天: 環境変数 RAKUTEN_APP_ID が設定されていません。"))) }),
    );
    expect(res.warnings).toEqual(["楽天: 環境変数 RAKUTEN_APP_ID が設定されていません。"]);
    expect(res.stats.rakuten).toBeNull();
    expect(res.candidates).toHaveLength(2);
  });

  it("eBay で調べる数に上限をかけ、同じ検索は使い回す", async () => {
    const d = deps();
    const res = await runResearch({ kind: "psa10", keyword: "x", ngWords: [], maxLookups: 1 }, d);
    expect(res.candidates).toHaveLength(1);
    expect(res.skippedLookups).toBe(1);
    await runResearch({ kind: "psa10", keyword: "x", ngWords: [], maxLookups: 1 }, d);
    expect(d.searchEbay).toHaveBeenCalledTimes(1);
  });

  it("JAN で見つからなければ英語キーワードで探し直す", async () => {
    const searchEbay = vi.fn(async ({ gtin }: { gtin?: string }) => ({
      total: gtin ? 0 : 3,
      items: gtin
        ? []
        : [
            ebayItem("Terastal Festival ex sv8a Booster Box Japanese", 80),
            ebayItem("Terastal Festival Booster Box Japanese sealed", 90),
            ebayItem("Terastal Festival Booster Box Japanese", 100),
          ],
    }));
    const res = await runResearch(
      { kind: "sealed", keyword: "テラスタルフェス", ngWords: [], ebayKeyword: "Terastal Festival booster box japanese" },
      deps({
        searchRakuten: vi.fn(async () => []),
        searchYahoo: vi.fn(async () => [offer({ title: "テラスタルフェスex BOX", priceJpy: 19180, jan: "4521329362342" })]),
        searchEbay,
      }),
    );
    expect(searchEbay).toHaveBeenCalledTimes(2);
    expect(res.candidates[0].ebay).toMatchObject({ usedKeywordFallback: true, count: 3, medianUsd: 90 });
  });
});
