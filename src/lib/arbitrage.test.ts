import { describe, expect, it } from "vitest";
import { amazonRisks, amazonSellPrice, amazonTurnoverRank, analyzeJan, pickBestRoute, bestBuyOption, sellFees, sellPriceOn, turnoverRankFromSalesRank } from "./arbitrage";
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
      buyBoxPriceJpy: 15000,
      lowestFbaPriceJpy: 14800,
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
  it("Amazon はカート価格 → FBA 最安値 → 最安値の順、楽天・Yahoo! はそのモールの最安値", () => {
    expect(sellPriceOn(lookup(), "amazon")).toBe(15000);
    expect(sellPriceOn(lookup({ amazon: { ...lookup().amazon!, buyBoxPriceJpy: undefined } }), "amazon")).toBe(14800);
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

describe("amazonTurnoverRank", () => {
  it("月の販売数（S: 10 個以上・A: 3〜9・B: 1〜2・C: 実績なし）があればそれで決める", () => {
    const p = { asin: "B0", title: "x", url: "", salesRank: 500 };
    expect(amazonTurnoverRank({ ...p, salesRankDrops30: 10 })).toBe("S");
    expect(amazonTurnoverRank({ ...p, salesRankDrops30: 2, monthlySold: 5 })).toBe("A");
    expect(amazonTurnoverRank({ ...p, salesRankDrops30: 2 })).toBe("B");
    expect(amazonTurnoverRank({ ...p, salesRankDrops30: 0, salesRankDrops90: 0 })).toBe("C");
    // 90 日の回数 ÷ 3 も見る（30 日がたまたま少ないとき）
    expect(amazonTurnoverRank({ ...p, salesRankDrops30: 1, salesRankDrops90: 12 })).toBe("A");
    expect(amazonTurnoverRank(p)).toBe("S");
    expect(amazonTurnoverRank(undefined)).toBe("unknown");
  });
});

describe("amazonSellPrice（保守的な販売価格）", () => {
  const p = { asin: "B0", title: "x", url: "" };
  const on = { safePrice: true, fbaPremiumPercent: 5 };

  it("現在のカート価格と 90 日平均の低い方を使う", () => {
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 12000, buyBoxAvg90Jpy: 10000 }, on)?.priceJpy).toBe(10000);
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 9000, buyBoxAvg90Jpy: 10000 }, on)?.priceJpy).toBe(9000);
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 12000, buyBoxAvg90Jpy: 10000 }, { ...on, safePrice: false })?.priceJpy).toBe(12000);
  });

  it("カートが自己発送なら FBA プレミアムを足す（FBA 最安値は超えない・最大 10%）", () => {
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 10000, buyBoxIsFba: false }, on)?.priceJpy).toBe(10500);
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 10000, buyBoxIsFba: false, lowestFbaPriceJpy: 10300 }, on)?.priceJpy).toBe(10300);
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 10000, buyBoxIsFba: false }, { ...on, fbaPremiumPercent: 30 })?.priceJpy).toBe(11000);
    expect(amazonSellPrice({ ...p, buyBoxPriceJpy: 10000, buyBoxIsFba: true }, on)?.priceJpy).toBe(10000);
    // 安全値（90 日平均）に対してプレミアムを足す
    const both = amazonSellPrice({ ...p, buyBoxPriceJpy: 12000, buyBoxAvg90Jpy: 10000, buyBoxIsFba: false }, on)!;
    expect(both.priceJpy).toBe(10500);
    expect(both.notes).toHaveLength(2);
  });
});

