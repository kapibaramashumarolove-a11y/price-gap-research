import { describe, expect, it } from "vitest";
import { bestCandidate, findJansByKeyword, mergeCandidates, modelTokens } from "./janSearch";
import type { RawDomesticOffer } from "./rakuten";

const o = (title: string, priceJpy: number, jan?: string, extra: Partial<RawDomesticOffer> = {}): RawDomesticOffer => ({
  mall: "yahoo",
  title,
  priceJpy,
  shipping: "free",
  pointsJpy: 0,
  url: "https://example.com",
  shopName: "",
  searchText: title,
  jan,
  ...extra,
});

describe("modelTokens", () => {
  it("英字と数字を含む単語を型番として取り出す（全角・ハイフン・大文字小文字は気にしない）", () => {
    expect(modelTokens("ソニー ZV-E10 ボディ")).toEqual(["zve10"]);
    expect(modelTokens("ＨＡＣ－００１")).toEqual(["hac001"]);
    expect(modelTokens("ニンテンドースイッチ")).toEqual([]);
  });
});

describe("findJansByKeyword", () => {
  it("JAN ごとにまとめ、JAN なし・間違った JAN・セット売り・中古を除き、型番一致 → 付属品でない → 出品の多い順に並べる", () => {
    const result = findJansByKeyword(
      [
        o("ZV-E10 用 液晶保護フィルム", 980, "4549995433944"),
        o("ZV-E10 用 液晶保護フィルム 2", 990, "4549995433944"),
        o("ZV-E10 用 液晶保護フィルム 3", 999, "4549995433944"),
        o("ソニー VLOGCAM ZV-E10 ボディ", 75000, "4548736130739"),
        o("ソニー ZV-E10 ボディ 安い", 72000, "4548736130739"),
        o("ソニー Vlogcam レンズキット", 90000, "4548736130746"),
        o("ZV-E10 2個セット", 140000, "4548736130739"),
        o("【中古】ZV-E10", 50000, "4548736130739"),
        o("JAN なし", 100),
        o("JAN 間違い", 100, "4902370548496"),
      ],
      "ZV-E10",
    );
    expect(result.map((c) => [c.jan, c.modelMatch, c.accessory, c.count, c.minPriceJpy])).toEqual([
      ["4548736130739", true, false, 2, 72000],
      ["4549995433944", true, true, 3, 980],
      ["4548736130746", false, false, 1, 90000],
    ]);
    expect(bestCandidate(result)?.jan).toBe("4548736130739");
  });

  it("楽天の出品は説明文の JAN を使い、楽天・Yahoo! の候補をまとめる", () => {
    const rakuten = findJansByKeyword([o("スイッチ 本体", 30000, undefined, { mall: "rakuten", searchText: "JAN:4902370548495" })], "スイッチ");
    const yahoo = findJansByKeyword([o("スイッチ 本体", 29800, "4902370548495")], "スイッチ");
    expect(mergeCandidates(yahoo, rakuten)).toEqual([
      expect.objectContaining({ jan: "4902370548495", count: 2, minPriceJpy: 29800, malls: { yahoo: 1, rakuten: 1 } }),
    ]);
  });

  it("検索語に付属品の言葉が入っていれば、付属品として扱わない（ケースを探している）", () => {
    expect(findJansByKeyword([o("スイッチ ケース 黒", 1500, "4902370548495")], "スイッチ ケース")[0].accessory).toBe(false);
    expect(bestCandidate(findJansByKeyword([o("スイッチ ケース 黒", 1500, "4902370548495")], "スイッチ"))).toBeUndefined();
  });
});
