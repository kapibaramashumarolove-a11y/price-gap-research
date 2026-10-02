import { describe, expect, it, vi } from "vitest";
import { DomesticApiError, searchRakuten, searchYahoo } from "./domestic";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const params = { kind: "sealed" as const, keyword: "テラスタルフェス BOX", minPriceJpy: 3000 };

describe("searchRakuten", () => {
  it("従来の API を呼び、送料込み/送料別を読み取る", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        Items: [
          {
            itemName: "テラスタルフェスex BOX シュリンク付き",
            itemPrice: 19800,
            itemUrl: "https://item.rakuten.co.jp/shop/a/",
            affiliateUrl: "",
            shopName: "ショップA",
            itemCaption: "JAN:4521329362342",
            postageFlag: 0,
            mediumImageUrls: ["https://thumbnail.image.rakuten.co.jp/a.jpg"],
          },
          { itemName: "送料別の商品", itemPrice: 18000, itemUrl: "https://item.rakuten.co.jp/shop/b/", postageFlag: 1 },
        ],
      }),
    );
    const offers = await searchRakuten(params, { RAKUTEN_APP_ID: "app" }, fetchFn as unknown as typeof fetch);

    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601");
    expect(url.searchParams.get("applicationId")).toBe("app");
    expect(url.searchParams.get("keyword")).toBe("テラスタルフェス BOX");
    expect(url.searchParams.get("minPrice")).toBe("3000");
    expect(url.searchParams.get("accessKey")).toBeNull();

    expect(offers[0]).toMatchObject({
      source: "rakuten",
      priceJpy: 19800,
      shipping: "free",
      url: "https://item.rakuten.co.jp/shop/a/",
      imageUrl: "https://thumbnail.image.rakuten.co.jp/a.jpg",
    });
    expect(offers[0].searchText).toContain("4521329362342");
    expect(offers[1].shipping).toBe("extra");
  });

  it("RAKUTEN_ACCESS_KEY があれば新しい API を使う", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ Items: [] }));
    await searchRakuten(params, { RAKUTEN_APP_ID: "app", RAKUTEN_ACCESS_KEY: "key" }, fetchFn as unknown as typeof fetch);
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.host).toBe("openapi.rakuten.co.jp");
    expect(url.searchParams.get("accessKey")).toBe("key");
  });

  it("0 件（404 not_found）は空配列、それ以外のエラーは日本語のエラー", async () => {
    const notFound = vi.fn<typeof fetch>(async () => jsonResponse({ error: "not_found", error_description: "not found" }, 404));
    expect(await searchRakuten(params, { RAKUTEN_APP_ID: "app" }, notFound as unknown as typeof fetch)).toEqual([]);

    const bad = vi.fn<typeof fetch>(async () => jsonResponse({ error: "wrong_parameter", error_description: "specify valid applicationId" }, 400));
    await expect(searchRakuten(params, { RAKUTEN_APP_ID: "app" }, bad as unknown as typeof fetch)).rejects.toThrow(
      /楽天: 検索に失敗しました（specify valid applicationId）/,
    );
  });

  it("キー未設定ならエラー", async () => {
    await expect(searchRakuten(params, {}, vi.fn())).rejects.toBeInstanceOf(DomesticApiError);
  });
});

describe("searchYahoo", () => {
  it("JAN・送料・HTML の文字参照を読み取る", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        hits: [
          {
            name: "ポケモンカードゲーム テラスタルフェスex BOX スカーレット&amp;バイオレット",
            url: "https://store.shopping.yahoo.co.jp/s/a.html",
            price: 19180,
            janCode: "4521329362342",
            image: { medium: "https://item-shopping.c.yimg.jp/i/g/a" },
            seller: { name: "ストアA" },
            shipping: { code: 2, name: "送料無料" },
          },
          { name: "条件付き送料無料", url: "https://store.shopping.yahoo.co.jp/s/b.html", price: 12700, janCode: "", shipping: { code: 3 } },
        ],
      }),
    );
    const offers = await searchYahoo(params, { YAHOO_CLIENT_ID: "cid" }, fetchFn as unknown as typeof fetch);

    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.searchParams.get("appid")).toBe("cid");
    expect(url.searchParams.get("condition")).toBe("new");
    expect(url.searchParams.get("price_from")).toBe("3000");

    expect(offers[0]).toMatchObject({
      source: "yahoo",
      title: "ポケモンカードゲーム テラスタルフェスex BOX スカーレット&バイオレット",
      shipping: "free",
      jan: "4521329362342",
      shopName: "ストアA",
    });
    expect(offers[1]).toMatchObject({ shipping: "unknown", jan: undefined });
  });

  it("カードは中古扱いの出品も含める", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ hits: [] }));
    await searchYahoo({ ...params, kind: "psa10" }, { YAHOO_CLIENT_ID: "cid" }, fetchFn as unknown as typeof fetch);
    expect(new URL(String(fetchFn.mock.calls[0][0])).searchParams.get("condition")).toBeNull();
  });
});
