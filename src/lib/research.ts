// 自動リサーチ本体（サーバー側専用）。
// 1. 楽天・Yahoo! で商品を検索 → 2. 除外ルールで絞り、JAN・カード番号などで同じ商品をまとめる
// → 3. まとめた商品ごとに eBay の出品中価格を調べる。
// 利益の計算は画面側で行う（為替・手数料・お宝の条件を変えても再取得せずに済むように）。

import { DomesticApiError, searchRakuten, searchYahoo, type RawDomesticOffer } from "./domestic";
import {
  EbayApiError,
  extractUsdPrices,
  getItemSales,
  searchEbayListings,
  summarizePrices,
  type ItemSales,
  type EbayItemSummary,
  type ListingSearchParams,
  type ListingSearchResult,
} from "./ebay";
import {
  containsAllTokens,
  ebayWebSearchUrl,
  extractJan,
  extractModelKeyword,
  identify,
  isExcludedOffer,
  keywordTokens,
  normalizeText,
  planEbaySearch,
  planItemEbaySearch,
  type EbaySearchPlan,
  type Identity,
} from "./identify";
import type { Settings } from "./profit";
import { evaluateCandidate, type TreasureCriteria } from "./researchProfit";
import {
  DEFAULT_MAX_LOOKUPS,
  ITEM_CONDITIONS,
  MAX_LOOKUPS_LIMIT,
  type Candidate,
  type DomesticOffer,
  type EbayMarket,
  type ResearchRequest,
  type ResearchResponse,
  type SalesSignal,
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
  /** 出品 1 件の販売数（売れ行きの推定に使う）。なければ売れ行きは調べない */
  getItemSales?: (itemId: string) => Promise<ItemSales>;
  now: () => number;
};

const ebayCache = new Map<string, { at: number; result: ListingSearchResult }>();

/** テスト用：eBay の結果の保存を消す */
export function clearEbayCache() {
  ebayCache.clear();
  itemSalesCache.clear();
}

async function cachedEbaySearch(params: ListingSearchParams, deps: ResearchDeps): Promise<ListingSearchResult> {
  const key = JSON.stringify([params.q ?? "", params.gtin ?? "", params.conditionIds]);
  const hit = ebayCache.get(key);
  if (hit && deps.now() - hit.at < EBAY_CACHE_MS) return hit.result;
  const result = await deps.searchEbay(params);
  ebayCache.set(key, { at: deps.now(), result });
  return result;
}

export const defaultResearchDeps: ResearchDeps = {
  searchRakuten: (p) => searchRakuten(p),
  searchYahoo: (p) => searchYahoo(p),
  searchEbay: (p) => searchEbayListings(p),
  getItemSales: (id) => getItemSales(id),
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
  const summarize = (
    plan: EbaySearchPlan,
    result: ListingSearchResult,
    usedKeywordFallback: boolean,
  ): { market: EbayMarket; matched: EbayItemSummary[] } => {
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
    const market: EbayMarket = {
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
      locations: {
        jp: matched.filter((i) => i.itemLocation?.country === "JP").length,
        other: matched.filter((i) => i.itemLocation?.country && i.itemLocation.country !== "JP").length,
      },
    };
    return { market, matched };
  };
  const search = (plan: EbaySearchPlan) =>
    cachedEbaySearch({ q: plan.q, gtin: plan.gtin, conditionIds: plan.conditionIds }, deps);

  try {
    let found = summarize(primary, await search(primary), false);
    // JAN で見つからない（eBay のカタログに未登録など）ときは、英語のキーワードで探し直す
    if (fallback && found.market.count < 3) found = summarize(fallback, await search(fallback), true);
    const sales = await lookUpSales(found.matched, deps);
    return sales ? { ...found.market, sales } : found.market;
  } catch (err) {
    if (err instanceof EbayApiError) return err.message;
    console.error("eBay lookup failed:", err);
    return "eBay への接続中にエラーが発生しました。";
  }
}

// ---- 売れ行きの推定 ----

