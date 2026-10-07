import { describe, expect, it, vi } from "vitest";
import { isMultiUnitListing, lookupJan, type LookupDeps } from "./lookup";
import type { RawDomesticOffer } from "./rakuten";

const JAN = "4902370548495";

function raw(o: Partial<RawDomesticOffer> & Pick<RawDomesticOffer, "mall" | "title" | "priceJpy">): RawDomesticOffer {
  return { shipping: "free", pointsJpy: 0, url: `https://example.com/${o.title}`, shopName: "店", searchText: o.title, ...o };
}

const now = () => new Date("2026-10-07T00:00:00Z");

describe("isMultiUnitListing", () => {
  it("複数個セット・まとめ売りを見分ける（型番や「1個」は対象外）", () => {
    for (const t of ["ポケカ BOX 2個セット", "お茶 ×3本", "トイレットペーパー まとめ買い", "ケース販売 24本入り", "3箱セット"]) {
      expect(isMultiUnitListing(t), t).toBe(true);
    }
    for (const t of ["ニンテンドースイッチ 本体", "iPhone 15 Pro Max 256GB", "PS5 1台", "Galaxy Tab S9 x 1", "ボールペン 10本入"]) {
      expect(isMultiUnitListing(t), t).toBe(false);
    }
  });
});

describe("lookupJan", () => {
  it("Yahoo! は janCode が一致、楽天は商品名・説明文に JAN があるものだけを残し、セット売りを除く", async () => {
    const deps: LookupDeps = {
      yahoo: async () => [
        raw({ mall: "yahoo", title: "スイッチ 本体", priceJpy: 30000, jan: JAN, pointsJpy: 300 }),
        raw({ mall: "yahoo", title: "スイッチ 2個セット", priceJpy: 58000, jan: JAN }),
        raw({ mall: "yahoo", title: "スイッチ 保護フィルム", priceJpy: 980, jan: "4902370550733" }),
        raw({ mall: "yahoo", title: "JAN なし", priceJpy: 1000 }),
      ],
      now,
    };
    const rakuten = {
      offers: [
        raw({ mall: "rakuten", title: "スイッチ 本体", priceJpy: 31000, searchText: `スイッチ JAN:${JAN}` }),
        raw({ mall: "rakuten", title: "スイッチ用ケース", priceJpy: 1500, searchText: "対応機種 スイッチ" }),
      ],
    };
    const result = await lookupJan(JAN, rakuten, deps);

    expect(result.offers.yahoo.map((o) => o.title)).toEqual(["スイッチ 本体"]);
    expect(result.offers.rakuten.map((o) => o.title)).toEqual(["スイッチ 本体"]);
    expect(result.offers.amazon).toEqual([]);
    expect(result.excludedSets).toBe(1);
    expect(result.title).toBe("スイッチ 本体");
    // 画面に返す出品には検索用の文章を含めない
    expect(result.offers.rakuten[0]).not.toHaveProperty("searchText");
    expect(result.warnings).toEqual([expect.stringMatching(/^Amazon: SP-API のキー/)]);
    expect(result.fetchedAt).toBe("2026-10-07T00:00:00.000Z");
  });

  it("Amazon の商品名を優先し、Amazon の商品自体がセット商品ならセット表記で除かない", async () => {
    const result = await lookupJan(JAN, { offers: [] }, {
      amazon: async () => ({
        product: { asin: "B0", title: "天然水 500ml×24本 ケース販売", url: "https://www.amazon.co.jp/dp/B0", imageUrl: "https://m.media-amazon.com/a.jpg" },
        offers: [],
        warnings: ["Amazon: テスト"],
      }),
      yahoo: async () => [raw({ mall: "yahoo", title: "天然水 500ml×24本 ケース販売", priceJpy: 2000, jan: JAN })],
      now,
    });
    expect(result.title).toBe("天然水 500ml×24本 ケース販売");
    expect(result.imageUrl).toBe("https://m.media-amazon.com/a.jpg");
    expect(result.offers.yahoo).toHaveLength(1);
    expect(result.excludedSets).toBe(0);
    expect(result.warnings).toEqual(["Amazon: テスト"]);
  });

  it("モールごとの失敗は注意にして、ほかのモールの結果は返す", async () => {
    const result = await lookupJan(JAN, { error: "楽天: アクセスが拒否されました" }, {
      amazon: async () => {
        throw new Error("Amazon: 取得に失敗しました（InvalidInput）。");
      },
      yahoo: async () => {
        throw new Error("secret=xxx を含む内部エラー");
      },
      now,
    });
    expect(result.warnings).toEqual(["Amazon: 取得に失敗しました（InvalidInput）。", "Yahoo!: 取得に失敗しました。", "楽天: アクセスが拒否されました"]);
  });

  it("ブラウザの楽天の結果がなければ、サーバーから楽天を調べる", async () => {
    const rakuten = vi.fn(async () => [raw({ mall: "rakuten", title: "本体", priceJpy: 100, searchText: JAN })]);
    const result = await lookupJan(JAN, undefined, { rakuten, now });
    expect(rakuten).toHaveBeenCalledWith(JAN);
    expect(result.offers.rakuten).toHaveLength(1);
  });

  it("実質（価格＋送料−ポイント）の安い順に並べる", async () => {
    const result = await lookupJan(JAN, { offers: [] }, {
      yahoo: async () => [
        raw({ mall: "yahoo", title: "A", priceJpy: 10000, jan: JAN }),
        raw({ mall: "yahoo", title: "B", priceJpy: 10200, pointsJpy: 1000, jan: JAN }),
      ],
      now,
    });
    expect(result.offers.yahoo.map((o) => o.title)).toEqual(["B", "A"]);
  });
});
