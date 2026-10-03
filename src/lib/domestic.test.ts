import { describe, expect, it, vi } from "vitest";
import { DomesticApiError, searchRakuten, searchYahoo } from "./domestic";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const params = { kind: "sealed" as const, keyword: "テラスタルフェス BOX", minPriceJpy: 3000 };

describe("searchRakuten", () => {
  const env = { RAKUTEN_APP_ID: "app", RAKUTEN_ACCESS_KEY: "key" };

  it("新しい API を呼び、アクセスキーと Referer / Origin をヘッダーで送る", async () => {
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
    const offers = await searchRakuten({ ...params, siteOrigin: "https://example.vercel.app" }, env, fetchFn);

    const [input, init] = fetchFn.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701");
    expect(url.searchParams.get("applicationId")).toBe("app");
    expect(url.searchParams.get("accessKey")).toBeNull();
    expect(url.searchParams.get("keyword")).toBe("テラスタルフェス BOX");
    expect(url.searchParams.get("minPrice")).toBe("3000");
    expect(init?.headers).toMatchObject({
      accessKey: "key",
      Referer: "https://example.vercel.app/",
      Origin: "https://example.vercel.app",
    });

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

  it("Vercel では、デプロイごとに変わる URL ではなく本番 URL を送る", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ Items: [] }));
    await searchRakuten(
      { ...params, siteOrigin: "https://price-gap-research-c2i9bcd5a-me.vercel.app" },
      { ...env, VERCEL_PROJECT_PRODUCTION_URL: "price-gap-research-me.vercel.app" },
      fetchFn,
    );
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      Referer: "https://price-gap-research-me.vercel.app/",
      Origin: "https://price-gap-research-me.vercel.app",
    });
  });

  it("RAKUTEN_SITE_URL があれば最優先で Referer / Origin に使う", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ Items: [] }));
    await searchRakuten({ ...params, siteOrigin: "https://preview.vercel.app" }, { ...env, RAKUTEN_SITE_URL: "my-site.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "other.vercel.app" }, fetchFn);
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ Origin: "https://my-site.vercel.app" });
  });

  it("アプリ ID・アクセスキーが未設定ならエラー", async () => {
    await expect(searchRakuten(params, {}, vi.fn())).rejects.toBeInstanceOf(DomesticApiError);
    await expect(searchRakuten(params, { RAKUTEN_APP_ID: "app" }, vi.fn())).rejects.toThrow(/RAKUTEN_ACCESS_KEY が設定されていません/);
  });

  it("0 件（404 not_found）は空配列", async () => {
    const notFound = vi.fn<typeof fetch>(async () => jsonResponse({ error: "not_found", error_description: "not found" }, 404));
    expect(await searchRakuten(params, env, notFound)).toEqual([]);
  });

  it("エラーの種類ごとに直し方を案内する", async () => {
    const fail = (status: number, errorMessage: string) =>
      searchRakuten({ ...params, siteOrigin: "https://example.vercel.app" }, env, vi.fn<typeof fetch>(async () => jsonResponse({ errors: { errorCode: status, errorMessage } }, status)));
    await expect(fail(403, "Invalid Access Key")).rejects.toThrow(/同じアプリのアクセスキー/);
    await expect(fail(400, "API Configuration not found")).rejects.toThrow(/バージョンが使えなくなっています/);
    await expect(fail(400, "specify valid applicationId")).rejects.toThrow(/新しい楽天ウェブサービスで登録したアプリ/);
    await expect(fail(403, "REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING")).rejects.toThrow(/許可されたWebサイト」に https:\/\/example\.vercel\.app/);
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

describe("parseClientRakuten（ブラウザで検索した楽天の結果の検査）", () => {
  it("正しい商品だけを残し、エラーはそのまま渡す", async () => {
    const { parseClientRakuten } = await import("./rakuten");
    expect(parseClientRakuten(undefined)).toBeUndefined();
    expect(parseClientRakuten({ error: "楽天: アクセスが拒否されました" })).toEqual({ error: "楽天: アクセスが拒否されました" });
    const result = parseClientRakuten({
      offers: [
        { title: "BOSS DS-1", priceJpy: 4500, shipping: "free", url: "https://item.rakuten.co.jp/a/", shopName: "A", searchText: "BOSS DS-1" },
        { title: "危ない URL", priceJpy: 1, shipping: "free", url: "javascript:alert(1)" },
        { title: "価格なし", shipping: "free", url: "https://item.rakuten.co.jp/b/" },
        { title: "送料が不正", priceJpy: 1, shipping: "maybe", url: "https://item.rakuten.co.jp/c/" },
      ],
    });
    expect(result).toEqual({
      offers: [
        { source: "rakuten", title: "BOSS DS-1", priceJpy: 4500, shipping: "free", url: "https://item.rakuten.co.jp/a/", shopName: "A", imageUrl: undefined, searchText: "BOSS DS-1" },
      ],
    });
  });
});
