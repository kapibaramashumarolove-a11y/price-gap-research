import { describe, expect, it } from "vitest";
import { analyzeJan, bestBuyOption, sellFees, sellPriceOn, turnoverRankFromSalesRank } from "./arbitrage";
import { DEFAULT_ARBITRAGE_SETTINGS, type ArbitrageSettings, type JanLookup, type MallOffer } from "./malls";

function offer(o: Partial<MallOffer> & Pick<MallOffer, "mall" | "priceJpy">): MallOffer {
  return { title: "商品", shipping: "free", pointsJpy: 0, url: `https://example.com/${o.mall}`, shopName: "店", ...o };
}

function lookup(overrides: Partial<JanLookup> = {}): JanLookup {
  return {
    jan: "4901234567894",
    title: "テスト商品",
    offers: {
      amazon: [],
      rakuten: [offer({ mall: "rakuten", priceJpy: 10000, pointsJpy: 90 })],
      yahoo: [offer({ mall: "yahoo", priceJpy: 9000, pointsJpy: 450 })],
    },
    amazon: {
      asin: "B000TEST00",
      title: "テスト商品",
      salesRank: 12000,
      lowestFbaPriceJpy: 15000,
      buyBoxPriceJpy: 14800,
      fbaFeesJpy: 2100,
      feesForPriceJpy: 15000,
      url: "https://www.amazon.co.jp/dp/B000TEST00",
    },
    warnings: [],
    excludedSets: 0,
    fetchedAt: "2026-10-07T00:00:00Z",
    ...overrides,
  };
}

const settings: ArbitrageSettings = DEFAULT_ARBITRAGE_SETTINGS;

describe("bestBuyOption", () => {
  it("送料とポイント（モールのポイント＋上乗せ。現金換算の割合を掛ける）を含めて一番安い出品を選ぶ", () => {
    const offers = [
      offer({ mall: "yahoo", priceJpy: 9000, pointsJpy: 0, shipping: "extra" }), // 9,000 + 600 = 9,600
      offer({ mall: "yahoo", priceJpy: 9400, pointsJpy: 0 }), // 9,400
    ];
    expect(bestBuyOption(offers, settings)?.offer.priceJpy).toBe(9400);

    const withPoints = bestBuyOption([offer({ mall: "yahoo", priceJpy: 10000, pointsJpy: 500 })], {
      ...settings,
      extraPointPercent: { ...settings.extraPointPercent, yahoo: 5 },
      pointValuePercent: 80,
    })!;
    // (500 + 10,000 × 5%) × 80% = 800
    expect(withPoints).toMatchObject({ pointsJpy: 800, netJpy: 9200 });
  });
});

describe("sellPriceOn / sellFees", () => {
  it("Amazon は FBA 最安値 → カート価格 → 最安値の順、楽天・Yahoo! はそのモールの最安値", () => {
    expect(sellPriceOn(lookup(), "amazon")).toBe(15000);
    expect(sellPriceOn(lookup({ amazon: { ...lookup().amazon!, lowestFbaPriceJpy: undefined } }), "amazon")).toBe(14800);
    expect(sellPriceOn(lookup(), "rakuten")).toBe(10000);
    expect(sellPriceOn(lookup({ amazon: undefined }), "amazon")).toBeUndefined();
  });

  it("Amazon は SP-API の見積もり（価格差の販売手数料を調整）、なければ設定の割合＋FBA 手数料", () => {
    expect(sellFees(lookup(), "amazon", 15000, settings)).toEqual({ feesJpy: 2100, fromApi: true });
    expect(sellFees(lookup(), "amazon", 16000, settings)).toEqual({ feesJpy: 2200, fromApi: true });
    const noFees = lookup({ amazon: { ...lookup().amazon!, fbaFeesJpy: undefined, feesForPriceJpy: undefined } });
    expect(sellFees(noFees, "amazon", 15000, settings)).toEqual({ feesJpy: 2000, fromApi: false });
    expect(sellFees(lookup(), "yahoo", 10000, settings)).toEqual({ feesJpy: 800, fromApi: false });
  });
});

describe("turnoverRankFromSalesRank", () => {
  it("Amazon の売れ筋ランキングから回転率を決める", () => {
    expect(turnoverRankFromSalesRank(3000)).toBe("S");
    expect(turnoverRankFromSalesRank(12000)).toBe("A");
    expect(turnoverRankFromSalesRank(80000)).toBe("B");
    expect(turnoverRankFromSalesRank(500000)).toBe("C");
    expect(turnoverRankFromSalesRank(undefined)).toBe("unknown");
  });
});

describe("analyzeJan", () => {
  it("すべての仕入れ先 → 販売先を計算し、一番利益の大きいルートを選ぶ", () => {
    const { routes, best, amazonRank } = analyzeJan(lookup(), settings);
    expect(amazonRank).toBe("A");
    // Yahoo! 9,000 − 450pt = 8,550 で仕入れ → Amazon 15,000 − 手数料 2,100 − 納品 100 = 12,800 → 利益 4,250
    expect(best).toMatchObject({ buy: "yahoo", sell: "amazon", profitJpy: 4250, rank: "A", isTreasure: true });
    expect(best!.marginPercent).toBeCloseTo(28.3, 1);
    // 楽天 → Yahoo!: 9,000 − 720 − 700 − (10,000 − 90) = −2,330
    expect(routes.find((r) => r.buy === "rakuten" && r.sell === "yahoo")?.profitJpy).toBe(-2330);
    // Amazon は出品がない（仕入れ先にならない）
    expect(routes.some((r) => r.buy === "amazon")).toBe(false);
    expect(routes.map((r) => r.profitJpy)).toEqual([...routes.map((r) => r.profitJpy)].sort((a, b) => b - a));
  });

  it("販売しないモールはルートに含めない", () => {
    const off = { ...settings, sell: { ...settings.sell, amazon: { ...settings.sell.amazon, enabled: false } } };
    expect(analyzeJan(lookup(), off).routes.some((r) => r.sell === "amazon")).toBe(false);
  });

  it("楽天・Yahoo! で売るルートは回転率が分からず、回転率の条件があればお宝にしない", () => {
    const cheapAmazon = lookup({
      offers: { ...lookup().offers, amazon: [offer({ mall: "amazon", priceJpy: 5000, fba: true })] },
    });
    const strict = { ...settings, minRank: "B" as const };
    const toYahoo = analyzeJan(cheapAmazon, strict).routes.find((r) => r.buy === "amazon" && r.sell === "yahoo")!;
    expect(toYahoo.profitJpy).toBeGreaterThan(1000);
    expect(toYahoo).toMatchObject({ rank: "unknown", isTreasure: false });
  });
});
