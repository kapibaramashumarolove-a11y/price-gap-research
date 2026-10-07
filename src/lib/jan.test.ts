import { describe, expect, it } from "vitest";
import { containsJan, extractJans, isValidJan, normalizeJan } from "./jan";

describe("isValidJan / normalizeJan", () => {
  it("13 桁・8 桁のチェックデジットを確かめる", () => {
    expect(isValidJan("4902370548495")).toBe(true);
    expect(isValidJan("49123456")).toBe(true);
    expect(isValidJan("4902370548496")).toBe(false);
    expect(isValidJan("490237054849")).toBe(false);
  });

  it("全角・ハイフン・空白を取り除き、空なら undefined・正しくなければ null", () => {
    expect(normalizeJan("４９０２３７０−５４８４９５")).toBe("4902370548495");
    expect(normalizeJan(" 4902370 548495 ")).toBe("4902370548495");
    expect(normalizeJan("")).toBeUndefined();
    expect(normalizeJan(undefined)).toBeUndefined();
    expect(normalizeJan("4902370548496")).toBeNull();
  });
});

describe("extractJans / containsJan", () => {
  it("文章から正しい JAN だけを取り出す（長い数字の一部は JAN とみなさない）", () => {
    expect(extractJans("JAN:4902370548495 型番 12345678901234 / 4902370548495 / 49123456")).toEqual(["4902370548495", "49123456"]);
  });

  it("JAN がそのまま書かれているか（ハイフン区切りも可、前後に数字が続くものは別物）", () => {
    expect(containsJan("【JANコード】4902370-548495", "4902370548495")).toBe(true);
    expect(containsJan("品番 14902370548495", "4902370548495")).toBe(false);
    expect(containsJan("別の商品 4902370550733", "4902370548495")).toBe(false);
    expect(containsJan("JAN 4902370548495 1個", "4902370548495")).toBe(true);
    expect(containsJan("JAN：４９０２３７０５４８４９５", "4902370548495")).toBe(true);
  });
});
