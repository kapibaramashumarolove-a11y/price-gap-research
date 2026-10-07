import { describe, expect, it, vi } from "vitest";
import { historyValueAt, KeepaApiError, keepaMinuteToMs, lookupKeepa, MAX_VARIATIONS_TO_CHECK, readKeepaKey } from "./keepa";

const JAN = "4902370548495";
/** テストの「今」（Keepa 時間で表す） */
const NOW_MIN = 7_500_000;
const NOW_MS = keepaMinuteToMs(NOW_MIN);
const daysAgo = (d: number) => NOW_MIN - d * 24 * 60;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** stats.current（-1 はデータなし） */
function current(values: Record<number, number>): number[] {
  const arr = Array.from({ length: 36 }, () => -1);
  for (const [k, v] of Object.entries(values)) arr[Number(k)] = v;
  return arr;
}

/** csv（履歴）の配列。11 = 新品の出品者数 */
function csvWith(index: number, history: number[]): (number[] | null)[] {
  const arr: (number[] | null)[] = Array.from({ length: 36 }, () => null);
  arr[index] = history;
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
  // 新品出品者数: 20 日前 8 人 → 10 日前 10 人 → 3 日前 16 人
  csv: csvWith(11, [daysAgo(20), 8, daysAgo(10), 10, daysAgo(3), 16]),
  // 1: 新品最安 / 3: ランキング / 7: 自社発送最安（送料込み） / 10: FBA 最安 / 11: 新品の出品者数 / 18: カート
  stats: {
    current: current({ 1: 31000, 3: 152, 7: 31500, 10: 32980, 11: 16, 18: 32980 }),
    avg90: current({ 18: 30500 }),
    outOfStockPercentage90: current({ 0: 85 }),
    salesRankDrops30: 25,
    salesRankDrops90: 70,
    buyBoxIsAmazon: false,
    buyBoxIsFBA: false,
    buyBoxStats: { AN1VRQENFRJN5: { percentageWon: 12.5, isFBA: true }, SELLER2: { percentageWon: 80, isFBA: false } },
  },
};

describe("historyValueAt", () => {
  it("履歴から、指定した時刻の時点の値を読む", () => {
    const h = [daysAgo(20), 8, daysAgo(10), 10, daysAgo(3), 16];
    expect(historyValueAt(h, keepaMinuteToMs(daysAgo(7)))).toBe(10);
    expect(historyValueAt(h, keepaMinuteToMs(daysAgo(14)))).toBe(8);
    expect(historyValueAt(h, keepaMinuteToMs(daysAgo(30)))).toBeUndefined();
    expect(historyValueAt(null, NOW_MS)).toBeUndefined();
  });
});

describe("lookupKeepa", () => {
  it("JAN で調べ、価格・90 日平均・販売数・手数料・出品者数の推移・Amazon 本体のカート獲得率を読み取る", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ products: [product], tokensLeft: 100 }));
    const result = await lookupKeepa(JAN, "secret-key", fetchFn, () => NOW_MS);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.keepa.com/product");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ domain: "5", code: JAN, stats: "90", history: "1", days: "15", buybox: "1" });

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
      buyBoxAvg90Jpy: 30500,
      lowestFbaPriceJpy: 32980,
      lowestPriceJpy: 31000,
      offerCount: 16,
      offerCount7dAgo: 10,
      offerCount14dAgo: 8,
      amazonSelling: false,
      amazonBuyBoxShare90: 12.5,
      amazonOutOfStock90: 85,
      buyBoxIsFba: false,
      referralFeePercent: 10,
      fbaPickAndPackJpy: 514,
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

  it("Amazon 本体が販売中なら amazonSelling、別の JAN の商品は使わない", async () => {
    const amazonSells = { ...product, stats: { ...product.stats, current: current({ 0: 32978, 3: 100, 10: 33500 }) } };
    const other = { ...product, asin: "B0OTHER", eanList: ["4902370550733"], stats: { current: current({ 3: 1 }) } };
    const result = await lookupKeepa(JAN, "k", vi.fn<typeof fetch>(async () => json({ products: [other, amazonSells] })), () => NOW_MS);
    expect(result.product).toMatchObject({ asin: "B0TEST0001", amazonSelling: true, lowestFbaPriceJpy: 32978 });
    expect(result.offers[0]).toMatchObject({ shopName: "Amazon.co.jp", priceJpy: 32978 });
  });

  it("バリエーション商品は、親 ASIN → 兄弟 ASIN を調べて購入数のシェアを出す", async () => {
    const child = { ...product, parentAsin: "B0PARENT" };
    const parent = { asin: "B0PARENT", variations: [{ asin: "B0TEST0001" }, { asin: "B0RED" }, { asin: "B0BLUE" }] };
    const siblings = [
      { asin: "B0TEST0001", monthlySold: 50 },
      { asin: "B0RED", monthlySold: 400 },
      { asin: "B0BLUE", monthlySold: 550 },
    ];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const params = new URL(String(input)).searchParams;
      if (params.get("code")) return json({ products: [child] });
      if (params.get("asin") === "B0PARENT") return json({ products: [parent] });
      return json({ products: siblings });
    });
    const result = await lookupKeepa(JAN, "k", fetchFn, () => NOW_MS);
    expect(result.product).toMatchObject({ variationCount: 3, variationSharePercent: 5, variationShareBasis: "sold" });
    expect(new URL(String(fetchFn.mock.calls[2][0])).searchParams.get("asin")).toBe("B0TEST0001,B0RED,B0BLUE");
  });

  it("バリエーションが多すぎるときは兄弟を調べない（トークン節約）", async () => {
    const child = { ...product, parentAsin: "B0PARENT" };
    const many = Array.from({ length: MAX_VARIATIONS_TO_CHECK + 5 }, (_, i) => ({ asin: `B0V${i}` }));
    const fetchFn = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).searchParams.get("code") ? json({ products: [child] }) : json({ products: [{ asin: "B0PARENT", variations: many }] }),
    );
    const result = await lookupKeepa(JAN, "k", fetchFn, () => NOW_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.product).toMatchObject({ variationCount: MAX_VARIATIONS_TO_CHECK + 5 });
    expect(result.product?.variationSharePercent).toBeUndefined();
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
