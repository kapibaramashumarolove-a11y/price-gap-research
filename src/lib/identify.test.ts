import { describe, expect, it } from "vitest";
import {
  ebayWebSearchUrl,
  extractCardNumber,
  extractJan,
  extractModelNumber,
  identify,
  isAccessoryTitle,
  isExcludedOffer,
  isPsa10,
  isValidJan,
  normalizeText,
  planEbaySearch,
} from "./identify";

describe("normalizeText", () => {
  it("全角を半角にし、HTML の文字参照を戻す", () => {
    expect(normalizeText("スカーレット&amp;バイオレット　ＰＳＡ１０ ２０５／１７２")).toBe(
      "スカーレット&バイオレット PSA10 205/172",
    );
  });
});

describe("JAN", () => {
  it("チェックデジットを確認する", () => {
    expect(isValidJan("4521329362342")).toBe(true);
    expect(isValidJan("4521329362343")).toBe(false);
  });

  it("文章から正しい JAN だけを取り出す", () => {
    expect(extractJan("JANコード：4521329362342 発売日")).toBe("4521329362342");
    expect(extractJan("型番 4521329362343 / 4521329362342")).toBe("4521329362342");
    expect(extractJan("注文番号 145213293623421")).toBeUndefined();
  });
});

describe("カード番号", () => {
  it("通常の番号とプロモ番号を取り出す", () => {
    expect(extractCardNumber("ピカチュウ AR 205/172 VSTARユニバース")).toBe("205/172");
    expect(extractCardNumber("ピカチュウ ＳＡＲ ２０５／１７２")).toBe("205/172");
    expect(extractCardNumber("ピカチュウ 001/SV-P プロモ")).toBe("001/SV-P");
  });

  it("日付は番号として扱わない", () => {
    expect(extractCardNumber("2025/10/02 発売")).toBeUndefined();
  });

  it("PSA10 の判定", () => {
    expect(isPsa10("【PSA10】ピカチュウ")).toBe(true);
    expect(isPsa10("PSA 10 GEM MINT")).toBe(true);
    expect(isPsa10("PSA9")).toBe(false);
    expect(isPsa10("PSA100")).toBe(false);
  });
});

describe("型番", () => {
  it("Nike の型番を取り出す", () => {
    expect(extractModelNumber("Nike Dunk Low Panda dd1391-100 27cm")).toBe("DD1391-100");
  });
});

describe("identify", () => {
  it("未開封BOX は JAN で識別（API の JAN を優先）", () => {
    expect(identify("sealed", "テラスタルフェスex BOX", "4521329362342")?.key).toBe("jan:4521329362342");
    expect(identify("sealed", "テラスタルフェスex BOX JAN:4521329362342")?.key).toBe("jan:4521329362342");
    expect(identify("sealed", "テラスタルフェスex BOX")).toBeUndefined();
  });

  it("PSA10 はカード番号と PSA10 の両方が必要", () => {
    expect(identify("psa10", "【PSA10】ピカチュウ AR 205/172")).toMatchObject({
      key: "psa10:205/172",
      label: "205/172 PSA10",
    });
    expect(identify("psa10", "ピカチュウ AR 205/172")).toBeUndefined();
  });

  it("その他は JAN、なければ型番", () => {
    expect(identify("other", "Nike Dunk DD1391-100")?.key).toBe("model:DD1391-100");
  });
});

describe("isExcludedOffer（Yahoo! の実際の検索結果のタイトルで確認）", () => {
  const sealed = (title: string, ng: string[] = []) => isExcludedOffer("sealed", title, ng);

  it("オリパ・くじ・周辺グッズ・複数箱・訳ありは除外", () => {
    expect(sealed("ポケモンカード オリパ ポケカ 【絶版パック1パック確定】 当たりはBOX")).toBe(true);
    expect(sealed("第18弾 ポケモンカード BOXくじ 全200口 未開封シュリンク")).toBe(true);
    expect(sealed("ポケモンカード BOX ローダー 保管用ケース UVカット")).toBe(true);
    expect(sealed("未使用品 ポケモンカードゲーム テラスタルフェスex 2BOXセット")).toBe(true);
    expect(sealed("【外箱訳アリ/シュリンクなし】 テラスタルフェスex BOX")).toBe(true);
  });

  it("普通の BOX は残す（○パック入りも可）", () => {
    expect(sealed("ポケモンカードゲーム テラスタルフェスex BOX ハイクラスパック 新品未開封 シュリンク付き")).toBe(false);
    expect(sealed("テラスタルフェスex BOX (10パック入り)")).toBe(false);
  });

  it("自分で指定した除外ワード", () => {
    expect(sealed("テラスタルフェスex BOX 韓国版", ["韓国版"])).toBe(true);
  });

  it("シングルは鑑定済みを除外", () => {
    expect(isExcludedOffer("single", "ピカチュウ AR 205/172 PSA10")).toBe(true);
    expect(isExcludedOffer("single", "ピカチュウ AR 205/172 状態A")).toBe(false);
  });
});

