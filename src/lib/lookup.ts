// 1 つの JAN を楽天・Yahoo! でまとめて調べ、JAN が完全に一致する新品の出品だけを残す（サーバー側）。
// Amazon は API を使わず、利用者が Keepa で確認する（画面に Amazon・Keepa へのリンクと、販売価格の入力欄を出す）。
//
// JAN の確かめ方:
//   - Yahoo!  … JAN で検索し、商品データの janCode が一致するものだけ（キーワード検索のような付属品の混入がない）
//   - 楽天    … 楽天の API には JAN の項目がないため、JAN で検索し、商品名・説明文に JAN がそのまま書かれているものだけ
// さらに「2個セット」「まとめ買い」など 1 個の値段ではない出品と、中古・開封品・訳ありなど新品ではない出品を除く。
// （楽天の API には新品・中古の区別がなく、Yahoo! もストアの登録しだいなので、商品名・説明文でも確かめる）

import { containsJan } from "./jan";
import { MALLS, type JanLookup, type Mall, type MallOffer } from "./malls";
import type { RakutenResult, RawDomesticOffer } from "./rakuten";

/** 1 つのモールで残す出品の数（実質の安い順） */
export const MAX_OFFERS_PER_MALL = 8;

const UNIT = "(?:個|本|箱|袋|缶|台|点|枚|パック|ケース|コ|冊|足|組)";
const COUNT = "(?:[2-9]|[1-9]\\d)";
/** 複数個セットの出品（「2個セット」「×3本」「まとめ買い」「ケース販売」など） */
const SET_PATTERN = new RegExp(
  [
    `${COUNT}\\s*${UNIT}?\\s*セット`,
    `(?<![A-Za-z])[×xX]\\s*${COUNT}\\s*${UNIT}(?!\\s*入)`,
    `${COUNT}\\s*${UNIT}\\s*まとめ`,
    "まとめ買い",
    "まとめ売り",
    "ケース販売",
    "ケース売り",
  ].join("|"),
);

export function isMultiUnitListing(title: string): boolean {
  return SET_PATTERN.test(title);
}

/** 商品名に書かれていれば新品ではないとみなす言葉 */
const USED_TITLE_PATTERN = new RegExp(
  [
    "中古",
    "(?<![A-Za-z])USED(?![A-Za-z])",
    "ユーズド",
    "リユース",
    "開封済",
    "開封品",
    "(?<!新品[\\s・]?)未使用",
    "展示品",
    "展示処分",
    "アウトレット",
    "訳あり",
    "訳アリ",
    "わけあり",
    "ジャンク",
    "難あり",
    "難有",
    "傷あり",
    "箱(?:なし|無し|潰れ|つぶれ|傷み|痛み|ダメージ)",
    "外箱(?:なし|無し|潰れ|ダメージ)",
    "リファービッシュ",
    "整備済",
    "再生品",
    "美品",
    "(?<!無印)良品",
    "(?:中古|状態|商品)ランク",
    "ランク[SABC](?![A-Za-z])",
    "(?<![A-Za-z])[SABC]ランク",
  ].join("|"),
  "i",
);

/** 説明文に書かれていれば新品ではないとみなす表現（説明文は注意書きが多いので、はっきりしたものだけ） */
const USED_TEXT_PATTERN = /【中古】|［中古］|\[中古\]|中古品(?!では|でない|ではな)|中古商品(?!では|ではな)|(?:商品|状態|コンディション)ランク|状態[:：]\s*(?:中古|使用感|良好|目立った)/;

/** 中古・開封品・訳ありなど、新品として仕入れられない出品か */
export function isUsedListing(offer: Pick<RawDomesticOffer, "title" | "searchText" | "used">): boolean {
  return !!offer.used || USED_TITLE_PATTERN.test(offer.title) || USED_TEXT_PATTERN.test(offer.searchText);
}

export type LookupDeps = {
  /** Yahoo!（キーが未設定なら undefined） */
  yahoo?: (jan: string) => Promise<RawDomesticOffer[]>;
  /** ブラウザで調べた楽天の結果がないときに、サーバーから楽天を調べる（キーが未設定なら undefined） */
  rakuten?: (jan: string) => Promise<RawDomesticOffer[]>;
  now?: () => Date;
};

