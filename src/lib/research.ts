// 自動リサーチ本体（サーバー側専用）。
// 1. 楽天・Yahoo! で商品を検索 → 2. 除外ルールで絞り、JAN・カード番号などで同じ商品をまとめる
// → 3. まとめた商品ごとに eBay の出品中価格を調べる。
// 利益の計算は画面側で行う（為替・手数料・お宝の条件を変えても再取得せずに済むように）。

import { DomesticApiError, searchRakuten, searchYahoo, type RawDomesticOffer } from "./domestic";
import {
  EbayApiError,
  extractUsdPrices,
  searchEbayListings,
  summarizePrices,
  type EbayItemSummary,
  type ListingSearchParams,
  type ListingSearchResult,
} from "./ebay";
import {
  containsAllTokens,
  ebayWebSearchUrl,
  extractJan,
  identify,
  isExcludedOffer,
  keywordTokens,
  normalizeText,
  planEbaySearch,
  planItemEbaySearch,
  type EbaySearchPlan,
  type Identity,
} from "./identify";
import {
  DEFAULT_MAX_LOOKUPS,
  ITEM_CONDITIONS,
  MAX_LOOKUPS_LIMIT,
  type Candidate,
  type DomesticOffer,
  type EbayMarket,
  type ResearchRequest,
  type ResearchResponse,
} from "./researchTypes";

/** 1 つの商品について画面に返す国内の出品数（楽天・Yahoo! それぞれ） */
const OFFERS_PER_SOURCE = 3;
/** eBay を同時に調べる数 */
const EBAY_CONCURRENCY = 3;
/** eBay の結果を使い回す時間（同じ商品を何度も調べて API の枠を使わないように） */
const EBAY_CACHE_MS = 30 * 60 * 1000;
/** 集計に使った出品の例として返す件数 */
const SAMPLE_COUNT = 3;

export type ResearchDeps = {
  searchRakuten: typeof searchRakuten;
  searchYahoo: typeof searchYahoo;
  searchEbay: (params: ListingSearchParams) => Promise<ListingSearchResult>;
  now: () => number;
};

const ebayCache = new Map<string, { at: number; result: ListingSearchResult }>();

/** テスト用：eBay の結果の保存を消す */
export function clearEbayCache() {
  ebayCache.clear();
}

async function cachedEbaySearch(params: ListingSearchParams, deps: ResearchDeps): Promise<ListingSearchResult> {
  const key = JSON.stringify([params.q ?? "", params.gtin ?? "", params.conditionIds]);
  const hit = ebayCache.get(key);
  if (hit && deps.now() - hit.at < EBAY_CACHE_MS) return hit.result;
  const result = await deps.searchEbay(params);
  ebayCache.set(key, { at: deps.now(), result });
  return result;
}

const defaultDeps: ResearchDeps = {
  searchRakuten: (p) => searchRakuten(p),
  searchYahoo: (p) => searchYahoo(p),
  searchEbay: (p) => searchEbayListings(p),
  now: Date.now,
};

/** 価格の配列から、安い方から割合 ratio の位置の値を求める（小数第 2 位で丸める） */
export function percentile(prices: number[], ratio: number): number | null {
  const sorted = [...prices].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * ratio;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
  return Math.round(value * 100) / 100;
}

/**
 * 中央値から大きく外れた出品を除く（中央値の 30% 未満・3 倍超）。
 * タイトルの条件をすり抜けた部品・付属品（ドラグワッシャー・AC アダプターなど）や、まとめ売りを落とすため。
 */
export function trimPriceOutliers(items: EbayItemSummary[]): EbayItemSummary[] {
  const median = summarizePrices(extractUsdPrices(items)).median;
  if (median === null) return items;
  return items.filter((item) => {
    const price = Number(item.price?.value);
    return Number.isFinite(price) && price >= median * 0.3 && price <= median * 3;
  });
}

type Group = { identity: Identity; offers: RawDomesticOffer[] };

/** 除外・識別して、同じ商品ごとにまとめる */
export function groupOffers(
  request: Pick<ResearchRequest, "kind" | "ngWords">,
  offers: RawDomesticOffer[],
): { groups: Group[]; excluded: number; unidentified: number } {
  const groups = new Map<string, Group>();
  let excluded = 0;
  let unidentified = 0;
  for (const offer of offers) {
    if (isExcludedOffer(request.kind, offer.title, request.ngWords)) {
      excluded++;
      continue;
    }
    // カード番号・PSA はタイトルだけで判定する（説明文には別のカードの番号が書かれていることがある）
    const text = request.kind === "sealed" || request.kind === "other" ? offer.searchText : offer.title;
    const identity = identify(request.kind, text, offer.jan);
    if (!identity) {
      unidentified++;
      continue;
    }
    const group = groups.get(identity.key);
    if (group) group.offers.push(offer);
    else groups.set(identity.key, { identity, offers: [offer] });
  }
  for (const g of groups.values()) g.offers.sort((a, b) => a.priceJpy - b.priceJpy);
  // 出品数が多い（＝よく流通していて識別も確かな）商品から順に調べる
  const sorted = [...groups.values()].sort(
    (a, b) => b.offers.length - a.offers.length || a.offers[0].priceJpy - b.offers[0].priceJpy,
  );
  return { groups: sorted, excluded, unidentified };
}