describe("planEbaySearch（eBay の実際の出品タイトルで確認）", () => {
  it("未開封BOX は JAN（GTIN）で検索し、1パック・複数箱・別言語を除く", () => {
    const plan = planEbaySearch("sealed", { key: "jan:4521329362342", label: "", jan: "4521329362342" })!;
    expect(plan).toMatchObject({ gtin: "4521329362342", conditionIds: ["1000"] });
    expect(plan.titleFilter("Pokemon TCG Terastal Festival ex SV8A Japan Booster Box Factory Sealed Japanese")).toBe(true);
    expect(plan.titleFilter("Pokemon Cards Terastal Festival ex High Class Pack SV8A 1 Pack JP")).toBe(false);
    expect(plan.titleFilter("Pokemon Card Terastal Festival ex Booster Box x6 sv8a Japanese w/shrink")).toBe(false);
    expect(plan.titleFilter("Terastal Festival ex Booster Box sv8a Korean ver.")).toBe(false);
  });

  it("PSA10 はカード番号と PSA 10 を含む出品だけ", () => {
    const plan = planEbaySearch("psa10", { key: "psa10:205/172", label: "", cardNumber: "205/172" })!;
    expect(plan).toMatchObject({ q: "205/172 PSA 10 japanese", conditionIds: ["2750"] });
    expect(plan.titleFilter("PSA 10 Pikachu AR 205/172 S12a VSTAR Universe Pokemon Card Japanese")).toBe(true);
    expect(plan.titleFilter("Pokemon Pikachu #205/172 VSTAR Universe Japanese PSA 10 GEM MINT")).toBe(true);
    expect(plan.titleFilter("Pikachu AR 205/172 PSA 9 Japanese")).toBe(false);
    expect(plan.titleFilter("Pikachu 1205/172 PSA 10")).toBe(false);
  });

  it("シングルは鑑定品・カスタム品・セットを除く", () => {
    const plan = planEbaySearch("single", { key: "single:205/172", label: "", cardNumber: "205/172" })!;
    expect(plan.conditionIds).toEqual(["4000"]);
    expect(plan.titleFilter("Pikachu AR 205/172 s12a Vstar Universe Pokemon Card Japanese")).toBe(true);
    expect(plan.titleFilter("Pikachu 205/172 AR VSTAR Universe s12a Japanese Custom Gold Metal Fan Art Card")).toBe(false);
    expect(plan.titleFilter("Pokemon Card Game VSTAR Universe AR God Pack Pikachu 205/172 S12a Full Set")).toBe(false);
    expect(plan.titleFilter("PSA 10 Pikachu AR 205/172")).toBe(false);
  });
});

describe("ebayWebSearchUrl", () => {
  it("出品中は即決のみ、落札済みはオークションも含める", () => {
    expect(ebayWebSearchUrl("205/172 PSA 10", false)).toBe(
      "https://www.ebay.com/sch/i.html?_nkw=205%2F172+PSA+10&LH_BIN=1",
    );
    expect(ebayWebSearchUrl("205/172 PSA 10", true)).toBe(
      "https://www.ebay.com/sch/i.html?_nkw=205%2F172+PSA+10&LH_Sold=1&LH_Complete=1",
    );
  });
});

describe("isAccessoryTitle（付属品・アクセサリーの出品）", () => {
  it("付属品そのものの出品は付属品とみなす", () => {
    for (const title of [
      "SONY ZV-E10 液晶保護フィルム 2枚入り",
      "ZV-E10用 ケース レザー",
      "ソニー ZV-E10 専用 シリコンカバー",
      "ZV-E10 対応 ボディキャップ",
      "ZV-E10 バッテリーグリップ",
      "ニコン F3 取扱説明書",
      "SONY ZV-E10 元箱のみ",
      "ゼルダの伝説 神々のトライフォース 攻略本",
      "Nikon F3 用 アイピース",
      // Yahoo! の実際の検索結果より
      "SONY ZV-E10 II / ZV-E1 専用 ガラスフィルム 液晶 保護 硬度9H 【 2枚 】セット",
      "WERJIA 収納ケースソニー(SONY) VLOGCAM ZV-E10L/ZV-E10カメラ専用収納ケースケース対応1",
      "SmallRig ZV-E10用グリップ付きケージ/内蔵クイックリリースプレート付き",
      "ソニー リチャージャブルバッテリーパック「NP-FZ100」 NP-FZ100 返品種別A",
    ]) {
      expect(isAccessoryTitle(title), title).toBe(true);
    }
  });

  it("本体の出品（付属品の有無の説明・フィルムカメラ・未使用など）は残す", () => {
    for (const title of [
      "SONY ZV-E10 ボディ 元箱・説明書・バッテリー付き",
      "ソニー ZV-E10 ボディ ストラップ欠品",
      "ZV-E10 ボディ レンズキャップ 付属品多数",
      "Nikon F3 フィルムカメラ ボディ",
      "ニコン F3 ボディ 未使用に近い 使用感少なめ",
      "SONY ZV-E10 4K対応 ボディ",
      "BOSS DS-1 ディストーション 箱・説明書あり",
      "シマノ 22ステラ C3000XG 新品",
      // Yahoo! の実際の検索結果より
      "SONY(ソニー) Vlog用カメラ レンズ交換式VLOGCAM APS-C ミラーレス一眼カメラ ZV-E10 ボディ",
      "[新品]【グリップセット】SONY ソニー VLOGCAM ZV-E10 II パワーズームレンズキット ブラック",
    ]) {
      expect(isAccessoryTitle(title), title).toBe(false);
    }
  });

  it("商品指定・その他の種類で除外に使う（カードなどには使わない）", () => {
    expect(isExcludedOffer("item", "ZV-E10用 ケース")).toBe(true);
    expect(isExcludedOffer("other", "ZV-E10用 ケース")).toBe(true);
    expect(isExcludedOffer("single", "ピカチュウ AR 205/172 ケース入り")).toBe(false);
  });
});
