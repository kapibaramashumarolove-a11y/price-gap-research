import { beforeEach, describe, expect, it, vi } from "vitest";
import { categoryPattern } from "./discovery";
import { discoverYahooRanking, resetYahooCategoryCache, yahooPoints } from "./domestic";
import { buildRakutenHighPointUrl } from "./rakuten";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  resetYahooCategoryCache();
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
