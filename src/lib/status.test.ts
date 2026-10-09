import { describe, expect, it } from "vitest";
import { configStatus } from "./status";

describe("configStatus", () => {
  it("キーが設定されているかだけを返し、値は返さない", () => {
    const status = configStatus({ RAKUTEN_APP_ID: "secret-app", YAHOO_CLIENT_ID: "secret-yahoo" });
    expect(status).toEqual({ rakuten: true, yahoo: true });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(configStatus({})).toEqual({ rakuten: false, yahoo: false });
  });
});
