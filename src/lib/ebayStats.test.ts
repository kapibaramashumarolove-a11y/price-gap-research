import { describe, expect, it } from "vitest";
import { median, parseItemSummaries, summarizeListings } from "./ebayStats";

describe("median", () => {
  it("奇数件なら真ん中の値", () => {
    expect(median([300, 100, 200])).toBe(200);
  });

  it("偶数件なら真ん中 2 つの平均", () => {
    expect(median([100, 400, 200, 300])).toBe(250);
  });

  it("空なら null", () => {
    expect(median([])).toBeNull();
  });
});

// Browse API のレスポンスを必要な部分だけ再現したもの
const sampleResponse = {
  total: 1234,
  itemSummaries: [
    {
      title: "Nike Dunk Low Panda DD1391-100",
      price: { value: "150.00", currency: "USD" },
      condition: "New with box",
      itemWebUrl: "https://www.ebay.com/itm/1",
      shippingOptions: [{ shippingCost: { value: "12.50", currency: "USD" } }],
    },
    {
      title: "Nike Dunk Low Panda",
      price: { value: "120.00", currency: "USD" },
      condition: "New with box",
      itemWebUrl: "https://www.ebay.com/itm/2",
    },
    {
      title: "カナダドル建ての出品（除外される）",
      price: { value: "99.00", currency: "CAD" },
    },
    {
      title: "価格なし（除外される）",
    },
    {
      title: "Nike Dunk Low",
      price: { value: "180.00", currency: "USD" },
      itemWebUrl: "https://www.ebay.com/itm/3",
      shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
    },
  ],
};

describe("parseItemSummaries", () => {
  it("USD の出品だけを取り出す", () => {
    const { totalFound, listings } = parseItemSummaries(sampleResponse);
    expect(totalFound).toBe(1234);
    expect(listings.map((l) => l.priceUsd)).toEqual([150, 120, 180]);
    expect(listings[0].shippingUsd).toBe(12.5);
    expect(listings[1].shippingUsd).toBeNull();
    expect(listings[2].shippingUsd).toBe(0);
  });

  it("検索結果 0 件（itemSummaries なし）でもエラーにならない", () => {
    expect(parseItemSummaries({ total: 0 })).toEqual({ totalFound: 0, listings: [] });
  });
});

describe("summarizeListings", () => {
  it("中央値・最安値・最高値・件数を計算し、安い順のサンプルを返す", () => {
    const { listings, totalFound } = parseItemSummaries(sampleResponse);
    const s = summarizeListings(listings, { query: "DD1391-100", environment: "production", totalFound }, 2);
    expect(s.count).toBe(3);
    expect(s.medianUsd).toBe(150);
    expect(s.minUsd).toBe(120);
    expect(s.maxUsd).toBe(180);
    expect(s.samples.map((l) => l.priceUsd)).toEqual([120, 150]);
  });

  it("0 件なら価格は null", () => {
    const s = summarizeListings([], { query: "x", environment: "sandbox", totalFound: 0 });
    expect(s).toMatchObject({ count: 0, medianUsd: null, minUsd: null, maxUsd: null, samples: [] });
  });
});
