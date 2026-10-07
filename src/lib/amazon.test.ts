import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmazonApiError, lookupAmazon, parseOffers, readAmazonCredentials, resetAmazonState } from "./amazon";

const creds = { clientId: "cid", clientSecret: "secret", refreshToken: "Atzr|token" };
const JAN = "4902370548495";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const catalog = {
  items: [
    {
      asin: "B0TEST0001",
      identifiers: [{ marketplaceId: "A1VC38T7YXB528", identifiers: [{ identifierType: "EAN", identifier: JAN }] }],
      summaries: [{ marketplaceId: "A1VC38T7YXB528", itemName: "ニンテンドースイッチ 本体" }],
      images: [
        {
          marketplaceId: "A1VC38T7YXB528",
          images: [
            { variant: "MAIN", link: "https://m.media-amazon.com/images/I/big.jpg", height: 1000 },
            { variant: "MAIN", link: "https://m.media-amazon.com/images/I/small.jpg", height: 160 },
          ],
        },
      ],
      salesRanks: [{ marketplaceId: "A1VC38T7YXB528", displayGroupRanks: [{ title: "ゲーム", rank: 120 }] }],
    },
    {
      // 別の JAN が登録された商品（検索に紛れても除く）
      asin: "B0OTHER001",
      identifiers: [{ marketplaceId: "A1VC38T7YXB528", identifiers: [{ identifierType: "EAN", identifier: "4902370550733" }] }],
      salesRanks: [{ marketplaceId: "A1VC38T7YXB528", displayGroupRanks: [{ title: "ゲーム", rank: 1 }] }],
    },
  ],
};

const offersPayload = {
  payload: {
    status: "Success",
    Summary: {
      TotalOfferCount: 3,
      NumberOfOffers: [
        { condition: "new", fulfillmentChannel: "Amazon", OfferCount: 2 },
        { condition: "new", fulfillmentChannel: "Merchant", OfferCount: 1 },
        { condition: "used", fulfillmentChannel: "Merchant", OfferCount: 5 },
      ],
      LowestPrices: [
        { condition: "new", fulfillmentChannel: "Amazon", LandedPrice: { CurrencyCode: "JPY", Amount: 32978 } },
        { condition: "new", fulfillmentChannel: "Merchant", LandedPrice: { CurrencyCode: "JPY", Amount: 31500 } },
        { condition: "used", fulfillmentChannel: "Merchant", LandedPrice: { CurrencyCode: "JPY", Amount: 20000 } },
      ],
      BuyBoxPrices: [{ condition: "New", LandedPrice: { CurrencyCode: "JPY", Amount: 32978 } }],
    },
    Offers: [
      {
        SellerId: "AN1VRQENFRJN5",
        ListingPrice: { CurrencyCode: "JPY", Amount: 32978 },
        Shipping: { CurrencyCode: "JPY", Amount: 0 },
        Points: { PointsNumber: 330 },
        IsFulfilledByAmazon: true,
        IsBuyBoxWinner: true,
      },
      {
        SellerId: "SELLER2",
        ListingPrice: { CurrencyCode: "JPY", Amount: 30500 },
        Shipping: { CurrencyCode: "JPY", Amount: 1000 },
        IsFulfilledByAmazon: false,
      },
    ],
  },
};

const fees = { payload: { FeesEstimateResult: { Status: "Success", FeesEstimate: { TotalFeesEstimate: { CurrencyCode: "JPY", Amount: 3900 } } } } };

function mockFetch(overrides: { offers?: () => Response; token?: () => Response } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.amazon.com/auth/o2/token")) return overrides.token?.() ?? json({ access_token: "Atza|access", expires_in: 3600 });
    if (url.includes("/catalog/2022-04-01/items")) return json(catalog);
    if (url.includes("/offers")) return overrides.offers?.() ?? json(offersPayload);
    if (url.includes("/feesEstimate")) return json(fees);
    return json({}, 404);
  });
}

const noWait = { sleep: async () => {}, now: () => 0 };

beforeEach(() => resetAmazonState());

describe("readAmazonCredentials", () => {
  it("3 つそろっていなければ undefined", () => {
    expect(readAmazonCredentials({ AMAZON_SP_CLIENT_ID: "a", AMAZON_SP_CLIENT_SECRET: "b" })).toBeUndefined();
    expect(readAmazonCredentials({ AMAZON_SP_CLIENT_ID: " a ", AMAZON_SP_CLIENT_SECRET: "b", AMAZON_SP_REFRESH_TOKEN: "c​" })).toEqual({
      clientId: "a",
      clientSecret: "b",
      refreshToken: "c",
    });
  });
});

