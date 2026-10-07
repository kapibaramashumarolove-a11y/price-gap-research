import { describe, expect, it } from "vitest";
import { findJansByKeyword } from "./janSearch";
import type { RawDomesticOffer } from "./rakuten";

const o = (title: string, priceJpy: number, jan?: string): RawDomesticOffer => ({
  mall: "yahoo",
  title,
  priceJpy,
  shipping: "free",
  pointsJpy: 0,
  url: "https://example.com",
  shopName: "",
  searchText: title,
  jan,
});

describe("findJansByKeyword", () => {
  it("JAN ごとにまとめ、JAN なし・間違った JAN・セット売りを除いて出品の多い順に並べる", () => {
    const result = findJansByKeyword([
      o("A 本体", 3000, "4902370548495"),
      o("B", 900, "49123456"),
      o("A 本体 安い", 2800, "4902370548495"),
      o("A 2個セット", 5000, "4902370548495"),
      o("JAN なし", 100),
      o("JAN 間違い", 100, "4902370548496"),
    ]);
    expect(result).toEqual([
      { jan: "4902370548495", title: "A 本体", imageUrl: undefined, minPriceJpy: 2800, count: 2 },
      { jan: "49123456", title: "B", imageUrl: undefined, minPriceJpy: 900, count: 1 },
    ]);
  });
});
