import { describe, expect, it } from "vitest";
import { applyImportedPresets, CSV_TEMPLATE, decodeCsvBytes, parseCsv, presetsFromCsv, presetsToCsv } from "./presetCsv";

let n = 0;
const newId = () => `id-${++n}`;

describe("parseCsv", () => {
  it("引用符・カンマ・改行・BOM・CRLF を扱う", () => {
    expect(parseCsv('﻿名前,キーワード\r\n"a,b","say ""hi""\nnext"\r\n\r\nc,d\r\n')).toEqual([
      ["名前", "キーワード"],
      ["a,b", 'say "hi"\nnext'],
      ["c", "d"],
    ]);
  });

  it("タブ区切り（スプレッドシートから貼り付け）も読める", () => {
    expect(parseCsv("名前\tキーワード\nNikon F3\tニコン F3")).toEqual([
      ["名前", "キーワード"],
      ["Nikon F3", "ニコン F3"],
    ]);
  });
});

describe("decodeCsvBytes", () => {
  it("UTF-8 と Shift_JIS（Excel の CSV）の両方を読める", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("名前,カメラ"))).toBe("名前,カメラ");
    // 「名前」を Shift_JIS で表したバイト列
    expect(decodeCsvBytes(new Uint8Array([0x96, 0xbc, 0x91, 0x4f]))).toBe("名前");
  });
});

describe("presetsFromCsv", () => {
  it("テンプレートをそのまま読み込める", () => {
    const { presets, errors } = presetsFromCsv(CSV_TEMPLATE, newId);
    expect(errors).toEqual([]);
    expect(presets).toHaveLength(5);
    expect(presets[0]).toMatchObject({
      name: "Nikon F3 ボディ",
      genre: "カメラ",
      kind: "item",
      keyword: "ニコン F3 ボディ",
      ebayKeyword: "Nikon F3 body",
      condition: "used",
      minPriceJpy: 10000,
      internationalShippingJpy: 3000,
    });
    expect(presets[4]).toMatchObject({ kind: "sealed", maxLookups: 15 });
  });

  it("英語の見出し・全角数字・金額のカンマ・JAN のハイフンを受け付ける", () => {
    const csv = 'name,genre,keyword,jan,condition,min_price\nリール,釣具,シマノ ステラ,4969363-043962,used,"１２,０００円"\n';
    const { presets, errors } = presetsFromCsv(csv, newId);
    expect(errors).toEqual([]);
    expect(presets[0]).toMatchObject({ jan: "4969363043962", condition: "used", minPriceJpy: 12000 });
  });

  it("問題のある行は行番号付きのエラーにして、他の行は読み込む", () => {
    const csv = [
      "名前,検索キーワード,eBayキーワード,JAN,状態,種類",
      "OK,BOSS DS-1,Boss DS-1,,中古,",
      ",BOSS DS-1,Boss DS-1,,,",
      "eBayなし,BOSS DS-1,,,,",
      "JAN違い,,,4.52E+12,,",
      "状態違い,BOSS DS-1,Boss DS-1,,ジャンク,",
      "種類違い,BOSS DS-1,Boss DS-1,,,ゲーム",
    ].join("\n");
    const { presets, errors } = presetsFromCsv(csv, newId);
    expect(presets.map((p) => p.name)).toEqual(["OK"]);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(errors[1].message).toMatch(/英語キーワードか JAN/);
    expect(errors[2].message).toMatch(/4\.52E\+12/);
  });

  it("「名前」の列がなければエラー", () => {
    expect(presetsFromCsv("キーワード\nx", newId).errors[0].message).toMatch(/名前/);
  });

  it("書き出した CSV を読み込むと同じ内容に戻る", () => {
    const { presets } = presetsFromCsv(CSV_TEMPLATE, newId);
    const again = presetsFromCsv(presetsToCsv(presets), newId).presets;
    const strip = (p: (typeof presets)[number]) => ({ ...p, id: "" });
    expect(again.map(strip)).toEqual(presets.map(strip));
  });
});

describe("applyImportedPresets", () => {
  const base = [
    { id: "a", name: "BOSS DS-1", kind: "item" as const, keyword: "BOSS DS-1", ngWords: [], ebayKeyword: "Boss DS-1" },
    { id: "b", name: "Nikon F3", kind: "item" as const, keyword: "ニコン F3", ngWords: [], ebayKeyword: "Nikon F3" },
  ];
  const imported = [
    { id: "x", name: "BOSS DS-1", kind: "item" as const, keyword: "BOSS DS-1 日本製", ngWords: [], ebayKeyword: "Boss DS-1 Japan" },
    { id: "y", name: "BOSS SD-1", kind: "item" as const, keyword: "BOSS SD-1", ngWords: [], ebayKeyword: "Boss SD-1" },
  ];

  it("追加: 同じ名前は ID を残して上書きし、新しい名前は末尾に追加", () => {
    expect(applyImportedPresets(base, imported, "merge").map((p) => [p.id, p.name, p.keyword])).toEqual([
      ["a", "BOSS DS-1", "BOSS DS-1 日本製"],
      ["b", "Nikon F3", "ニコン F3"],
      ["y", "BOSS SD-1", "BOSS SD-1"],
    ]);
  });

  it("置き換え: 読み込んだ内容だけにする", () => {
    expect(applyImportedPresets(base, imported, "replace").map((p) => p.id)).toEqual(["x", "y"]);
  });
});
