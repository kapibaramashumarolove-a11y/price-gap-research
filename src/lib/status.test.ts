import { describe, expect, it } from "vitest";
import { configStatus } from "./status";

describe("configStatus", () => {
  it("キーが設定されているかだけを返し、値は返さない", () => {
    const status = configStatus({ KEEPA_API_KEY: "secret-keepa", YAHOO_CLIENT_ID: "secret-yahoo", VERCEL_ENV: "production" });
    expect(status).toEqual({ keepa: true, spApi: false, rakuten: false, yahoo: true, keepaLikeNames: [], vercelEnv: "production" });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("KEEPA_API_KEY の名前違いを見つける（空白だけの値は未設定扱い）", () => {
    expect(configStatus({ KEEPA_KEY: "x", keepa_api_key: "y", KEEPA_API_KEY: "  ", SEND_KEEPALIVES: "1" })).toMatchObject({
      keepa: false,
      keepaLikeNames: ["KEEPA_KEY", "keepa_api_key"],
    });
  });
});
