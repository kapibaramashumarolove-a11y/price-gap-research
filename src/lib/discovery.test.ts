import { beforeEach, describe, expect, it, vi } from "vitest";
import { categoryPattern } from "./discovery";
import { discoverYahooRanking, resetYahooCategoryCache, yahooPoints } from "./domestic";
import { discoverKeepa, resetKeepaCategoryCache } from "./keepa";
import { buildRakutenHighPointUrl } from "./rakuten";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  resetKeepaCategoryCache();
  resetYahooCategoryCache();
});

describe("discoverKeepa（Product Finder）", () => {
  it("カテゴリ名からトップカテゴリを選び、条件で ASIN を探して、100 件ずつまとめて JAN に変える", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/category") {
        return json({ categories: { "3210981": { catId: 3210981, name: "家電&カメラ" }, "13299531": { catId: 13299531, name: "おもちゃ" } } });
      }
      if (url.pathname === "/query") return json({ asinList: ["B01", "B02", "B03"], tokensLeft: 80 });
      return json({
        tokensLeft: 77,
        products: [
          { asin: "B01", title: "掃除機", eanList: ["4902370548495"] },
          { asin: "B02", title: "JAN なし" },
          { asin: "B03", title: "ドライヤー", eanList: ["4521329362342"] },
        ],
      });
    });
    const result = await discoverKeepa(categoryPattern("electronics", "amazon"), 20, "secret", undefined, fetchFn);

    expect(result.items.map((i) => [i.jan, i.title])).toEqual([
      ["4902370548495", "掃除機"],
      ["4521329362342", "ドライヤー"],
    ]);
    expect(result.tokensLeft).toBe(77);

    const query = new URL(String(fetchFn.mock.calls.find(([u]) => String(u).includes("/query"))![0]));
    expect(query.searchParams.get("domain")).toBe("5");
    const selection = JSON.parse(query.searchParams.get("selection")!);
    expect(selection).toMatchObject({
      rootCategory: ["3210981"],
      current_SALES_lte: 50000,
      current_COUNT_NEW_gte: 2,
      current_COUNT_NEW_lte: 10,
      availabilityAmazon: [-1],
      sort: [["current_SALES", "asc"]],
    });
    const products = new URL(String(fetchFn.mock.calls.find(([u]) => String(u).includes("/product"))![0]));
    expect(products.searchParams.get("asin")).toBe("B01,B02,B03");
    expect(products.searchParams.get("history")).toBe("0");
  });

  it("「すべて」ならカテゴリを指定しない（カテゴリ一覧も取得しない）", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => (String(input).includes("/query") ? json({ asinList: [] }) : json({})));
    const result = await discoverKeepa(categoryPattern("all", "amazon"), 20, "k", undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(new URL(String(fetchFn.mock.calls[0][0])).searchParams.get("selection")!).rootCategory).toBeUndefined();
    expect(result.items).toEqual([]);
  });
});

describe("discoverYahooRanking", () => {
  it("カテゴリ名で Yahoo! のカテゴリ ID を選び、ランキングから JAN つきの商品を集める", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("categorySearch")) {
        return json({
          ResultSet: {
            "0": { Result: { Categories: { Children: { "0": { Id: "2505", Title: { Short: "家電" } }, "1": { Id: "2498", Title: { Short: "食品" } }, _container: "Child" } } } },
          },
        });
      }
      return json({
        high_rating_trend_ranking: {
          ranking_data: [
            { rank: 1, item_information: { name: "電気ケトル", jan_code: "4902370548495", bargain_price: 3980 }, image: { medium: "https://item-shopping.c.yimg.jp/a.jpg" } },
            { rank: 2, item_information: { name: "JAN なし", jan_code: "" } },
            { rank: 3, item_information: { name: "同じ JAN", jan_code: "4902370548495" } },
          ],
        },
      });
    });
    const result = await discoverYahooRanking(categoryPattern("electronics", "yahoo"), 20, { YAHOO_CLIENT_ID: "cid" }, fetchFn);
    expect(result.items).toEqual([
      { jan: "4902370548495", title: "電気ケトル", imageUrl: "https://item-shopping.c.yimg.jp/a.jpg", priceJpy: 3980, note: "Yahoo!ランキング 1位" },
    ]);
    const ranking = new URL(String(fetchFn.mock.calls[1][0]));
    expect(ranking.searchParams.get("genre_category_id")).toBe("2505");
    expect(ranking.searchParams.get("appid")).toBe("cid");
  });
});

describe("yahooPoints", () => {
  it("2025 年 2 月からのストアポイント（lyLimitedBonusAmount）を使う", () => {
    expect(yahooPoints({ amount: 0, bonusAmount: 0, lyLimitedBonusAmount: 450 })).toBe(450);
    // 古いデータ
    expect(yahooPoints({ amount: 100, bonusAmount: 300 })).toBe(400);
    expect(yahooPoints(undefined)).toBe(0);
  });
});

describe("buildRakutenHighPointUrl", () => {
  it("ポイント倍率で絞った在庫ありの商品を、ジャンル指定で検索する（アクセスキーは URL に載せない）", () => {
    const url = buildRakutenHighPointUrl({ genreId: "562637", minPointRate: 5, page: 2 }, { appId: "app" });
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      applicationId: "app",
      genreId: "562637",
      pointRateFlag: "1",
      pointRate: "5",
      availability: "1",
      page: "2",
    });
    expect(url.searchParams.get("accessKey")).toBeNull();
    expect(buildRakutenHighPointUrl({ genreId: "0", minPointRate: 50, page: 1 }, { appId: "a" }).searchParams.get("pointRate")).toBe("10");
  });
});
