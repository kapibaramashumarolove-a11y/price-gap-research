import { describe, expect, it } from "vitest";
import { canonicalRedirectUrl } from "./canonicalHost";

const env = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "price-gap-research-me.vercel.app" };
const deployHost = "price-gap-research-86nf2ix1j-me.vercel.app";
// サーバーの中では URL のホストがサーバー自身の名前になることがある
const deployUrl = new URL("http://localhost:3000/research?x=1");

describe("canonicalRedirectUrl", () => {
  it("本番のデプロイごとの URL は、変わらない本番 URL へ移す（パスはそのまま）", () => {
    expect(canonicalRedirectUrl(deployHost, deployUrl, "GET", env)?.toString()).toBe("https://price-gap-research-me.vercel.app/research?x=1");
  });

  it("本番 URL・プレビュー・開発環境・GET 以外では移さない", () => {
    expect(canonicalRedirectUrl("price-gap-research-me.vercel.app", deployUrl, "GET", env)).toBeUndefined();
    expect(canonicalRedirectUrl("Price-Gap-Research-Me.vercel.app, proxy", deployUrl, "GET", env)).toBeUndefined();
    expect(canonicalRedirectUrl(deployHost, deployUrl, "GET", { ...env, VERCEL_ENV: "preview" })).toBeUndefined();
    expect(canonicalRedirectUrl("localhost:3000", deployUrl, "GET", {})).toBeUndefined();
    expect(canonicalRedirectUrl(deployHost, deployUrl, "POST", env)).toBeUndefined();
    expect(canonicalRedirectUrl(null, deployUrl, "GET", env)).toBeUndefined();
  });
});
