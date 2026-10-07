// 楽天市場・Yahoo!ショッピングの公式 API で国内の商品を検索する（サーバー側専用）。
// キー（RAKUTEN_APP_ID / YAHOO_CLIENT_ID）を扱うので、ブラウザ側からは import しないこと。

import { cleanEnvValue } from "./env";
import { normalizeText } from "./jan";
import type { ShippingStatus } from "./malls";
import { fetchRakuten, type RakutenCredentials, type RakutenSearchParams, type RawDomesticOffer } from "./rakuten";

export type { RawDomesticOffer };

export type DomesticSearchParams = RakutenSearchParams & {
  /** このサイト自身の URL（例: https://example.vercel.app）。楽天に送る Referer / Origin に使う */
  siteOrigin?: string;
};

/** 画面にそのまま表示してよい（キーの値を含まない）エラー */
export class DomesticApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomesticApiError";
  }
}

// ---- 楽天市場（商品検索 API）----
// 画面からは、楽天をブラウザから直接呼ぶ（src/lib/rakuten.ts の説明を参照）。
// ここはサーバーから呼ぶ場合（ブラウザの結果が送られてこなかったとき）の処理。
// 楽天は Referer / Origin を「許可されたWebサイト」と照合するので、このサイトの URL を付けて送る。

export function isRakutenConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return cleanEnvValue(env.RAKUTEN_APP_ID) !== "";
}

/** 楽天のキー（未設定・不足なら画面に出すエラーメッセージ） */
export function readRakutenCredentials(env: Record<string, string | undefined> = process.env): RakutenCredentials | string {
  const appId = cleanEnvValue(env.RAKUTEN_APP_ID);
  if (!appId) return "楽天: 環境変数 RAKUTEN_APP_ID が設定されていません。";
  const accessKey = cleanEnvValue(env.RAKUTEN_ACCESS_KEY);
  if (!accessKey) {
    return "楽天: 環境変数 RAKUTEN_ACCESS_KEY が設定されていません（2026 年の楽天 API の移行で、アプリ ID とアクセスキーの両方が必要になりました）。";
  }
  const affiliateId = cleanEnvValue(env.RAKUTEN_AFFILIATE_ID);
  return { appId, accessKey, affiliateId: affiliateId || undefined };
}

/**
 * サーバーから楽天に送る Referer / Origin（楽天のアプリ設定の「許可されたWebサイト」と一致している必要がある）。
 * 優先順: RAKUTEN_SITE_URL → Vercel の本番 URL（VERCEL_PROJECT_PRODUCTION_URL、Vercel が自動で設定）→ 開いている URL。
 */
export function rakutenSiteOrigin(siteOrigin: string | undefined, env: Record<string, string | undefined>): string | undefined {
  const raw = cleanEnvValue(env.RAKUTEN_SITE_URL) || cleanEnvValue(env.VERCEL_PROJECT_PRODUCTION_URL) || siteOrigin;
  if (!raw) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).origin;
  } catch {
    return undefined;
  }
}

export async function searchRakuten(
  params: DomesticSearchParams,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<RawDomesticOffer[]> {
  const creds = readRakutenCredentials(env);
  if (typeof creds === "string") throw new DomesticApiError(creds);
  const origin = rakutenSiteOrigin(params.siteOrigin, env);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (origin) {
    headers.Referer = `${origin}/`;
    headers.Origin = origin;
  }
  const result = await fetchRakuten(params, creds, origin, fetchFn, headers);
  if ("error" in result) throw new DomesticApiError(result.error);
  return result.offers;
}

// ---- Yahoo!ショッピング（商品検索 API v3）----
// https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html

const YAHOO_URL = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";
const YAHOO_RESULTS = 50;

type YahooHit = {
  name?: string;
  description?: string;
  url?: string;
  price?: number;
  janCode?: string;
  /** "new" / "used" */
  condition?: string;
  image?: { medium?: string };
  seller?: { name?: string };
  /** code 1: 設定なし, 2: 送料無料, 3: 条件付き送料無料 */
  shipping?: { code?: number };
  /** amount: 通常ポイント, bonusAmount: ストアのボーナス（PayPay ポイント） */
  /**
   * ポイント。2025 年 2 月から amount・bonusAmount は 0 固定になり、ストアポイントは
   * lyLimitedBonusAmount（PayPay ポイント（期間限定））で返る
   */
  point?: { amount?: number; bonusAmount?: number; lyLimitedBonusAmount?: number };
};

export function isYahooConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return cleanEnvValue(env.YAHOO_CLIENT_ID) !== "";
}