function toPublicOffers(offers: RawDomesticOffer[]): DomesticOffer[] {
  const picked = (["rakuten", "yahoo"] as const).flatMap((source) =>
    offers.filter((o) => o.source === source).slice(0, OFFERS_PER_SOURCE),
  );
  return picked
    .sort((a, b) => a.priceJpy - b.priceJpy)
    .map(({ source, title, priceJpy, shipping, url, shopName, imageUrl }) => ({
      source,
      title,
      priceJpy,
      shipping,
      url,
      shopName,
      imageUrl,
    }));
}

/**
 * eBay で相場を調べる。primary で比較できる出品が 3 件未満なら fallback（英語キーワード）で探し直す。
 * @returns 相場、または調べられなかった理由
 */
async function lookUpEbay(
  primary: EbaySearchPlan,
  fallback: EbaySearchPlan | undefined,
  deps: ResearchDeps,
): Promise<EbayMarket | string> {
  const summarize = (plan: EbaySearchPlan, result: ListingSearchResult, usedKeywordFallback: boolean): EbayMarket => {
    const matched = trimPriceOutliers(result.items.filter((item) => item.title && plan.titleFilter(item.title)));
    const prices = extractUsdPrices(matched);
    const { count, min, median } = summarizePrices(prices);
    const samples = matched
      .flatMap((item) => {
        const priceUsd = Number(item.price?.value);
        return item.title && item.itemWebUrl && Number.isFinite(priceUsd)
          ? [{ title: item.title, priceUsd, url: item.itemWebUrl }]
          : [];
      })
      // 同じ出品が複数回返ることがあるので URL で重複を除く
      .filter((sample, i, all) => all.findIndex((x) => x.url === sample.url) === i)
      .sort((a, b) => a.priceUsd - b.priceUsd)
      .slice(0, SAMPLE_COUNT);
    return {
      query: plan.q ?? "",
      gtin: plan.gtin,
      usedKeywordFallback,
      conditionIds: plan.conditionIds,
      total: result.total,
      count,
      minUsd: min,
      p25Usd: percentile(prices, 0.25),
      medianUsd: median,
      samples,
      activeUrl: ebayWebSearchUrl(plan.webQuery, false),
      soldUrl: ebayWebSearchUrl(plan.webQuery, true),
    };
  };
  const search = (plan: EbaySearchPlan) =>
    cachedEbaySearch({ q: plan.q, gtin: plan.gtin, conditionIds: plan.conditionIds }, deps);

  try {
    const market = summarize(primary, await search(primary), false);
    // JAN で見つからない（eBay のカタログに未登録など）ときは、英語のキーワードで探し直す
    if (fallback && market.count < 3) return summarize(fallback, await search(fallback), true);
    return market;
  } catch (err) {
    if (err instanceof EbayApiError) return err.message;
    console.error("eBay lookup failed:", err);
    return "eBay への接続中にエラーが発生しました。";
  }
}

/** 識別で見つけた商品の eBay 検索（JAN 検索で見つからなければ ebayKeyword で探し直す） */
function plansForIdentity(
  kind: ResearchRequest["kind"],
  identity: Identity,
  ebayKeyword: string | undefined,
): { primary: EbaySearchPlan; fallback?: EbaySearchPlan } | undefined {
  const primary = planEbaySearch(kind, identity);
  if (!primary) return undefined;
  const keyword = ebayKeyword?.trim();
  const fallback = primary.gtin && keyword ? { ...primary, q: keyword, gtin: undefined, webQuery: keyword } : undefined;
  return { primary, fallback };
}

/**
 * 商品指定の国内商品を絞る。JAN があれば JAN が一致するもの（楽天は説明文などから抽出）、
 * なければタイトルに検索キーワードの単語がすべて含まれるものだけを残す。
 */