function errorMessage(e: unknown, fallback: string): string {
  // 各モールの処理が投げるエラーは、キーを含まない日本語の説明（DomesticApiError）
  return e instanceof Error && /^(楽天|Yahoo!)/.test(e.message) ? e.message : fallback;
}

/** 実質（価格＋分かっている送料−ポイント）の安い順に並べ、上限で切り、検索用の項目を外す */
function finalize(offers: (MallOffer | RawDomesticOffer)[]): MallOffer[] {
  const net = (o: MallOffer) => o.priceJpy + (o.shippingJpy ?? 0) - o.pointsJpy;
  return [...offers]
    .sort((a, b) => net(a) - net(b))
    .slice(0, MAX_OFFERS_PER_MALL)
    .map((o) => {
      const { mall, title, priceJpy, shipping, shippingJpy, pointsJpy, url, shopName, imageUrl, fba } = o;
      return { mall, title, priceJpy, shipping, shippingJpy, pointsJpy, url, shopName, imageUrl, fba };
    });
}

/**
 * 1 つの JAN を 3 モールで調べる。
 * @param rakuten ブラウザで調べた楽天の結果（なければ deps.rakuten でサーバーから調べる）
 */
export async function lookupJan(jan: string, rakuten: RakutenResult | undefined, deps: LookupDeps): Promise<JanLookup> {
  const warnings: string[] = [];

  const [yahooResult, rakutenResult] = await Promise.allSettled([
    deps.yahoo ? deps.yahoo(jan) : Promise.resolve(undefined),
    rakuten ? Promise.resolve(rakuten) : deps.rakuten ? deps.rakuten(jan).then((offers) => ({ offers })) : Promise.resolve(undefined),
  ]);

  // ---- JAN が一致する出品を集める ----
  let yahooMatched: RawDomesticOffer[] = [];
  if (!deps.yahoo) warnings.push("Yahoo!: 環境変数 YAHOO_CLIENT_ID が設定されていません。");
  else if (yahooResult.status === "fulfilled") yahooMatched = (yahooResult.value ?? []).filter((o) => o.jan === jan);
  else warnings.push(errorMessage(yahooResult.reason, "Yahoo!: 取得に失敗しました。"));

  let rakutenMatched: RawDomesticOffer[] = [];
  if (rakutenResult.status === "rejected") warnings.push(errorMessage(rakutenResult.reason, "楽天: 取得に失敗しました。"));
  else if (!rakutenResult.value) warnings.push("楽天: 環境変数 RAKUTEN_APP_ID・RAKUTEN_ACCESS_KEY が設定されていません。");
  else if ("error" in rakutenResult.value) warnings.push(rakutenResult.value.error);
  else rakutenMatched = rakutenResult.value.offers.filter((o) => containsJan(o.searchText, jan));

  // ---- 中古・セット売りを除く ----
  let excludedUsed = 0;
  const newOnly = (offers: RawDomesticOffer[]) =>
    offers.filter((o) => {
      const used = isUsedListing(o);
      if (used) excludedUsed++;
      return !used;
    });
  const yahooNew = newOnly(yahooMatched);
  const rakutenNew = newOnly(rakutenMatched);
  // JAN が一致する出品がすべて「◯本×◯ケース」のようなセット表記なら、その JAN 自体がセット商品なので除かない
  const all = [...yahooNew, ...rakutenNew];
  const skipSetFilter = all.length > 0 && all.every((o) => isMultiUnitListing(o.title));
  let excludedSets = 0;
  const single = (offers: RawDomesticOffer[]) =>
    skipSetFilter
      ? offers
      : offers.filter((o) => {
          const set = isMultiUnitListing(o.title);
          if (set) excludedSets++;
          return !set;
        });

  const offers: Record<Mall, MallOffer[]> = {
    amazon: [],
    rakuten: finalize(single(rakutenNew)),
    yahoo: finalize(single(yahooNew)),
  };
  const first = MALLS.flatMap((m) => offers[m]);

  return {
    jan,
    title: offers.yahoo[0]?.title ?? offers.rakuten[0]?.title ?? "",
    imageUrl: first.find((o) => o.imageUrl)?.imageUrl,
    offers,
    warnings,
    excludedSets,
    excludedUsed,
    fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}