function yahooShipping(code: number | undefined): ShippingStatus {
  if (code === 2) return "free";
  return "unknown";
}

/** Yahoo! のポイント（通常＋ストアのボーナス）[円]。LYP 会員などの上乗せは画面の設定で足す */
export function yahooPoints(point: YahooHit["point"]): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  // 新しい項目（PayPay ポイント（期間限定））を優先し、なければ古い項目（2025 年 1 月までのデータ）
  return Math.floor(n(point?.lyLimitedBonusAmount) || n(point?.amount) + n(point?.bonusAmount));
}

export type YahooSearchParams =
  | { jan: string; keyword?: undefined }
  | { keyword: string; jan?: undefined };

/** Yahoo!ショッピングで新品・在庫ありの商品を探す（JAN 指定なら JAN で、なければキーワードで） */
export async function searchYahoo(
  params: YahooSearchParams,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<RawDomesticOffer[]> {
  const clientId = cleanEnvValue(env.YAHOO_CLIENT_ID);
  if (!clientId) throw new DomesticApiError("Yahoo!: 環境変数 YAHOO_CLIENT_ID が設定されていません。");

  const url = new URL(YAHOO_URL);
  url.searchParams.set("appid", clientId);
  if (params.jan) url.searchParams.set("jan_code", params.jan);
  else url.searchParams.set("query", params.keyword ?? "");
  url.searchParams.set("results", String(YAHOO_RESULTS));
  url.searchParams.set("in_stock", "true");
  url.searchParams.set("condition", "new");
  url.searchParams.set("sort", "+price");

  let res: Response;
  try {
    res = await fetchFn(url, { cache: "no-store" });
  } catch {
    throw new DomesticApiError("Yahoo!: 接続できませんでした（通信エラー）。");
  }
  const data = (await res.json().catch(() => ({}))) as {
    hits?: YahooHit[];
    Error?: { Message?: string };
  };
  if (!res.ok) {
    const detail = data.Error?.Message ?? `HTTP ${res.status}`;
    throw new DomesticApiError(
      res.status === 429
        ? "Yahoo!: アクセスが多すぎます。少し待ってからもう一度試してください。"
        : `Yahoo!: 検索に失敗しました（${detail}）。`,
    );
  }

  return (data.hits ?? []).flatMap((hit): RawDomesticOffer[] => {
    const price = Number(hit.price);
    if (!hit.name || !hit.url || !Number.isFinite(price)) return [];
    return [
      {
        mall: "yahoo",
        title: normalizeText(hit.name),
        priceJpy: price,
        shipping: yahooShipping(hit.shipping?.code),
        pointsJpy: yahooPoints(hit.point),
        url: hit.url,
        shopName: hit.seller?.name ?? "",
        imageUrl: hit.image?.medium || undefined,
        searchText: `${hit.name} ${hit.description ?? ""}`,
        jan: hit.janCode || undefined,
        used: hit.condition === "used" || undefined,
      },
    ];
  });
}

// ---- 全自動リサーチ用: Yahoo! の人気ランキング（評価の高い人気商品ランキング）----
// https://developer.yahoo.co.jp/webapi/shopping/shopping/v1/highRatingTrendRanking.html
// 商品ごとに JAN（jan_code）が返るので、そのまま 3 モール比較に回せる。

const YAHOO_RANKING_URL = "https://shopping.yahooapis.jp/ShoppingWebService/V1/highRatingTrendRanking";
const YAHOO_CATEGORY_URL = "https://shopping.yahooapis.jp/ShoppingWebService/V1/json/categorySearch";

export type DiscoveredItem = { jan: string; title: string; imageUrl?: string; priceJpy?: number; note: string };

type YahooRankingItem = {
  rank?: number;
  item_information?: { name?: string; jan_code?: string; regular_price?: number; bargain_price?: number };
  image?: { medium?: string };
};

/** Yahoo! のトップ階層のカテゴリ（ID と名前）。1 度だけ取得して使い回す */
let yahooRootCategories: Promise<{ id: string; title: string }[]> | undefined;

export function resetYahooCategoryCache() {
  yahooRootCategories = undefined;
}

async function loadYahooRootCategories(clientId: string, fetchFn: typeof fetch): Promise<{ id: string; title: string }[]> {
  const url = new URL(YAHOO_CATEGORY_URL);
  url.searchParams.set("appid", clientId);
  url.searchParams.set("category_id", "1");
  const res = await fetchFn(url, { cache: "no-store" });
  if (!res.ok) throw new DomesticApiError(`Yahoo!: カテゴリを取得できませんでした（HTTP ${res.status}）。`);
  const data = (await res.json().catch(() => ({}))) as {
    ResultSet?: Record<string, { Result?: { Categories?: { Children?: Record<string, { Id?: string | number; Title?: { Short?: string; Medium?: string } }> } } }>;
  };
  // ResultSet["0"].Result.Categories.Children は {"0": {...}, "1": {...}, "_container": ...} の形
  const result = Object.values(data.ResultSet ?? {}).find((v) => typeof v === "object" && v?.Result)?.Result;
  const children = Object.values(result?.Categories?.Children ?? {});
  return children.flatMap((c) => {
    const title = c?.Title?.Short ?? c?.Title?.Medium;
    return c?.Id !== undefined && title ? [{ id: String(c.Id), title }] : [];
  });
}

/**
 * Yahoo! の人気ランキングから、JAN のある新品の商品を集める。
 * @param categoryPattern カテゴリ名に合う正規表現（なければ全体のランキング）
 */
export async function discoverYahooRanking(
  categoryPattern: RegExp | undefined,
  limit: number,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<{ items: DiscoveredItem[]; warnings: string[] }> {
  const clientId = cleanEnvValue(env.YAHOO_CLIENT_ID);
  if (!clientId) throw new DomesticApiError("Yahoo!: 環境変数 YAHOO_CLIENT_ID が設定されていません。");
  const warnings: string[] = [];

  let categoryIds: string[] = [];
  if (categoryPattern) {
    yahooRootCategories ??= loadYahooRootCategories(clientId, fetchFn).catch((e) => {
      yahooRootCategories = undefined;
      throw e;
    });
    const roots = await yahooRootCategories;
    categoryIds = roots.filter((c) => categoryPattern.test(c.title)).map((c) => c.id);
    if (categoryIds.length === 0) warnings.push("Yahoo!: 選んだカテゴリが見つからなかったため、全体のランキングを使いました。");
  }

  const url = new URL(YAHOO_RANKING_URL);
  url.searchParams.set("appid", clientId);
  url.searchParams.set("limit", String(Math.min(100, Math.max(1, limit * 2))));
  if (categoryIds.length > 0) url.searchParams.set("genre_category_id", categoryIds.join(","));
  const res = await fetchFn(url, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { high_rating_trend_ranking?: { ranking_data?: YahooRankingItem[] }; Error?: { Message?: string } };
  if (!res.ok) throw new DomesticApiError(`Yahoo!: ランキングを取得できませんでした（${data.Error?.Message ?? `HTTP ${res.status}`}）。`);

  const items: DiscoveredItem[] = [];
  for (const r of data.high_rating_trend_ranking?.ranking_data ?? []) {
    const jan = (r.item_information?.jan_code ?? "").trim();
    const title = r.item_information?.name;
    if (!/^(\d{8}|\d{13})$/.test(jan) || !title || items.some((i) => i.jan === jan)) continue;
    const price = r.item_information?.bargain_price || r.item_information?.regular_price;
    items.push({
      jan,
      title: normalizeText(title),
      imageUrl: r.image?.medium || undefined,
      priceJpy: price || undefined,
      note: `Yahoo!ランキング ${r.rank ?? "-"}位`,
    });
    if (items.length >= limit) break;
  }
  return { items, warnings };
}