describe("amazonRisks", () => {
  const p = { asin: "B0", title: "x", url: "" };
  const s = DEFAULT_ARBITRAGE_SETTINGS;
  const codes = (product: Parameters<typeof amazonRisks>[0]) => amazonRisks(product, s).map((r) => `${r.code}:${r.level}`);

  it("出品者が 7〜14 日で 30% 以上（2 人以上）増えたら危険", () => {
    expect(codes({ ...p, offerCount: 13, offerCount7dAgo: 10 })).toEqual(["offerSurge:danger"]);
    expect(codes({ ...p, offerCount: 13, offerCount7dAgo: 12, offerCount14dAgo: 9 })).toEqual(["offerSurge:danger"]);
    expect(codes({ ...p, offerCount: 12, offerCount7dAgo: 10 })).toEqual([]);
    // 1 → 2 人のような少人数の増加は数えない
    expect(codes({ ...p, offerCount: 2, offerCount7dAgo: 1 })).toEqual([]);
  });

  it("Amazon 本体がよくカートを取っていて今いないなら危険、今いるなら注意", () => {
    expect(codes({ ...p, amazonBuyBoxShare90: 45, amazonOutOfStock90: 30, amazonSelling: false })).toEqual(["amazonReturn:danger"]);
    expect(codes({ ...p, amazonBuyBoxShare90: 5, amazonOutOfStock90: 95, amazonSelling: false })).toEqual([]);
    expect(codes({ ...p, amazonBuyBoxShare90: 60, amazonSelling: true })).toEqual(["amazonSelling:caution"]);
  });

  it("バリエーションのシェアが低ければ危険、判定できなければ注意", () => {
    expect(codes({ ...p, variationCount: 8, variationSharePercent: 4, variationShareBasis: "sold" })).toEqual(["variation:danger"]);
    expect(codes({ ...p, variationCount: 8, variationSharePercent: 35 })).toEqual([]);
    expect(codes({ ...p, variationCount: 40 })).toEqual(["manyVariations:caution"]);
  });

  it("カート価格が 90 日平均より 20% 以上高ければ注意", () => {
    expect(codes({ ...p, buyBoxPriceJpy: 13000, buyBoxAvg90Jpy: 10000 })).toEqual(["priceSpike:caution"]);
  });
});

describe("pickBestRoute", () => {
  const route = (profitJpy: number, rank: "S" | "A" | "B" | "C" | "unknown", isTreasure = true) =>
    ({ profitJpy, rank, isTreasure }) as Parameters<typeof pickBestRoute>[0][number];

  it("利益 × 回転率の重みが一番大きいルートを選ぶ（少し利益が小さくてもよく売れる方）", () => {
    const fast = route(3000, "S");
    const slow = route(3500, "C");
    expect(pickBestRoute([slow, fast])).toBe(fast);
    expect(pickBestRoute([route(3000, "B"), route(7000, "C")])?.profitJpy).toBe(7000);
  });

  it("条件を満たすルートがあればその中から、利益の出るルートがなければ損の一番小さいもの", () => {
    const treasure = route(1500, "A");
    expect(pickBestRoute([route(9000, "S", false), treasure])).toBe(treasure);
    expect(pickBestRoute([route(-500, "S", false), route(-100, "C", false)])?.profitJpy).toBe(-100);
    expect(pickBestRoute([])).toBeUndefined();
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

  it("危険なリスクがある Amazon 販売ルートは推奨から外し、安全なルートを選ぶ", () => {
    const risky = lookup({ amazon: { ...lookup().amazon!, offerCount: 20, offerCount7dAgo: 10 } });
    const { best, routes } = analyzeJan(risky, settings);
    const toAmazon = routes.find((r) => r.buy === "yahoo" && r.sell === "amazon")!;
    expect(toAmazon).toMatchObject({ blockedByRisk: true, isTreasure: false });
    expect(toAmazon.risks.map((r) => r.code)).toEqual(["offerSurge"]);
    expect(best?.sell).not.toBe("amazon");
    // 外さない設定なら、リスクを表示したまま推奨にする
    expect(analyzeJan(risky, { ...settings, excludeRisky: false }).best).toMatchObject({ buy: "yahoo", sell: "amazon", isTreasure: true });
  });

  it("Keepa の手数料率と FBA 配送代行手数料があれば、実際の販売価格で手数料を計算する", () => {
    const keepa = lookup({ amazon: { ...lookup().amazon!, referralFeePercent: 8, fbaPickAndPackJpy: 400 } });
    // 15,000 × 8% + 400 = 1,600
    expect(sellFees(keepa, "amazon", 15000, settings)).toEqual({ feesJpy: 1600, fromApi: true });
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
