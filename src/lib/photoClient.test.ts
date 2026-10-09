import { describe, expect, it } from "vitest";
import { toJan } from "./photoClient";

describe("toJan", () => {
  it("バーコードの数字が JAN なら返す（UPC-A は先頭に 0 を付けて EAN-13 に）", () => {
    expect(toJan("4902370548495")).toBe("4902370548495");
    expect(toJan("49123456")).toBe("49123456");
    expect(toJan("036000291452")).toBe("0036000291452");
    expect(toJan("4902370548496")).toBeUndefined();
    expect(toJan(undefined)).toBeUndefined();
  });
});
