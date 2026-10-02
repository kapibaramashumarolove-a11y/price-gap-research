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
// https://webservice.rakuten.co.jp/documentation/ichiba-item-search
// 旧 API（app.rakuten.co.jp）は 2026 年 5 月に停止したため、新しい API 基盤（openapi.rakuten.co.jp）を使う。
// 新しい API では次の 3 つがすべて必要:
//   - アプリ ID（applicationId）とアクセスキー（accessKey ヘッダー）。同じアプリで発行された組み合わせであること
//   - Referer / Origin ヘッダーが、楽天のアプリ設定の「許可されたWebサイト」に登録したドメインと一致すること

const RAKUTEN_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601";
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

/**
 * 楽天に送る Referer / Origin（楽天のアプリ設定の「許可されたWebサイト」と一致している必要がある）。
 * 優先順: RAKUTEN_SITE_URL → Vercel の本番 URL（VERCEL_PROJECT_PRODUCTION_URL、Vercel が自動で設定）→ 開いている URL。
 * Vercel ではデプロイごとに URL（例: price-gap-research-c2i9bcd5a-….vercel.app）が変わるため、
 * 開いている URL ではなく、変わらない本番 URL を優先する。
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

/** 楽天のエラーを、直し方が分かる日本語にする（楽天の「許可されたWebサイト」と見比べられるよう、送った URL も添える） */
function rakutenErrorMessage(status: number, detail: string, origin: string | undefined): string {
  if (status === 429) return "楽天: アクセスが多すぎます。少し待ってからもう一度試してください。";
  const sent = `［HTTP ${status}・楽天に送ったサイト URL: ${origin ?? "なし"}］`;
  if (/access ?key/i.test(detail)) {
    return `楽天: アクセスキーが正しくありません（${detail}）。RAKUTEN_ACCESS_KEY が、RAKUTEN_APP_ID と同じアプリのアクセスキーか確認してください。${sent}`;
  }
  if (/applicationId/i.test(detail)) {
    return `楽天: アプリ ID が正しくありません（${detail}）。2026 年の新しい楽天ウェブサービスで登録したアプリのアプリケーション ID を RAKUTEN_APP_ID に設定してください。${sent}`;
  }
  if (/refer|origin|domain|site/i.test(detail) || status === 403) {
    return `楽天: アクセスが拒否されました（${detail}）。楽天のアプリ設定の「許可されたWebサイト」に ${origin ?? "このサイトの URL"} を登録しているか確認してください。${sent}`;
  }
  return `楽天: 検索に失敗しました（${detail}）。${sent}`;
}

export async function searchRakuten(
  params: DomesticSearchParams,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<RawDomesticOffer[]> {
  const appId = cleanEnvValue(env.RAKUTEN_APP_ID);
  if (!appId) throw new DomesticApiError("楽天: 環境変数 RAKUTEN_APP_ID が設定されていません。");
  const accessKey = cleanEnvValue(env.RAKUTEN_ACCESS_KEY);
  if (!accessKey) {
    throw new DomesticApiError(
      "楽天: 環境変数 RAKUTEN_ACCESS_KEY が設定されていません（2026 年の楽天 API の移行で、アプリ ID とアクセスキーの両方が必要になりました）。",
    );
  }
  const affiliateId = cleanEnvValue(env.RAKUTEN_AFFILIATE_ID);
  const origin = rakutenSiteOrigin(params.siteOrigin, env);

  const url = new URL(RAKUTEN_URL);
  url.searchParams.set("applicationId", appId);
  if (affiliateId) url.searchParams.set("affiliateId", affiliateId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("keyword", params.keyword);
  url.searchParams.set("hits", String(RAKUTEN_HITS));
  url.searchParams.set("availability", "1");
  url.searchParams.set("imageFlag", "1");
  if (params.minPriceJpy) url.searchParams.set("minPrice", String(params.minPriceJpy));
  if (params.maxPriceJpy) url.searchParams.set("maxPrice", String(params.maxPriceJpy));

  // アクセスキーは URL に載せず（ログに残りにくいように）ヘッダーで送る
  const headers: Record<string, string> = { accessKey, Accept: "application/json" };
  if (origin) {
    headers.Referer = `${origin}/`;
    headers.Origin = origin;
  }

  const res = await fetchFn(url, { headers, cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as {
    Items?: RakutenItem[];
    error?: string;
    error_description?: string;
    errors?: { errorMessage?: string };
  };
  // 0 件のときは 404（not_found）が返る
  if (res.status === 404 && data.error === "not_found") return [];
  if (!res.ok) {
    const detail = data.errors?.errorMessage ?? data.error_description ?? `HTTP ${res.status}`;
    throw new DomesticApiError(rakutenErrorMessage(res.status, detail, origin));
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