describe("lookupAmazon", () => {
  it("JAN → ASIN → 新品の出品 → FBA 手数料の順に調べる", async () => {
    const fetchFn = mockFetch();
    const result = await lookupAmazon(JAN, creds, { fetchFn, ...noWait });

    expect(result.product).toMatchObject({
      asin: "B0TEST0001",
      title: "ニンテンドースイッチ 本体",
      imageUrl: "https://m.media-amazon.com/images/I/small.jpg",
      salesRank: 120,
      salesRankCategory: "ゲーム",
      lowestFbaPriceJpy: 32978,
      lowestPriceJpy: 31500,
      buyBoxPriceJpy: 32978,
      offerCount: 3,
      fbaFeesJpy: 3900,
      feesForPriceJpy: 32978,
      url: "https://www.amazon.co.jp/dp/B0TEST0001",
    });
    // 送料込みの安い順
    expect(result.offers[0]).toMatchObject({ priceJpy: 30500, shipping: "extra", shippingJpy: 1000, pointsJpy: 0, fba: false });
    expect(result.offers[1]).toMatchObject({ mall: "amazon", priceJpy: 32978, shipping: "free", pointsJpy: 330, fba: true });
    expect(result.offers[1].shopName).toContain("Amazon.co.jp");
    expect(result.warnings).toEqual([]);

    const calls = fetchFn.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), init }));
    const catalogCall = calls.find((c) => c.url.pathname === "/catalog/2022-04-01/items")!;
    expect(catalogCall.url.origin).toBe("https://sellingpartnerapi-fe.amazon.com");
    expect(catalogCall.url.searchParams.get("identifiers")).toBe(JAN);
    expect(catalogCall.url.searchParams.get("identifiersType")).toBe("JAN");
    expect(catalogCall.url.searchParams.get("marketplaceIds")).toBe("A1VC38T7YXB528");
    expect(catalogCall.init?.headers).toMatchObject({ "x-amz-access-token": "Atza|access" });
    // 別の JAN の商品（B0OTHER001）は使わない
    expect(calls.some((c) => c.url.pathname.includes("B0OTHER001"))).toBe(false);
    const offersCall = calls.find((c) => c.url.pathname.endsWith("/offers"))!;
    expect(offersCall.url.searchParams.get("ItemCondition")).toBe("New");
    const feesCall = calls.find((c) => c.url.pathname.endsWith("/feesEstimate"))!;
    expect(JSON.parse(String(feesCall.init?.body)).FeesEstimateRequest).toMatchObject({
      MarketplaceId: "A1VC38T7YXB528",
      IsAmazonFulfilled: true,
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: "JPY", Amount: 32978 } },
    });
    // キーは URL に載せない
    expect(calls.every((c) => !c.url.search.includes("secret") && !c.url.search.includes("Atz"))).toBe(true);
  });

  it("アクセストークンは使い回す", async () => {
    const fetchFn = mockFetch();
    await lookupAmazon(JAN, creds, { fetchFn, ...noWait });
    await lookupAmazon(JAN, creds, { fetchFn, ...noWait });
    expect(fetchFn.mock.calls.filter(([u]) => String(u).includes("/auth/o2/token"))).toHaveLength(1);
  });

  it("上限超え（429）は 1 回だけ待ってやり直す", async () => {
    let n = 0;
    const sleep = vi.fn(async () => {});
    const fetchFn = mockFetch({ offers: () => (n++ === 0 ? json({ errors: [{ code: "QuotaExceeded" }] }, 429) : json(offersPayload)) });
    const result = await lookupAmazon(JAN, creds, { fetchFn, sleep, now: () => 0 });
    expect(result.product?.lowestFbaPriceJpy).toBe(32978);
    expect(n).toBe(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("認証の失敗は、キーの値を含まない日本語のエラーにする", async () => {
    const fetchFn = mockFetch({ token: () => json({ error: "invalid_client", error_description: "Client authentication failed" }, 401) });
    const err = await lookupAmazon(JAN, creds, { fetchFn, ...noWait }).catch((e) => e);
    expect(err).toBeInstanceOf(AmazonApiError);
    expect(err.message).toMatch(/アクセストークンを取得できませんでした（invalid_client/);
    expect(err.message).not.toContain("secret");
  });

  it("Amazon に登録がなければ注意を返す", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/auth/") ? json({ access_token: "a", expires_in: 3600 }) : json({ items: [] }),
    );
    expect(await lookupAmazon(JAN, creds, { fetchFn, ...noWait })).toEqual({ offers: [], warnings: ["Amazon: この JAN の商品は登録されていません。"] });
  });
});

describe("parseOffers", () => {
  it("出品がなければ価格は undefined", () => {
    expect(parseOffers("B0", "x", { status: "NoBuyableOffers", Summary: { TotalOfferCount: 0 }, Offers: [] })).toEqual({
      prices: { lowestFbaPriceJpy: undefined, lowestPriceJpy: undefined, buyBoxPriceJpy: undefined, offerCount: 0 },
      offers: [],
    });
  });
});
