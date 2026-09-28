import { describe, expect, it } from "vitest";
import {
  clearFailures,
  getAuthMode,
  isAuthenticated,
  isCorrectPassword,
  isLockedOut,
  recordFailure,
  safeNextPath,
  sessionToken,
} from "./auth";

const prod = (APP_PASSWORD?: string) => ({ NODE_ENV: "production", APP_PASSWORD });

describe("getAuthMode", () => {
  it("合言葉があればログイン必須", () => {
    expect(getAuthMode(prod("secret"))).toBe("enabled");
  });

  it("合言葉なしの本番は使えない状態にする", () => {
    expect(getAuthMode(prod(undefined))).toBe("misconfigured");
    expect(getAuthMode(prod("   "))).toBe("misconfigured");
  });

  it("合言葉なしの開発環境はログイン不要", () => {
    expect(getAuthMode({ NODE_ENV: "development" })).toBe("disabled");
  });
});

describe("isAuthenticated", () => {
  it("正しい Cookie ならログイン済み", () => {
    expect(isAuthenticated(sessionToken("secret"), prod("secret"))).toBe(true);
  });

  it("Cookie がない・ちがう・合言葉が変わった場合は未ログイン", () => {
    expect(isAuthenticated(undefined, prod("secret"))).toBe(false);
    expect(isAuthenticated("secret", prod("secret"))).toBe(false);
    expect(isAuthenticated(sessionToken("old"), prod("secret"))).toBe(false);
  });

  it("合言葉なしの本番では誰もログインできない", () => {
    expect(isAuthenticated(sessionToken(""), prod(undefined))).toBe(false);
  });

  it("開発環境で合言葉なしなら常に通す", () => {
    expect(isAuthenticated(undefined, { NODE_ENV: "development" })).toBe(true);
  });
});

describe("isCorrectPassword", () => {
  it("一致したときだけ true", () => {
    expect(isCorrectPassword("secret", "secret")).toBe(true);
    expect(isCorrectPassword("Secret", "secret")).toBe(false);
    expect(isCorrectPassword("", "")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("サイト内のパスだけ許可する", () => {
    expect(safeNextPath("/api/ebay/search?q=x")).toBe("/api/ebay/search?q=x");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});

describe("ログイン失敗の制限", () => {
  it("5 回まちがえると 15 分ロックし、時間がたてば解除", () => {
    const key = "test-client";
    clearFailures(key);
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailure(key, t0);
    expect(isLockedOut(key, t0)).toBe(false);
    recordFailure(key, t0);
    expect(isLockedOut(key, t0)).toBe(true);
    expect(isLockedOut(key, t0 + 16 * 60 * 1000)).toBe(false);
  });
});
