import { describe, expect, it } from "vitest";
import { calculateProfit, DEFAULT_SETTINGS, type ProfitInput } from "./profit";

const baseItem: ProfitInput = {
  purchasePriceJpy: 20000,
  purchaseExtraJpy: 1000,
  ebayPriceUsd: 200,
  ebayShippingChargedUsd: 20,
};

describe("calculateProfit", () => {
  it("手計算した例と一致する", () => {
    // 売上 220 USD、手数料 220 × 14.9% + 0.4 = 33.18 USD
    // 入金 (220 - 33.18) × 150 = 28,023 円
    // 原価 20,000 + 1,000 + 4,000 = 25,000 円 → 利益 3,023 円
    const r = calculateProfit(baseItem, DEFAULT_SETTINGS);
    expect(r.revenueUsd).toBe(220);
    expect(r.ebayFeesUsd).toBeCloseTo(33.18);
    expect(r.payoutJpy).toBeCloseTo(28023);
    expect(r.totalCostJpy).toBe(25000);
    expect(r.profitJpy).toBeCloseTo(3023);
    expect(r.marginPercent).toBeCloseTo((3023 / 33000) * 100);
  });

  it("仕入れが高すぎると利益がマイナスになる", () => {
    const r = calculateProfit({ ...baseItem, purchasePriceJpy: 40000 }, DEFAULT_SETTINGS);
    expect(r.profitJpy).toBeLessThan(0);
  });

  it("売上が 0 のとき利益率は 0 として扱う", () => {
    const r = calculateProfit(
      { ...baseItem, ebayPriceUsd: 0, ebayShippingChargedUsd: 0 },
      { ...DEFAULT_SETTINGS, perOrderFeeUsd: 0 },
    );
    expect(r.marginPercent).toBe(0);
  });
});
