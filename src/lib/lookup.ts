// 1 つの JAN を Amazon・楽天・Yahoo! でまとめて調べ、JAN が完全に一致する新品の出品だけを残す（サーバー側）。
//
// JAN の確かめ方:
//   - Amazon  … カタログを JAN で検索し、商品ページに登録された JAN（EAN）と一致するものだけ
//   - Yahoo!  … JAN で検索し、商品データの janCode が一致するものだけ（キーワード検索のような付属品の混入がない）
//   - 楽天    … 楽天の API には JAN の項目がないため、JAN で検索し、商品名・説明文に JAN がそのまま書かれているものだけ
// さらに「2個セット」「まとめ買い」など 1 個の値段ではない出品は除く（JAN は 1 個の商品に付く番号のため）。

import type { AmazonLookup } from "./amazon";
import { containsJan } from "./jan";
import { MALLS, type JanLookup, type Mall, type MallOffer } from "./malls";
import type { RakutenResult, RawDomesticOffer } from "./rakuten";

/** 1 つのモールで残す出品の数（実質の安い順） */
export const MAX_OFFERS_PER_MALL = 8;

const UNIT = "(?:個|本|箱|袋|缶|台|点|枚|パック|コ|冊|足|組)";
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

export type LookupDeps = {
  /** Amazon（キーが未設定なら undefined） */
  amazon?: (jan: string) => Promise<AmazonLookup>;
  /** Yahoo!（キーが未設定なら undefined） */
  yahoo?: (jan: string) => Promise<RawDomesticOffer[]>;
  /** ブラウザで調べた楽天の結果がないときに、サーバーから楽天を調べる（キーが未設定なら undefined） */
  rakuten?: (jan: string) => Promise<RawDomesticOffer[]>;
  now?: () => Date;
};

function errorMessage(e: unknown, fallback: string): string {
  // 各モールの処理が投げるエラーは、キーを含まない日本語の説明（DomesticApiError・AmazonApiError）
  return e instanceof Error && /^(Amazon|楽天|Yahoo!)/.test(e.message) ? e.message : fallback;
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

  const [amazonResult, yahooResult, rakutenResult] = await Promise.allSettled([
    deps.amazon ? deps.amazon(jan) : Promise.resolve(undefined),
    deps.yahoo ? deps.yahoo(jan) : Promise.resolve(undefined),
    rakuten ? Promise.resolve(rakuten) : deps.rakuten ? deps.rakuten(jan).then((offers) => ({ offers })) : Promise.resolve(undefined),
  ]);

  // ---- Amazon ----
  let amazon: AmazonLookup | undefined;
  if (!deps.amazon) {
    warnings.push("Amazon: SP-API のキー（AMAZON_SP_CLIENT_ID など）が未設定のため、楽天・Yahoo! だけで比較しています。");
  } else if (amazonResult.status === "fulfilled") {
    amazon = amazonResult.value;
    warnings.push(...(amazon?.warnings ?? []));
  } else {
    warnings.push(errorMessage(amazonResult.reason, "Amazon: 取得に失敗しました。"));
  }

  // Amazon の商品名自体がセット商品（例: 「24本入り×2ケース」の JAN）なら、セット表記で除かない
  const skipSetFilter = amazon?.product ? isMultiUnitListing(amazon.product.title) : false;
  let excludedSets = 0;
  const single = <T extends MallOffer>(offers: T[]): T[] =>
    skipSetFilter
      ? offers
      : offers.filter((o) => {
          const set = isMultiUnitListing(o.title);
          if (set) excludedSets++;
          return !set;
        });

  // ---- Yahoo! ----
  let yahoo: RawDomesticOffer[] = [];
  if (!deps.yahoo) warnings.push("Yahoo!: 環境変数 YAHOO_CLIENT_ID が設定されていません。");
  else if (yahooResult.status === "fulfilled") yahoo = single((yahooResult.value ?? []).filter((o) => o.jan === jan));
  else warnings.push(errorMessage(yahooResult.reason, "Yahoo!: 取得に失敗しました。"));

  // ---- 楽天 ----
  let rakutenOffers: RawDomesticOffer[] = [];
  if (rakutenResult.status === "rejected") warnings.push(errorMessage(rakutenResult.reason, "楽天: 取得に失敗しました。"));
  else if (!rakutenResult.value) warnings.push("楽天: 環境変数 RAKUTEN_APP_ID・RAKUTEN_ACCESS_KEY が設定されていません。");
  else if ("error" in rakutenResult.value) warnings.push(rakutenResult.value.error);
  else rakutenOffers = single(rakutenResult.value.offers.filter((o) => containsJan(o.searchText, jan)));

  const offers: Record<Mall, MallOffer[]> = {
    amazon: finalize(amazon?.offers ?? []),
    rakuten: finalize(rakutenOffers),
    yahoo: finalize(yahoo),
  };
  const first = MALLS.flatMap((m) => offers[m]);
  const product = amazon?.product;

  return {
    jan,
    title: product?.title ?? offers.yahoo[0]?.title ?? offers.rakuten[0]?.title ?? "",
    imageUrl: product?.imageUrl ?? first.find((o) => o.imageUrl)?.imageUrl,
    offers,
    amazon: product,
    warnings,
    excludedSets,
    fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}
