import { describe, expect, it, vi } from "vitest";
import { isMultiUnitListing, isUsedListing, lookupJan, type LookupDeps } from "./lookup";
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

describe("isUsedListing", () => {
  const used = (title: string, searchText = title, flag?: boolean) => isUsedListing({ title, searchText, used: flag });

  it("商品名の中古・開封品・訳あり・状態ランクなどを見分ける", () => {
    for (const t of [
      "【中古】ニンテンドースイッチ 本体",
      "Switch 本体 USED",
      "スイッチ 開封済み 未使用品",
      "スイッチ 展示品",
      "訳あり 箱潰れ スイッチ",
      "スイッチ 美品 ランクA",
      "スイッチ Bランク",
      "ジャンク スイッチ",
    ]) {
      expect(used(t), t).toBe(true);
    }
  });

  it("新品の出品は残す（「新品未使用」「無印良品」「UNUSED」などは中古扱いしない）", () => {
    for (const t of ["ニンテンドースイッチ 本体 新品", "新品未使用 スイッチ", "無印良品 収納ケース", "UNUSED パーカー", "スイッチ 送料無料"]) {
      expect(used(t), t).toBe(false);
    }
  });

  it("説明文は、はっきりした中古の表記だけを見る（「中古品ではありません」は新品）", () => {
    expect(used("スイッチ 本体", "【中古】動作確認済み")).toBe(true);
    expect(used("スイッチ 本体", "商品ランク：B 使用感があります")).toBe(true);
    expect(used("スイッチ 本体", "当店の商品は中古品ではありません。メーカー保証付きの新品です")).toBe(false);
    expect(used("スイッチ 本体", "中古買取もお気軽に")).toBe(false);
  });

  it("API で中古と分かる出品（Yahoo! の condition）", () => {
    expect(used("スイッチ 本体", "スイッチ 本体", true)).toBe(true);
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
    expect(result.warnings).toEqual([expect.stringMatching(/KEEPA_API_KEY が見えない/)]);
    expect(result.fetchedAt).toBe("2026-10-07T00:00:00.000Z");
  });

  it("楽天・Yahoo! の中古の出品を除き、数を返す", async () => {
    const result = await lookupJan(
      JAN,
      {
        offers: [
          raw({ mall: "rakuten", title: "スイッチ 本体 新品", priceJpy: 31000, searchText: `JAN:${JAN}` }),
          raw({ mall: "rakuten", title: "【中古】スイッチ 本体", priceJpy: 22000, searchText: `【中古】JAN:${JAN}` }),
          raw({ mall: "rakuten", title: "スイッチ 本体", priceJpy: 23000, searchText: `JAN:${JAN} 商品ランク：A` }),
        ],
      },
      {
        yahoo: async () => [
          raw({ mall: "yahoo", title: "スイッチ 本体", priceJpy: 30000, jan: JAN }),
          raw({ mall: "yahoo", title: "スイッチ 本体", priceJpy: 21000, jan: JAN, used: true }),
        ],
        now,
      },
    );
    expect(result.offers.rakuten.map((o) => o.priceJpy)).toEqual([31000]);
    expect(result.offers.yahoo.map((o) => o.priceJpy)).toEqual([30000]);
    expect(result.excludedUsed).toBe(3);
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

  it("Amazon のデータをキャッシュ用に返す（キャッシュを使ったときは元の取得時刻のまま）", async () => {
    const product = { asin: "B0", title: "x", url: "https://www.amazon.co.jp/dp/B0" };
    const fresh = await lookupJan(JAN, { offers: [] }, { amazon: async () => ({ product, offers: [], warnings: [], fetchedAt: "2026-10-07T00:00:00.000Z" }), now });
    expect(fresh.amazonCache).toEqual({ product, offers: [], fetchedAt: "2026-10-07T00:00:00.000Z" });
    const cached = await lookupJan(JAN, { offers: [] }, { amazon: async () => ({ product, offers: [], warnings: [], fetchedAt: "2026-10-06T00:00:00.000Z", fromCache: true }), now });
    expect(cached).toMatchObject({ amazonFromCache: true, amazonCache: { fetchedAt: "2026-10-06T00:00:00.000Z" } });
    // Amazon を調べられなかったときは返さない
    expect((await lookupJan(JAN, { offers: [] }, { now })).amazonCache).toBeUndefined();
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
