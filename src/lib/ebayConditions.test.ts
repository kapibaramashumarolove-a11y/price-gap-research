import { describe, expect, it } from "vitest";
import { conditionLabel, parseConditionIds } from "./ebayConditions";

describe("parseConditionIds", () => {
  it("指定がなければ新品のみ", () => {
    expect(parseConditionIds(null)).toEqual(["1000"]);
    expect(parseConditionIds("  ")).toEqual(["1000"]);
  });

  it("カンマ区切りで複数指定できる（重複は除く）", () => {
    expect(parseConditionIds("1000, 3000,1000")).toEqual(["1000", "3000"]);
  });

  it("all なら絞り込みなし", () => {
    expect(parseConditionIds("ALL")).toEqual([]);
  });

  it("未知の ID があれば null", () => {
    expect(parseConditionIds("1000,9999")).toBeNull();
  });
});

describe("conditionLabel", () => {
  it("ID を画面用の名前にする", () => {
    expect(conditionLabel(["1000"])).toBe("新品");
    expect(conditionLabel([])).toBe("すべての状態");
  });
});
