import { describe, expect, it } from "vitest";
import { parseResearchRequest } from "./researchRequest";

describe("parseResearchRequest", () => {
  it("正しい内容を整えて返す", () => {
    expect(
      parseResearchRequest({ kind: "psa10", keyword: " ポケカ PSA10 ", ngWords: [" 韓国版 ", ""], minPriceJpy: "5000", maxLookups: 10 }),
    ).toEqual({ kind: "psa10", keyword: "ポケカ PSA10", ngWords: ["韓国版"], minPriceJpy: 5000, maxPriceJpy: undefined, ebayKeyword: undefined, maxLookups: 10 });
  });

  it("おかしな内容はエラーメッセージ", () => {
    expect(parseResearchRequest(null)).toMatch(/形式/);
    expect(parseResearchRequest({ kind: "x", keyword: "ポケカ" })).toMatch(/種類/);
    expect(parseResearchRequest({ kind: "sealed", keyword: "a" })).toMatch(/2 文字/);
    expect(parseResearchRequest({ kind: "sealed", keyword: "ポケカ", minPriceJpy: -1 })).toMatch(/価格/);
    expect(parseResearchRequest({ kind: "sealed", keyword: "ポケカ", maxLookups: 99 })).toMatch(/30 件/);
  });
});
