import { describe, expect, it } from "vitest";
import { decodeCsvBytes, janListToCsv, mergeJanItems, parseJanList } from "./janList";

describe("parseJanList", () => {
  it("1 行 1 商品で JAN と商品名（メモ）を読み、見出し・重複・間違いを分ける", () => {
    const result = parseJanList(
      ["JAN,商品名", "4902370548495,ニンテンドースイッチ", "ポケカ BOX 4521329362342", "4902370548495", "4902370548496", "メモだけ 123", "", "49123456"].join("\n"),
    );
    expect(result.items).toEqual([
      { jan: "4902370548495", name: "ニンテンドースイッチ" },
      { jan: "4521329362342", name: "ポケカ BOX" },
      { jan: "49123456" },
    ]);
    expect(result.duplicates).toBe(1);
    expect(result.errors.map((e) => [e.line, e.message])).toEqual([
      [5, "JAN のチェックデジットが違います"],
      [6, "JAN（13 桁・8 桁）が見つかりません"],
    ]);
  });

  it("書き出した CSV をそのまま読み込める", () => {
    const items = [{ jan: "4902370548495", name: "Switch, 有機EL" }, { jan: "49123456" }];
    expect(parseJanList(janListToCsv(items)).items).toEqual([{ jan: "4902370548495", name: "Switch 有機EL" }, { jan: "49123456" }]);
  });

  it("ハイフン区切りの JAN も読む", () => {
    expect(parseJanList("4902-370-548495").items).toEqual([{ jan: "4902370548495" }]);
  });
});

describe("mergeJanItems", () => {
  it("同じ JAN は 1 つにまとめ、新しい商品名があれば上書きする", () => {
    expect(
      mergeJanItems([{ jan: "4902370548495", name: "旧" }, { jan: "49123456", name: "残す" }], [{ jan: "4902370548495", name: "新" }, { jan: "49123456" }]),
    ).toEqual([
      { jan: "4902370548495", name: "新" },
      { jan: "49123456", name: "残す" },
    ]);
  });
});

describe("decodeCsvBytes", () => {
  it("UTF-8（BOM 付き）と Shift_JIS を読む", () => {
    const utf8 = new TextEncoder().encode("﻿JAN,商品名");
    expect(decodeCsvBytes(utf8.buffer as ArrayBuffer)).toBe("JAN,商品名");
    // 「商品」の Shift_JIS
    const sjis = new Uint8Array([0x8f, 0xa4, 0x95, 0x69]);
    expect(decodeCsvBytes(sjis.buffer)).toBe("商品");
  });
});
