// 楽天市場・Yahoo!ショッピングの公式 API で国内の商品を検索する（サーバー側専用）。
// キー（RAKUTEN_APP_ID / YAHOO_CLIENT_ID）を扱うので、ブラウザ側からは import しないこと。

import { cleanEnvValue } from "./ebay";
import { normalizeText } from "./identify";
import type { DomesticOffer, ResearchKind, ShippingStatus } from "./researchTypes";

/** 識別子（JAN）を探すための説明文などを付けた商品データ。画面には返さない */
export type RawDomesticOffer = DomesticOffer & {
  /** 識別子を探すときに使う文章（タイトル＋説明文） */
  searchText: string;
  /** API から分かる JAN（Yahoo! のみ） */
  jan?: string;
};

export type DomesticSearchParams = {
  kind: ResearchKind;
  keyword: string;
  minPriceJpy?: number;
  maxPriceJpy?: number;
};

/** 画面にそのまま表示してよい（キーの値を含まない）エラー */
export class DomesticApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomesticApiError";
  }
}

// ---- 楽天市場（商品検索 API 2022-06-01）----
// https://webservice.rakuten.co.jp/documentation/ichiba-item-search
// 楽天は新しい API 基盤（openapi.rakuten.co.jp、accessKey が必要）へ移行中のため、
// RAKUTEN_ACCESS_KEY が設定されていれば新しい方、なければ従来の方を使う。

const RAKUTEN_LEGACY_URL = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601";
const RAKUTEN_OPENAPI_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601";
/** 1 回で取れる最大件数 */
const RAKUTEN_HITS = 30;

type RakutenItem = {
  itemName?: string;
  itemPrice?: number;
  itemUrl?: string;
  affiliateUrl?: string;
  shopName?: string;
  itemCaption?: string;
  /** 0: 送料込み, 1: 送料別 */
  postageFlag?: number;
  mediumImageUrls?: (string | { imageUrl?: string })[];
};

export function isRakutenConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return cleanEnvValue(env.RAKUTEN_APP_ID) !== "";
}

export async function searchRakuten(
  params: DomesticSearchParams,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<RawDomesticOffer[]> {
  const appId = cleanEnvValue(env.RAKUTEN_APP_ID);
  if (!appId) throw new DomesticApiError("楽天: 環境変数 RAKUTEN_APP_ID が設定されていません。");
  const accessKey = cleanEnvValue(env.RAKUTEN_ACCESS_KEY);
  const affiliateId = cleanEnvValue(env.RAKUTEN_AFFILIATE_ID);

  const url = new URL(accessKey ? RAKUTEN_OPENAPI_URL : RAKUTEN_LEGACY_URL);
  url.searchParams.set("applicationId", appId);
  if (accessKey) url.searchParams.set("accessKey", accessKey);
  if (affiliateId) url.searchParams.set("affiliateId", affiliateId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("keyword", params.keyword);
  url.searchParams.set("hits", String(RAKUTEN_HITS));
  url.searchParams.set("availability", "1");
  url.searchParams.set("imageFlag", "1");
  if (params.minPriceJpy) url.searchParams.set("minPrice", String(params.minPriceJpy));
  if (params.maxPriceJpy) url.searchParams.set("maxPrice", String(params.maxPriceJpy));

  const res = await fetchFn(url, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as {
    Items?: RakutenItem[];
    error?: string;
    error_description?: string;
    errors?: { errorMessage?: string };
  };
  // 0 件のときは 404（not_found）が返る
  if (res.status === 404 && data.error === "not_found") return [];
  if (!res.ok) {
    const detail = data.error_description ?? data.errors?.errorMessage ?? `HTTP ${res.status}`;
    throw new DomesticApiError(
      res.status === 429
        ? "楽天: アクセスが多すぎます。少し待ってからもう一度試してください。"
        : `楽天: 検索に失敗しました（${detail}）。`,
    );
  }

  return (data.Items ?? []).flatMap((item): RawDomesticOffer[] => {
    const price = Number(item.itemPrice);
    if (!item.itemName || !item.itemUrl || !Number.isFinite(price)) return [];
    const image = item.mediumImageUrls?.[0];
    return [
      {
        source: "rakuten",
        title: normalizeText(item.itemName),
        priceJpy: price,
        shipping: item.postageFlag === 0 ? "free" : item.postageFlag === 1 ? "extra" : "unknown",
        url: item.affiliateUrl || item.itemUrl,
        shopName: item.shopName ?? "",
        imageUrl: (typeof image === "string" ? image : image?.imageUrl) || undefined,
        searchText: `${item.itemName} ${item.itemCaption ?? ""}`,
      },
    ];
  });
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
  image?: { medium?: string };
  seller?: { name?: string };
  /** code 1: 設定なし, 2: 送料無料, 3: 条件付き送料無料 */
  shipping?: { code?: number };
};

export function isYahooConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return cleanEnvValue(env.YAHOO_CLIENT_ID) !== "";
}

function yahooShipping(code: number | undefined): ShippingStatus {
  if (code === 2) return "free";
  return "unknown";
}

export async function searchYahoo(
  params: DomesticSearchParams,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<RawDomesticOffer[]> {
  const clientId = cleanEnvValue(env.YAHOO_CLIENT_ID);
  if (!clientId) throw new DomesticApiError("Yahoo!: 環境変数 YAHOO_CLIENT_ID が設定されていません。");

  const url = new URL(YAHOO_URL);
  url.searchParams.set("appid", clientId);
  url.searchParams.set("query", params.keyword);
  url.searchParams.set("results", String(YAHOO_RESULTS));
  url.searchParams.set("in_stock", "true");
  // 未開封 BOX・その他は新品だけ。カードは中古扱いで出品されることが多いので絞らない
  if (params.kind === "sealed" || params.kind === "other") url.searchParams.set("condition", "new");
  if (params.minPriceJpy) url.searchParams.set("price_from", String(params.minPriceJpy));
  if (params.maxPriceJpy) url.searchParams.set("price_to", String(params.maxPriceJpy));

  const res = await fetchFn(url, { cache: "no-store" });
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
        source: "yahoo",
        title: normalizeText(hit.name),
        priceJpy: price,
        shipping: yahooShipping(hit.shipping?.code),
        url: hit.url,
        shopName: hit.seller?.name ?? "",
        imageUrl: hit.image?.medium || undefined,
        searchText: `${hit.name} ${hit.description ?? ""}`,
        jan: hit.janCode || undefined,
      },
    ];
  });
}
