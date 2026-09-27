import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanEnvValue,
  clearTokenCache,
  extractUsdPrices,
  getAppAccessToken,
  readEbayConfig,
  searchActiveListingPrices,
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

describe("searchActiveListingPrices", () => {
  it("トークン取得 → 検索 → 集計の流れ", async () => {
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
          { price: { value: "150.00", currency: "USD" } },
        ],
      });
    });

    const result = await searchActiveListingPrices(
      " Nike Dunk ",
      config,
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toMatchObject({
      query: "Nike Dunk",
      environment: "sandbox",
      total: 57,
      count: 3,
      median: 120,
      min: 100,
    });

    expect(calls[0].url).toBe("https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    const searchUrl = new URL(calls[1].url);
    expect(searchUrl.origin + searchUrl.pathname).toBe(
      "https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search",
    );
    expect(searchUrl.searchParams.get("q")).toBe("Nike Dunk");
    expect(searchUrl.searchParams.get("filter")).toBe(
      "buyingOptions:{FIXED_PRICE},priceCurrency:USD",
    );
    expect(calls[1].init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    });
  });

  it("空のキーワードはエラー", async () => {
    await expect(searchActiveListingPrices("  ", config, vi.fn())).rejects.toThrow(/キーワード/);
  });
});
