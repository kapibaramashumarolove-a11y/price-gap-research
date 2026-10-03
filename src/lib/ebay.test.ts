import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchFilter,
  cleanEnvValue,
  clearTokenCache,
  extractUsdPrices,
  getAppAccessToken,
  readEbayConfig,
  searchEbayListings,
  summarizePrices,
  type EbayConfig,
} from "./ebay";

const config: EbayConfig = {
  environment: "sandbox",
  clientId: "test-client-id",
  clientSecret: "SBX-test-secret",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => clearTokenCache());

describe("cleanEnvValue", () => {
  it("前後の空白と目に見えない文字を取り除く", () => {
    expect(cleanEnvValue("⁠SBX-abc\n")).toBe("SBX-abc");
    expect(cleanEnvValue("﻿ abc​ ")).toBe("abc");
    expect(cleanEnvValue(undefined)).toBe("");
  });
});

describe("readEbayConfig", () => {
  it("未設定なら sandbox を使う", () => {
    expect(readEbayConfig({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "⁠SBX-x" })).toEqual({
      environment: "sandbox",
      clientId: "id",
      clientSecret: "SBX-x",
    });
  });

  it("キーが足りないときは値を含まないエラーを出す", () => {
    expect(() => readEbayConfig({ EBAY_CLIENT_ID: "id" })).toThrow(/EBAY_CLIENT_SECRET/);
  });

  it("EBAY_ENVIRONMENT が不正ならエラー", () => {
    expect(() =>
      readEbayConfig({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "s", EBAY_ENVIRONMENT: "prod" }),
    ).toThrow(/sandbox か production/);
  });
});

describe("summarizePrices", () => {
  it("奇数件の中央値と最安値", () => {
    expect(summarizePrices([30, 10, 20])).toEqual({ count: 3, median: 20, min: 10 });
  });

  it("偶数件は真ん中 2 つの平均", () => {
    expect(summarizePrices([10, 40, 20, 30.01])).toEqual({ count: 4, median: 25.01, min: 10 });
  });

  it("0 件なら null", () => {
    expect(summarizePrices([])).toEqual({ count: 0, median: null, min: null });
  });
});

describe("extractUsdPrices", () => {
  it("USD 以外や数値でない価格は除く", () => {
    expect(
      extractUsdPrices([
        { price: { value: "12.50", currency: "USD" } },
        { price: { value: "9.00", currency: "EUR" } },
        { price: { value: "abc", currency: "USD" } },
        {},
      ]),
    ).toEqual([12.5]);
  });
});

describe("getAppAccessToken", () => {
  it("取得したトークンを期限内は使い回す", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: "tok", expires_in: 7200 }));
    const f = fetchFn as unknown as typeof fetch;
    expect(await getAppAccessToken(config, f, () => 0)).toBe("tok");
    expect(await getAppAccessToken(config, f, () => 1000)).toBe("tok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // 期限（7200 - 60 秒）を過ぎたら取り直す
    await getAppAccessToken(config, f, () => 7140 * 1000 + 1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("認証エラーはわかりやすいメッセージにする", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "invalid_client" }, 401));
    await expect(getAppAccessToken(config, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      /認証に失敗/,
    );
  });
});

describe("searchEbayListings", () => {
  it("トークン取得 → キーワードで検索", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth2/token")) {
        return jsonResponse({ access_token: "tok", expires_in: 7200 });
      }
      return jsonResponse({
        total: 57,
        itemSummaries: [
          { price: { value: "120.00", currency: "USD" } },
          { price: { value: "100.00", currency: "USD" } },
        ],
      });
    });

    const result = await searchEbayListings(
      { q: " Nike Dunk ", conditionIds: ["1000"] },
      config,
      fetchFn as unknown as typeof fetch,
    );
    expect(result.total).toBe(57);
    expect(result.items).toHaveLength(2);

    expect(calls[0].url).toBe("https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    const searchUrl = new URL(calls[1].url);
    expect(searchUrl.origin + searchUrl.pathname).toBe(
      "https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search",
    );
    expect(searchUrl.searchParams.get("q")).toBe("Nike Dunk");
    expect(searchUrl.searchParams.get("gtin")).toBeNull();
    expect(searchUrl.searchParams.get("filter")).toBe(
      "buyingOptions:{FIXED_PRICE},priceCurrency:USD,conditionIds:{1000}",
    );
    expect(calls[1].init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    });
  });

  it("JAN（GTIN）だけでも検索できる", async () => {
    const fetchFn = vi.fn(async (url: string | URL) =>
      String(url).includes("/oauth2/token")
        ? jsonResponse({ access_token: "tok", expires_in: 7200 })
        : jsonResponse({ total: 0, itemSummaries: [] }),
    );
    await searchEbayListings({ gtin: "4521329362342", conditionIds: [] }, config, fetchFn as unknown as typeof fetch);
    const searchUrl = new URL(String(fetchFn.mock.calls[1][0]));
    expect(searchUrl.searchParams.get("gtin")).toBe("4521329362342");
    expect(searchUrl.searchParams.get("q")).toBeNull();
  });

  it("キーワードも JAN もなければエラー", async () => {
    await expect(searchEbayListings({ q: "  ", conditionIds: [] }, config, vi.fn())).rejects.toThrow(/キーワード/);
  });
});

describe("buildSearchFilter", () => {
  it("コンディションを複数指定すると | でつなぐ", () => {
    expect(buildSearchFilter(["1000", "3000"])).toBe(
      "buyingOptions:{FIXED_PRICE},priceCurrency:USD,conditionIds:{1000|3000}",
    );
  });

  it("空配列なら状態で絞り込まない", () => {
    expect(buildSearchFilter([])).toBe("buyingOptions:{FIXED_PRICE},priceCurrency:USD");
  });
});
