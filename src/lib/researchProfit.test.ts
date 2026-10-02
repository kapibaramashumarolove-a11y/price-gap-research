import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./profit";
import { DEFAULT_CRITERIA, evaluateCandidate } from "./researchProfit";
import type { Candidate, EbayMarket } from "./researchTypes";

const market: EbayMarket = {
  query: "205/172 PSA 10 japanese",
  usedKeywordFallback: false,
  conditionIds: ["2750"],
  total: 100,
  count: 10,
  minUsd: 400,
  p25Usd: 500,
  medianUsd: 600,
  samples: [],
  activeUrl: "",
  soldUrl: "",
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    key: "psa10:205/172",
    label: "205/172 PSA10",
    kind: "psa10",
    offers: [
      { source: "rakuten", title: "A", priceJpy: 50000, shipping: "extra", url: "r", shopName: "" },
      { source: "yahoo", title: "B", priceJpy: 50500, shipping: "free", url: "y", shopName: "" },
    ],
    ebay: market,
    ...overrides,
  };
}

describe("evaluateCandidate", () => {
  it("送料を含めて一番安い仕入れ先を選び、利益を計算する", () => {
    const ev = evaluateCandidate(candidate(), DEFAULT_SETTINGS, DEFAULT_CRITERIA, 2000)!;
    // 楽天 50,000 + 送料 800 = 50,800 より Yahoo! 50,500（送料無料）が安い
    expect(ev.offer.source).toBe("yahoo");
    expect(ev.purchaseJpy).toBe(50500);
    expect(ev.ebayPriceUsd).toBe(500);
    // (500 − 500×14.9% − 0.4) × 150 = 63,765 → − 50,500 − 2,000 = 11,265
    expect(ev.profit.profitJpy).toBeCloseTo(11265, 0);
    expect(ev.profit.marginPercent).toBeCloseTo(15.02, 1);
    expect(ev.isTreasure).toBe(true);
  });

  it("利益率が条件に届かなければお宝ではない", () => {
    const ev = evaluateCandidate(candidate(), DEFAULT_SETTINGS, { ...DEFAULT_CRITERIA, minMarginPercent: 20 }, 2000)!;
    expect(ev.isTreasure).toBe(false);
  });

  it("eBay の比較対象が少なければお宝にしない", () => {
    const ev = evaluateCandidate(candidate({ ebay: { ...market, count: 2 } }), DEFAULT_SETTINGS, DEFAULT_CRITERIA, 2000)!;
    expect(ev.isTreasure).toBe(false);
    expect(ev.notes[0]).toMatch(/2 件/);
  });

  it("相場が取れていなければ評価しない", () => {
    expect(evaluateCandidate(candidate({ ebay: null }), DEFAULT_SETTINGS, DEFAULT_CRITERIA)).toBeUndefined();
    expect(evaluateCandidate(candidate({ ebay: { ...market, p25Usd: null } }), DEFAULT_SETTINGS, DEFAULT_CRITERIA)).toBeUndefined();
  });
});
