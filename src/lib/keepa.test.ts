import { describe, expect, it, vi } from "vitest";
import { KeepaApiError, lookupKeepa, readKeepaKey } from "./keepa";

const JAN = "4902370548495";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** stats.current（-1 はデータなし） */
function current(values: Record<number, number>): number[] {
  const arr = Array.from({ length: 36 }, () => -1);
  for (const [k, v] of Object.entries(values)) arr[Number(k)] = v;
  return arr;
}

const product = {
  asin: "B0TEST0001",
  title: "ニンテンドースイッチ 本体",
  eanList: [JAN],
  images: [{ l: "big.jpg", m: "medium.jpg" }],
  categoryTree: [{ catId: 637394, name: "ゲーム" }],
  salesRankReference: 637394,
  monthlySold: 0,
  referralFeePercentage: 10,
  fbaFees: { pickAndPackFee: 514 },
  // 1: 新品最安 / 3: ランキング / 7: 自社発送最安（送料込み） / 10: FBA 最安 / 11: 新品の出品者数 / 18: カート
  stats: { current: current({ 1: 31000, 3: 152, 7: 31500, 10: 32980, 11: 12, 18: 32980 }), salesRankDrops30: 25, salesRankDrops90: 70 },
};

describe("lookupKeepa", () => {
  it("JAN で Amazon.co.jp の商品を調べ、価格・ランキング・販売回数・手数料を読み取る", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ products: [product], tokensLeft: 100 }));
    const result = await lookupKeepa(JAN, "secret-key", fetchFn);

    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.keepa.com/product");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ domain: "5", code: JAN, stats: "90", history: "0" });

    expect(result.product).toEqual({
      asin: "B0TEST0001",
      title: "ニンテンドースイッチ 本体",
      imageUrl: "https://m.media-amazon.com/images/I/medium.jpg",
      salesRank: 152,
      salesRankCategory: "ゲーム",
      salesRankDrops30: 25,
      salesRankDrops90: 70,
      monthlySold: undefined,
      buyBoxPriceJpy: 32980,
      lowestFbaPriceJpy: 32980,
      lowestPriceJpy: 31000,
      offerCount: 12,
      amazonSelling: false,
      // 32,980 × 10% + 514
      fbaFeesJpy: 3812,
      feesForPriceJpy: 32980,
      url: "https://www.amazon.co.jp/dp/B0TEST0001",
    });
    expect(result.offers.map((o) => [o.shopName, o.priceJpy, o.fba])).toEqual([
      ["出品者（自社発送）最安・送料込み", 31500, false],
      ["出品者（FBA）最安", 32980, true],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("Amazon 本体が販売中なら注意を出し、別の JAN の商品は使わない", async () => {
    const amazonSells = { ...product, stats: { ...product.stats, current: current({ 0: 32978, 3: 100, 10: 33500 }) } };
    const other = { ...product, asin: "B0OTHER", eanList: ["4902370550733"], stats: { current: current({ 3: 1 }) } };
    const result = await lookupKeepa(JAN, "k", vi.fn<typeof fetch>(async () => json({ products: [other, amazonSells] })));
    expect(result.product).toMatchObject({ asin: "B0TEST0001", amazonSelling: true, lowestFbaPriceJpy: 32978 });
    expect(result.offers[0]).toMatchObject({ shopName: "Amazon.co.jp", priceJpy: 32978 });
    expect(result.warnings).toContain("Amazon: Amazon 本体が販売しているため、出品してもカートを取りにくい商品です。");
  });

  it("トークン不足・キー違いは、キーや URL を含まない日本語のエラーにする", async () => {
    const tokens = await lookupKeepa(JAN, "secret-key", vi.fn<typeof fetch>(async () => json({ tokensLeft: -3, refillIn: 42000 }, 429))).catch((e) => e);
    expect(tokens).toBeInstanceOf(KeepaApiError);
    expect(tokens.message).toMatch(/トークンが足りません.*約 42 秒後/);
    const bad = await lookupKeepa(JAN, "secret-key", vi.fn<typeof fetch>(async () => json({ error: { type: "invalidKey" } }, 400))).catch((e) => e);
    expect(bad.message).toMatch(/KEEPA_API_KEY/);
    expect(`${tokens.message}${bad.message}`).not.toContain("secret-key");
  });

  it("登録がなければ注意を返す", async () => {
    expect(await lookupKeepa(JAN, "k", vi.fn<typeof fetch>(async () => json({ products: [] })))).toEqual({
      offers: [],
      warnings: ["Amazon: この JAN の商品は登録されていません（Keepa）。"],
    });
  });

  it("キーは前後の空白などを取り除いて読む", () => {
    expect(readKeepaKey({ KEEPA_API_KEY: " abc​ " })).toBe("abc");
    expect(readKeepaKey({})).toBeUndefined();
  });
});
