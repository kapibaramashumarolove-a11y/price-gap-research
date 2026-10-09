import { describe, expect, it } from "vitest";
import { configStatus } from "./status";

describe("configStatus", () => {
  it("キーが設定されているかだけを返し、値は返さない", () => {
    const status = configStatus({ RAKUTEN_APP_ID: "secret-app", YAHOO_CLIENT_ID: "secret-yahoo", ANTHROPIC_API_KEY: "secret-ai" });
    expect(status).toEqual({ rakuten: true, yahoo: true, photoAi: true });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(configStatus({})).toEqual({ rakuten: false, yahoo: false, photoAi: false });
  });
});
