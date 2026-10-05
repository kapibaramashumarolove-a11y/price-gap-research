import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./profit";
import { DEFAULT_CRITERIA } from "./researchProfit";
import type { RawDomesticOffer } from "./domestic";
import { DomesticApiError } from "./domestic";
import type { EbayItemSummary } from "./ebay";
import { clearEbayCache, computeSalesSignal, discoverFromRanking, groupOffers, percentile, runResearch, trimPriceOutliers, type ResearchDeps } from "./research";

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

describe("商品指定（kind: item）", () => {
  it("キーワードの単語をすべて含む国内商品だけを 1 つにまとめ、eBay を英語キーワードで 1 回調べる", async () => {
    const searchEbay = vi.fn(async () => ({
      total: 40,
      items: [
        ebayItem("Nikon F3 35mm SLR Film Camera Body Only", 300),
        ebayItem("Nikon F3 HP Body [Near Mint]", 400),
        ebayItem("Nikon F3 Body for parts not working", 80),
        ebayItem("Nikon FM2 body", 200),
        ebayItem("Nikon F3 body + 50mm lens lot", 600),
      ],
    }));
    const res = await runResearch(
      { kind: "item", keyword: "ニコン F3 ボディ", ngWords: [], ebayKeyword: "Nikon F3 body", condition: "used" },
      {
        searchRakuten: vi.fn(async () => [
          offer({ source: "rakuten", title: "ニコン Nikon F3 ボディ 中古 美品", priceJpy: 38000 }),
          offer({ source: "rakuten", title: "ニコン F3 ボディ ジャンク", priceJpy: 9000 }),
        ]),
        searchYahoo: vi.fn(async () => [
          offer({ title: "Nikon ニコン F3 ボディ", priceJpy: 35000 }),
          offer({ title: "ニコン F3 用 ストラップ", priceJpy: 2000 }),
        ]),
        searchEbay,
        now: () => 0,
      },
    );
    // ジャンク（楽天）と「F3 用 ストラップ」（付属品）を除外
    expect(res.stats).toMatchObject({ rakuten: 2, yahoo: 2, excluded: 2, unidentified: 0 });
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0];
    expect(c).toMatchObject({ kind: "item", label: "中古" });
    expect(c.offers.map((o) => o.priceJpy)).toEqual([35000, 38000]);
    expect(searchEbay).toHaveBeenCalledWith({ q: "Nikon F3 body", gtin: undefined, conditionIds: ["1500", "2750", "3000", "4000", "5000", "6000"] });
    // 部品取り・FM2・まとめ売りは除く
    expect(c.ebay).toMatchObject({ count: 2, minUsd: 300, medianUsd: 350 });
  });

  it("新品を探すときは中古品を除き、国内で見つからなければ eBay を呼ばない", async () => {
    const searchEbay = vi.fn();
    const res = await runResearch(
      { kind: "item", keyword: "BOSS DS-1", ngWords: [], ebayKeyword: "Boss DS-1" },
      {
        searchRakuten: vi.fn(async () => [offer({ source: "rakuten", title: "BOSS DS-1 中古", priceJpy: 5000 })]),
        searchYahoo: vi.fn(async () => []),
        searchEbay,
        now: () => 0,
      },
    );
    expect(res.candidates).toEqual([]);
    expect(res.stats.excluded).toBe(1);
    expect(searchEbay).not.toHaveBeenCalled();
  });

  it("JAN 指定: JAN が一致する商品を集め、eBay は JAN で探して少なければ英語キーワードで探し直す", async () => {
    const jan = "4521329362342";
    const searchEbay = vi.fn(async ({ gtin }: { gtin?: string }) => ({
      total: gtin ? 1 : 3,
      items: gtin
        ? [ebayItem("Terastal Festival Box", 80)]
        : [ebayItem("Terastal Festival Box", 80), ebayItem("Terastal Festival Box JP", 90), ebayItem("Terastal Festival Box sealed", 100)],
    }));
    const res = await runResearch(
      { kind: "item", keyword: "", ngWords: [], jan, ebayKeyword: "Terastal Festival Box", condition: "new" },
      {
        searchRakuten: vi.fn(async () => [
          offer({ source: "rakuten", title: "テラスタルフェス BOX", priceJpy: 19000, searchText: `テラスタルフェス BOX JAN:${jan}` }),
          offer({ source: "rakuten", title: "別の商品", priceJpy: 100, searchText: "JAN:4521329362343" }),
        ]),
        searchYahoo: vi.fn(async () => [offer({ title: "テラスタルフェス BOX", priceJpy: 19500, jan })]),
        searchEbay,
        now: () => 0,
      },
    );
    expect(res.candidates[0].offers.map((o) => o.priceJpy)).toEqual([19000, 19500]);
    expect(res.candidates[0].label).toBe(`新品・JAN ${jan}`);
    expect(searchEbay).toHaveBeenCalledTimes(2);
    expect(res.candidates[0].ebay).toMatchObject({ usedKeywordFallback: true, count: 3 });
  });
});

describe("trimPriceOutliers", () => {
  it("中央値の 30% 未満・3 倍超の出品（部品・まとめ売り）を除く", () => {
    const items = [10, 500, 560, 600, 650, 2000].map((p) => ebayItem(`item ${p}`, p));
    expect(trimPriceOutliers(items).map((i) => Number(i.price?.value))).toEqual([500, 560, 600, 650]);
  });
});

