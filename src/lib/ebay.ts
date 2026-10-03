// eBay 公式 Browse API から「出品中の価格」を取得するためのロジック（サーバー側専用）。
// キー（EBAY_CLIENT_SECRET など）を扱うので、ブラウザ側のコンポーネントからは import しないこと。
// 画面からは /api/research を経由して呼び出す。

export type EbayEnvironment = "sandbox" | "production";

export type EbayConfig = {
  environment: EbayEnvironment;
  clientId: string;
  clientSecret: string;
};

/** Browse API の itemSummaries の中で、このアプリが使う部分だけ */
export type EbayItemSummary = {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  buyingOptions?: string[];
  itemWebUrl?: string;
};

/** 画面に返す価格のまとめ */
export type PriceSummary = {
  /** 集計に使った件数 */
  count: number;
  /** 中央値 [USD] */
  median: number | null;
  /** 最安値 [USD] */
  min: number | null;
};

/** 画面にそのまま表示してよい（キーの値を含まない）エラー */
export class EbayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EbayApiError";
  }
}

const BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

/** 利益計算が USD 前提なので、米国の eBay（USD 建て）で検索する */
const MARKETPLACE_ID = "EBAY_US";
const CURRENCY = "USD";
const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";
/** 1 回の検索で取得する件数（Browse API の上限は 200） */
const SEARCH_LIMIT = 100;

/**
 * 環境変数の値を整える。前後の空白・改行に加えて、コピー＆ペーストで紛れ込みやすい
 * 目に見えない文字（ゼロ幅スペース U+200B〜U+200D、WORD JOINER U+2060、BOM U+FEFF）を取り除く。
 */
export function cleanEnvValue(value: string | undefined): string {
  return (value ?? "").replace(/[​-‍⁠﻿]/g, "").trim();
}

/** 環境変数から設定を読む。足りない項目があればエラー（値そのものはメッセージに含めない） */
export function readEbayConfig(env: Record<string, string | undefined> = process.env): EbayConfig {
  const clientId = cleanEnvValue(env.EBAY_CLIENT_ID);
  const clientSecret = cleanEnvValue(env.EBAY_CLIENT_SECRET);
  const rawEnvironment = cleanEnvValue(env.EBAY_ENVIRONMENT).toLowerCase() || "sandbox";

  const missing = [
    !clientId && "EBAY_CLIENT_ID",
    !clientSecret && "EBAY_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new EbayApiError(
      `環境変数 ${missing.join(" と ")} が設定されていません。README の「eBay API キーの設定」を参照してください。`,
      500,
    );
  }
  if (rawEnvironment !== "sandbox" && rawEnvironment !== "production") {
    throw new EbayApiError(
      "環境変数 EBAY_ENVIRONMENT には sandbox か production を指定してください。",
      500,
    );
  }
  return { environment: rawEnvironment, clientId, clientSecret };
}

/** 価格の配列から件数・中央値・最安値を求める（小数第 2 位で丸める） */
export function summarizePrices(prices: number[]): PriceSummary {
  const sorted = prices.filter((p) => Number.isFinite(p) && p >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, min: null };
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { count: sorted.length, median: roundCents(median), min: roundCents(sorted[0]) };
}

/** itemSummaries から USD の価格だけを数値で取り出す */
export function extractUsdPrices(items: EbayItemSummary[]): number[] {
  return items
    .filter((item) => item.price?.currency === CURRENCY)
    .map((item) => Number(item.price?.value))
    .filter((n) => Number.isFinite(n));
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- アクセストークン（Client Credentials）----
// トークンは 2 時間ほど有効なので、期限の少し前まではサーバーのメモリに保存して使い回す。

type CachedToken = { key: string; token: string; expiresAt: number };
let cachedToken: CachedToken | null = null;

/** テスト用：保存しているトークンを破棄する */
export function clearTokenCache() {
  cachedToken = null;
}

export async function getAppAccessToken(
  config: EbayConfig,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const key = `${config.environment}:${config.clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > now()) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetchFn(`${BASE_URLS[config.environment]}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: BROWSE_SCOPE }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new EbayApiError(
      res.status === 401
        ? "eBay の認証に失敗しました。EBAY_CLIENT_ID / EBAY_CLIENT_SECRET と EBAY_ENVIRONMENT（sandbox / production）の組み合わせを確認してください。"
        : `eBay のアクセストークン取得に失敗しました（HTTP ${res.status}）。`,
      502,
    );
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new EbayApiError("eBay から想定外の応答がありました（アクセストークンなし）。", 502);
  }
  // 期限の 60 秒前には取り直す
  const expiresInSec = Math.max((data.expires_in ?? 0) - 60, 0);
  cachedToken = { key, token: data.access_token, expiresAt: now() + expiresInSec * 1000 };
  return data.access_token;
}

// ---- 出品中の価格の検索 ----

/** Browse API の filter パラメータを組み立てる */
export function buildSearchFilter(conditionIds: readonly string[]): string {
  const filters = ["buyingOptions:{FIXED_PRICE}", `priceCurrency:${CURRENCY}`];
  if (conditionIds.length > 0) filters.push(`conditionIds:{${conditionIds.join("|")}}`);
  return filters.join(",");
}

export type ListingSearchParams = {
  /** 検索キーワード（gtin を指定する場合は省略可） */
  q?: string;
  /** JAN / UPC / EAN コード。eBay の商品カタログに紐づく出品だけに絞り込める */
  gtin?: string;
  /** 絞り込むコンディション ID。空配列なら絞り込みなし */
  conditionIds: readonly string[];
};

export type ListingSearchResult = {
  /** eBay 上でヒットした総件数 */
  total: number;
  items: EbayItemSummary[];
};

/** Browse API の item_summary/search を 1 回呼ぶ（即決・USD のみ） */
export async function searchEbayListings(
  params: ListingSearchParams,
  config: EbayConfig = readEbayConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<ListingSearchResult> {
  const q = params.q?.trim() ?? "";
  const gtin = params.gtin?.trim() ?? "";
  if (q === "" && gtin === "") throw new EbayApiError("検索キーワードを入力してください。", 400);

  const token = await getAppAccessToken(config, fetchFn);

  const url = new URL(`${BASE_URLS[config.environment]}/buy/browse/v1/item_summary/search`);
  if (q) url.searchParams.set("q", q);
  if (gtin) url.searchParams.set("gtin", gtin);
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  url.searchParams.set("filter", buildSearchFilter(params.conditionIds));

  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 401) clearTokenCache();
    throw new EbayApiError(`eBay Browse API の呼び出しに失敗しました（HTTP ${res.status}）。`, 502);
  }

  const data = (await res.json()) as { total?: number; itemSummaries?: EbayItemSummary[] };
  const items = data.itemSummaries ?? [];
  return { total: data.total ?? items.length, items };
}