/** 販売数を調べる出品数（eBay のおすすめ順＝販売実績も加味された順の上位から） */
const SALES_CHECK_COUNT = 8;
/** 出品ごとの販売数を使い回す時間 */
const ITEM_SALES_CACHE_MS = 6 * 60 * 60 * 1000;
const itemSalesCache = new Map<string, { at: number; sales: ItemSales }>();
/** 出品から間もないと 1 か月あたりの数が大きく出すぎるので、出品日数はこれ以上として計算する */
const MIN_LISTING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 重み付きの中央値（値を小さい順に並べ、重みの合計が半分を超えたところの値） */
function weightedMedian(entries: { value: number; weight: number }[]): number | null {
  const sorted = entries.filter((e) => e.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, e) => sum + e.weight, 0);
  if (total === 0) return null;
  let acc = 0;
  for (const e of sorted) {
    acc += e.weight;
    if (acc >= total / 2) return Math.round(e.value * 100) / 100;
  }
  return null;
}

/** 出品ごとの販売数から、売れ行き（月あたりの推定販売数・売れている出品の価格）をまとめる */
export function computeSalesSignal(
  listings: { sales: ItemSales; priceUsd: number; originDate?: string }[],
  now: number,
): SalesSignal {
  const multi = listings.filter((l) => l.sales.totalQuantity > 1);
  const sold = multi.filter((l) => l.sales.soldQuantity > 0);
  const estimatedMonthlySales = sold.reduce((sum, l) => {
    const started = l.originDate ? Date.parse(l.originDate) : NaN;
    const days = Number.isFinite(started) ? Math.max(MIN_LISTING_DAYS, (now - started) / DAY_MS) : 365;
    return sum + (l.sales.soldQuantity / days) * 30;
  }, 0);
  return {
    checkedListings: listings.length,
    multiQuantityListings: multi.length,
    soldTotal: sold.reduce((sum, l) => sum + l.sales.soldQuantity, 0),
    estimatedMonthlySales: Math.round(estimatedMonthlySales * 10) / 10,
    soldPriceMedianUsd: weightedMedian(sold.map((l) => ({ value: l.priceUsd, weight: l.sales.soldQuantity }))),
  };
}