describe("売れ行きの推定", () => {
  const now = Date.parse("2026-10-04T00:00:00Z");
  const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();

  it("まとめ出品の売れた数と出品日数から、月の販売数と売れている出品の価格を出す", () => {
    const signal = computeSalesSignal(
      [
        { sales: { soldQuantity: 30, totalQuantity: 40 }, priceUsd: 500, originDate: daysAgo(90) }, // 月 10 個
        { sales: { soldQuantity: 3, totalQuantity: 5 }, priceUsd: 600, originDate: daysAgo(30) }, // 月 3 個
        { sales: { soldQuantity: 0, totalQuantity: 2 }, priceUsd: 450, originDate: daysAgo(10) },
        { sales: { soldQuantity: 0, totalQuantity: 1 }, priceUsd: 400, originDate: daysAgo(5) }, // 1 点もの（数えない）
      ],
      now,
    );
    expect(signal).toEqual({
      checkedListings: 4,
      multiQuantityListings: 3,
      soldTotal: 33,
      estimatedMonthlySales: 13,
      soldPriceMedianUsd: 500,
    });
  });

  it("出品から間もない出品は 7 日として数え、多く出すぎないようにする", () => {
    const signal = computeSalesSignal([{ sales: { soldQuantity: 1, totalQuantity: 3 }, priceUsd: 100, originDate: daysAgo(1) }], now);
    expect(signal.estimatedMonthlySales).toBeCloseTo(4.3, 1);
  });

  it("リサーチの結果に売れ行きを付け、1 件取れなくても他の出品で推定する", async () => {
    const getItemSales = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("boom");
      return { soldQuantity: 10, totalQuantity: 12 };
    });
    const res = await runResearch(
      { kind: "item", keyword: "BOSS DS-1", ngWords: [], ebayKeyword: "Boss DS-1", condition: "new" },
      {
        searchRakuten: vi.fn(async () => []),
        searchYahoo: vi.fn(async () => [offer({ title: "BOSS DS-1 新品", priceJpy: 6000 })]),
        searchEbay: vi.fn(async () => ({
          total: 3,
          items: [
            { ...ebayItem("Boss DS-1 Distortion", 60), itemId: "a", itemOriginDate: daysAgo(30) },
            { ...ebayItem("Boss DS-1 Distortion pedal", 70), itemId: "bad", itemOriginDate: daysAgo(30) },
            { ...ebayItem("Boss DS-1 new", 65), itemId: "c", itemOriginDate: daysAgo(60) },
          ],
        })),
        getItemSales,
        now: () => now,
      },
    );
    expect(getItemSales).toHaveBeenCalledTimes(3);
    expect(res.candidates[0].ebay?.sales).toMatchObject({ checkedListings: 2, multiQuantityListings: 2, soldTotal: 20, estimatedMonthlySales: 15 });
  });
});

describe("discoverFromRanking（売れ筋から探す）", () => {
  const ranked = (rank: number, title: string, priceJpy: number) => ({ ...offer({ source: "rakuten", title, priceJpy }), rank });

  it("型番を取り出して eBay と比べ、型番なし・付属品は除き、同じ型番はまとめ、お宝候補だけ売れ行きを調べる", async () => {
    const searchEbay = vi.fn(async ({ q }: { q?: string }) => ({
      total: 10,
      items:
        q === "ZV-E10"
          ? [
              { ...ebayItem("Sony ZV-E10 body", 600), itemId: "z1" },
              { ...ebayItem("Sony ZV-E10 Mirrorless body", 650), itemId: "z2" },
              { ...ebayItem("Sony ZV-E10 camera", 700), itemId: "z3" },
            ]
          : [
              { ...ebayItem("Boss DS-1 pedal", 60), itemId: "b1" },
              { ...ebayItem("Boss DS-1 distortion", 65), itemId: "b2" },
              { ...ebayItem("Boss DS-1", 70), itemId: "b3" },
            ],
    }));
    const getItemSales = vi.fn(async () => ({ soldQuantity: 5, totalQuantity: 8 }));
    const { candidates, stats } = await discoverFromRanking(
      [
        ranked(1, "【楽天1位】ソニー VLOGCAM ZV-E10 ボディ 送料無料", 60000),
        ranked(2, "ソニー ZV-E10 ボディ ブラック", 62000),
        ranked(3, "【送料無料】国産 うなぎ 蒲焼き 2尾", 4000),
        ranked(4, "ZV-E10用 液晶保護フィルム", 980),
        ranked(5, "BOSS DS-1 ディストーション", 8000),
      ],
      { settings: DEFAULT_SETTINGS, criteria: DEFAULT_CRITERIA, internationalShippingJpy: 2000 },
      { searchRakuten: vi.fn(), searchYahoo: vi.fn(), searchEbay, getItemSales, now: () => 0 },
    );
    expect(stats).toEqual({ received: 5, noIdentifier: 1, excluded: 1, duplicates: 1, checked: 2, salesChecked: 1 });
    expect(candidates.map((c) => c.label).sort()).toEqual(["楽天1位・ZV-E10", "楽天5位・DS-1"]);
    // ZV-E10（eBay $600〜700 に対して 6 万円）はお宝候補なので売れ行きを調べ、DS-1（$60〜70 に対して 8,000 円）は調べない
    const zv = candidates.find((c) => c.label.includes("ZV-E10"))!;
    expect(zv.ebay?.sales?.soldTotal).toBeGreaterThan(0);
    expect(candidates.find((c) => c.label.includes("DS-1"))!.ebay?.sales).toBeUndefined();
    expect(getItemSales).toHaveBeenCalledTimes(3);
  });
});
