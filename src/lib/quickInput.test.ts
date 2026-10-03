import { describe, expect, it } from "vitest";
import { deriveEbayKeyword, parseQuickInput } from "./quickInput";

let n = 0;
const newId = () => `q-${++n}`;

describe("deriveEbayKeyword", () => {
  it("英語・型番だけならそのまま", () => {
    expect(deriveEbayKeyword("BOSS DS-1")).toBe("BOSS DS-1");
    expect(deriveEbayKeyword("Ｎｉｋｏｎ　Ｆ３")).toBe("Nikon F3");
  });

  it("日本語まじりは型番があれば英数字だけを使う", () => {
    expect(deriveEbayKeyword("キヤノン AE-1")).toBe("AE-1");
    expect(deriveEbayKeyword("シマノ 22ステラ C3000XG")).toBe("C3000XG");
  });

  it("型番らしい単語がなければ決めない", () => {
    expect(deriveEbayKeyword("ニコン F3 ボディ")).toBeUndefined();
    expect(deriveEbayKeyword("ゼルダの伝説 神々のトライフォース")).toBeUndefined();
  });
});

describe("parseQuickInput", () => {
  it("1 行 1 商品で、型番・| 区切り・JAN の書き方を読み、空行は飛ばす", () => {
    const lines = parseQuickInput(
      "BOSS DS-1\n\nニコン F3 ボディ | Nikon F3 body\n4521329362342\nキヤノン AE-1",
      { condition: "used", genre: "カメラ" },
      newId,
    );
    expect(lines.map((l) => [l.line, l.error])).toEqual([
      [1, undefined],
      [3, undefined],
      [4, undefined],
      [5, undefined],
    ]);
    expect(lines.map((l) => l.preset && [l.preset.name, l.preset.keyword, l.preset.ebayKeyword, l.preset.jan])).toEqual([
      ["BOSS DS-1", "BOSS DS-1", "BOSS DS-1", undefined],
      ["ニコン F3 ボディ", "ニコン F3 ボディ", "Nikon F3 body", undefined],
      ["JAN 4521329362342", "", undefined, "4521329362342"],
      ["キヤノン AE-1", "キヤノン AE-1", "AE-1", undefined],
    ]);
    expect(lines[0].preset).toMatchObject({ kind: "item", condition: "used", genre: "カメラ" });
  });

  it("英語のキーワードが決められない行・JAN の誤りはエラー", () => {
    const lines = parseQuickInput("ニコン F3 ボディ\n4521329362343", { condition: "new" }, newId);
    expect(lines[0].error).toMatch(/\| の後に英語/);
    expect(lines[1].error).toMatch(/JAN/);
  });
});