/** 集計に使った出品の上位の販売数を調べて、売れ行きを推定する（調べられなければ undefined） */
async function lookUpSales(matched: EbayItemSummary[], deps: ResearchDeps): Promise<SalesSignal | undefined> {
  const getSales = deps.getItemSales;
  if (!getSales) return undefined;
  const targets = matched
    .filter((item, i, all) => item.itemId && all.findIndex((x) => x.itemId === item.itemId) === i)
    .slice(0, SALES_CHECK_COUNT);
  if (targets.length === 0) return undefined;
  const results = await mapWithConcurrency(targets, EBAY_CONCURRENCY, async (item) => {
    const id = item.itemId!;
    const hit = itemSalesCache.get(id);
    if (hit && deps.now() - hit.at < ITEM_SALES_CACHE_MS) return { item, sales: hit.sales };
    try {
      const sales = await getSales(id);
      itemSalesCache.set(id, { at: deps.now(), sales });
      return { item, sales };
    } catch {
      // 1 件取れなくても、ほかの出品で推定する
      return undefined;
    }
  });
  const listings = results.flatMap((r) =>
    r ? [{ sales: r.sales, priceUsd: Number(r.item.price?.value), originDate: r.item.itemOriginDate ?? r.item.itemCreationDate }] : [],
  );
  return listings.length > 0 ? computeSalesSignal(listings, deps.now()) : undefined;
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

/**
 * 商品指定の eBay 相場を調べる。
 * 画面は国内を検索する前にこれを呼び、相場から「これより安い国内商品は付属品」という最低価格を決めて国内検索に使う
 * （安い付属品で検索結果の枠が埋まらないように）。同じ検索は 30 分使い回すので、eBay の利用回数は増えない。
 * @returns 相場、または調べられなかった理由
 */
export async function lookUpItemMarket(
  request: Pick<ResearchRequest, "jan" | "ebayKeyword" | "condition"> & { keyword?: string },
  deps: ResearchDeps = defaultResearchDeps,
): Promise<EbayMarket | string> {
  const plans = planItemEbaySearch({
    jan: request.jan,
    ebayKeyword: request.ebayKeyword,
    condition: request.condition ?? "new",
    variantReference: request.keyword,
  });
  return plans ? lookUpEbay(plans.primary, plans.fallback, deps) : "eBay 用の英語キーワードか JAN を設定してください。";
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
  deps: ResearchDeps = defaultResearchDeps,
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
    const market = await lookUpItemMarket(request, deps);
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

// ---- 売れ筋から探す（楽天ランキング）----

export type DiscoverStats = {
  /** 受け取ったランキングの商品数 */
  received: number;
  /** JAN も型番も見つからなかった商品数 */
  noIdentifier: number;
  /** 付属品・ジャンクなどで除いた商品数 */
  excluded: number;
  /** 同じ型番・JAN がランキングに複数あってまとめた数 */
  duplicates: number;
  /** eBay の相場を調べた商品数 */
  checked: number;
  /** お宝候補として売れ行き（回転率）まで調べた商品数 */
  salesChecked: number;
};

/**
 * ランキングの商品から JAN・型番を取り出して eBay の相場を調べ、利益を計算する。
 * eBay の利用回数を抑えるため、売れ行き（出品ごとの販売数）は、利益の条件を満たした商品だけ調べる。
 */
export async function discoverFromRanking(
  items: (RawDomesticOffer & { rank: number })[],
  options: { settings: Settings; criteria: TreasureCriteria; internationalShippingJpy?: number },
  deps: ResearchDeps = defaultResearchDeps,
): Promise<{ candidates: Candidate[]; stats: DiscoverStats }> {
  const stats: DiscoverStats = { received: items.length, noIdentifier: 0, excluded: 0, duplicates: 0, checked: 0, salesChecked: 0 };
  const byKey = new Map<string, { item: (typeof items)[number]; jan?: string; model?: string }>();
  for (const item of items) {
    if (isExcludedOffer("item", item.title, [])) {
      stats.excluded++;
      continue;
    }
    const jan = item.jan ?? extractJan(item.searchText);
    const model = extractModelKeyword(item.title);
    if (!jan && !model) {
      stats.noIdentifier++;
      continue;
    }
    const key = jan ? `jan:${jan}` : `model:${model!.toUpperCase()}`;
    const prev = byKey.get(key);
    if (prev) stats.duplicates++;
    if (!prev || item.priceJpy < prev.item.priceJpy) byKey.set(key, { item, jan, model });
  }

  const withoutSales: ResearchDeps = { ...deps, getItemSales: undefined };
  // 売れ行きを調べる前に、回転率ランクの条件を除いて利益だけで候補を選ぶ
  const profitOnly = { ...options.criteria, minRank: "none" as const };
  const candidates = await mapWithConcurrency([...byKey.entries()], EBAY_CONCURRENCY, async ([key, { item, jan, model }]) => {
    const plans = planItemEbaySearch({ jan, ebayKeyword: model, condition: "new", variantReference: item.title });
    const label = `楽天${item.rank}位・${jan ? `JAN ${jan}` : model}`;
    const candidate = (market: EbayMarket | string): Candidate => ({
      key: `rank:${key}`,
      label,
      kind: "item",
      offers: toPublicOffers([item]),
      ...(typeof market === "string" ? { ebay: null, ebayError: market } : { ebay: market }),
    });
    if (!plans) return candidate("eBay で検索するための型番・JAN がありません。");
    stats.checked++;
    const market = await lookUpEbay(plans.primary, plans.fallback, withoutSales);
    const first = candidate(market);
    const evaluation = evaluateCandidate(first, options.settings, profitOnly, options.internationalShippingJpy);
    if (!evaluation?.isTreasure || !deps.getItemSales) return first;
    // お宝候補だけ売れ行きを調べる（検索結果は使い回すので、追加は出品の詳細だけ）
    stats.salesChecked++;
    return candidate(await lookUpEbay(plans.primary, plans.fallback, deps));
  });
  return { candidates, stats };
}
