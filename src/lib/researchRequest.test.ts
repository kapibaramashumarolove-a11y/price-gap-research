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

describe("商品指定（kind: item）の検査", () => {
  it("JAN があればキーワードなしでもよく、状態の初期値は新品", () => {
    expect(parseResearchRequest({ kind: "item", keyword: "", jan: "4521329362342" })).toMatchObject({
      kind: "item",
      jan: "4521329362342",
      condition: "new",
    });
  });

  it("JAN がなければ eBay 用の英語キーワードが必要", () => {
    expect(parseResearchRequest({ kind: "item", keyword: "BOSS DS-1" })).toMatch(/英語キーワードか JAN/);
    expect(parseResearchRequest({ kind: "item", keyword: "BOSS DS-1", ebayKeyword: "Boss DS-1", condition: "used" })).toMatchObject({
      condition: "used",
    });
  });

  it("JAN のチェックデジット違い・状態の誤りはエラー", () => {
    expect(parseResearchRequest({ kind: "item", keyword: "x", jan: "4521329362343" })).toMatch(/JAN/);
    expect(parseResearchRequest({ kind: "item", keyword: "BOSS", ebayKeyword: "Boss", condition: "junk" })).toMatch(/状態/);
  });
});