export function matchItemOffers(
  request: Pick<ResearchRequest, "keyword" | "ngWords" | "jan" | "condition">,
  offers: RawDomesticOffer[],
): { matched: RawDomesticOffer[]; excluded: number; unmatched: number } {
  const tokens = keywordTokens(request.keyword);
  const matched: RawDomesticOffer[] = [];
  let excluded = 0;
  let unmatched = 0;
  for (const offer of offers) {
    // 新品を探すときは中古品を除く（楽天には状態で絞る検索条件がないため）
    const usedOnNew = (request.condition ?? "new") === "new" && /中古|USED/i.test(normalizeText(offer.title));
    if (isExcludedOffer("item", offer.title, request.ngWords) || usedOnNew) {
      excluded++;
      continue;
    }
    const janMatches = request.jan
      ? (offer.jan ?? extractJan(offer.searchText)) === request.jan
      : false;
    const keywordMatches = tokens.length > 0 && containsAllTokens(offer.title, tokens);
    // Yahoo! の JAN 検索の結果は JAN が一致している。楽天は JAN が見つからなければキーワードで判定する
    const ok = request.jan ? janMatches || (offer.source === "yahoo" && !offer.jan) || keywordMatches : keywordMatches;
    if (ok) matched.push(offer);
    else unmatched++;
  }
  matched.sort((a, b) => a.priceJpy - b.priceJpy);
  return { matched, excluded, unmatched };
}

/** 同時に動かす数を制限して、配列の各要素に非同期処理を行う */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runResearch(
  request: ResearchRequest,
  deps: ResearchDeps = defaultDeps,
  /** このサイト自身の URL。楽天 API に送る Referer / Origin に使う */
  siteOrigin?: string,
): Promise<ResearchResponse> {
  const warnings: string[] = [];
  const domesticParams = {
    kind: request.kind,
    keyword: request.keyword,
    minPriceJpy: request.minPriceJpy,
    maxPriceJpy: request.maxPriceJpy,
    siteOrigin,
    jan: request.kind === "item" ? request.jan : undefined,
    condition: request.condition,
  };

  const [rakuten, yahoo] = await Promise.all(
    [deps.searchRakuten, deps.searchYahoo].map(async (search) => {
      try {
        return await search(domesticParams);
      } catch (err) {
        if (err instanceof DomesticApiError) warnings.push(err.message);
        else {
          console.error("domestic search failed:", err);
          warnings.push("国内サイトの検索中にエラーが発生しました。");
        }
        return null;
      }
    }),
  );

  const allOffers = [...(rakuten ?? []), ...(yahoo ?? [])];
  const stats = { rakuten: rakuten?.length ?? null, yahoo: yahoo?.length ?? null };
  const response = (candidates: Candidate[], excluded: number, unidentified: number, skippedLookups = 0): ResearchResponse => ({
    candidates,
    skippedLookups,
    stats: { ...stats, excluded, unidentified },
    warnings,
    fetchedAt: new Date(deps.now()).toISOString(),
  });

  // 商品指定: 検索条件そのものが 1 つの商品。国内で見つかったときだけ eBay を 1 回調べる
  if (request.kind === "item") {
    const { matched, excluded, unmatched } = matchItemOffers(request, allOffers);
    if (matched.length === 0) return response([], excluded, unmatched);
    const plans = planItemEbaySearch({ jan: request.jan, ebayKeyword: request.ebayKeyword, condition: request.condition ?? "new" });
    const market = plans ? await lookUpEbay(plans.primary, plans.fallback, deps) : "eBay 用の英語キーワードか JAN を設定してください。";
    const conditionLabel = ITEM_CONDITIONS.find((c) => c.id === (request.condition ?? "new"))?.label ?? "";
    const candidate: Candidate = {
      key: `item:${request.jan || keywordTokens(request.keyword).join(" ")}|${request.condition ?? "new"}`,
      label: [conditionLabel, request.jan && `JAN ${request.jan}`].filter(Boolean).join("・"),
      kind: "item",
      offers: toPublicOffers(matched),
      ...(typeof market === "string" ? { ebay: null, ebayError: market } : { ebay: market }),
    };
    return response([candidate], excluded, unmatched);
  }

  const { groups, excluded, unidentified } = groupOffers(request, allOffers);
  const maxLookups = Math.min(Math.max(request.maxLookups ?? DEFAULT_MAX_LOOKUPS, 1), MAX_LOOKUPS_LIMIT);
  const targets = groups.slice(0, maxLookups);

  const candidates = await mapWithConcurrency(targets, EBAY_CONCURRENCY, async (group): Promise<Candidate> => {
    const plans = plansForIdentity(request.kind, group.identity, request.ebayKeyword);
    const market = plans
      ? await lookUpEbay(plans.primary, plans.fallback, deps)
      : "eBay で検索するための識別子がありません。";
    return {
      key: group.identity.key,
      label: group.identity.label,
      kind: request.kind,
      offers: toPublicOffers(group.offers),
      ...(typeof market === "string" ? { ebay: null, ebayError: market } : { ebay: market }),
    };
  });

  return response(candidates, excluded, unidentified, groups.length - targets.length);
}
