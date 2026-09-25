// eBay Browse API を呼び出すサーバー専用のコード。
// EBAY_CLIENT_SECRET を扱うので、ブラウザ側に読み込まれるとビルドエラーになるようにしている。
import "server-only";

import { parseItemSummaries, summarizeListings, type EbayPriceSummary } from "./ebayStats";

/** 画面にそのまま表示してよいエラー（秘密情報を含めないこと） */
export class EbayApiError extends Error {}

type EbayEnvironment = "sandbox" | "production";

const API_HOSTS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

// 公開データを読むだけなので、最低限の権限（スコープ）で十分
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";

/** 1 回の検索で取得する件数（Browse API の上限は 200） */
const SEARCH_LIMIT = 100;

/**
 * 検索条件：即決（オークションは途中価格なので除外）・新品・米ドル建て。
 * conditionIds 1000 = New（スニーカーでは「New with box」）。
 */
const SEARCH_FILTER = "buyingOptions:{FIXED_PRICE},conditionIds:{1000},priceCurrency:USD";

/** 同じキーワードを短時間に何度も検索したときは、API を呼ばずに前回の結果を返す */
const RESULT_CACHE_MS = 10 * 60 * 1000;

function getConfig() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const missing = [
    !clientId && "EBAY_CLIENT_ID",
    !clientSecret && "EBAY_CLIENT_SECRET",
  ].filter(Boolean);
  if (!clientId || !clientSecret) {
    throw new EbayApiError(`環境変数 ${missing.join(" / ")} が設定されていません。README の手順で設定してください。`);
  }

  const envName = (process.env.EBAY_ENVIRONMENT ?? "").trim().toLowerCase() || "sandbox";
  if (envName !== "sandbox" && envName !== "production") {
    throw new EbayApiError('環境変数 EBAY_ENVIRONMENT は "sandbox" か "production" にしてください。');
  }
  return { clientId, clientSecret, environment: envName as EbayEnvironment };
}

/** fetch のラッパー。タイムアウトや接続失敗を画面向けのエラーに変換する */
async function ebayFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.error("eBay network error", e);
    throw new EbayApiError("eBay に接続できませんでした。時間をおいて再度お試しください。");
  }
}

// アクセストークンは約 2 時間有効なので、期限が切れるまで使い回す
let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

async function getAccessToken(config: ReturnType<typeof getConfig>): Promise<string> {
  const key = `${config.environment}:${config.clientId}`;
  if (cachedToken && cachedToken.key === key && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await ebayFetch(`${API_HOSTS[config.environment]}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: OAUTH_SCOPE }),
  });
  if (!res.ok) {
    // レスポンス本文には詳細が入ることがあるので、サーバーのログにだけ出す
    console.error("eBay OAuth error", res.status, await res.text().catch(() => ""));
    throw new EbayApiError(
      res.status === 401
        ? `eBay の認証に失敗しました。キーと EBAY_ENVIRONMENT（現在: ${config.environment}）の組み合わせを確認してください。`
        : `eBay の認証に失敗しました（HTTP ${res.status}）。`,
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    key,
    token: json.access_token,
    // 期限ぎりぎりで失効しないよう 1 分早めに更新する
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return json.access_token;
}

const resultCache = new Map<string, { summary: EbayPriceSummary; expiresAt: number }>();

/** キーワード（型番など）で eBay の出品中の価格を検索して集計する */
export async function searchEbayPrices(query: string): Promise<EbayPriceSummary> {
  const config = getConfig();
  const cacheKey = `${config.environment}:${query.toLowerCase()}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.summary;

  const token = await getAccessToken(config);
  const params = new URLSearchParams({
    q: query,
    filter: SEARCH_FILTER,
    limit: String(SEARCH_LIMIT),
  });

  const res = await ebayFetch(
    `${API_HOSTS[config.environment]}/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        // アメリカの eBay（ebay.com）の出品を対象にする
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    },
  );
  if (!res.ok) {
    console.error("eBay Browse API error", res.status, await res.text().catch(() => ""));
    if (res.status === 401) cachedToken = null; // トークンが無効になっていたら次回取り直す
    throw new EbayApiError(
      res.status === 429
        ? "eBay API の呼び出し回数の上限に達しました。時間をおいて再度お試しください。"
        : `eBay の検索に失敗しました（HTTP ${res.status}）。`,
    );
  }

  const { totalFound, listings } = parseItemSummaries(await res.json());
  const summary = summarizeListings(listings, { query, environment: config.environment, totalFound });
  resultCache.set(cacheKey, { summary, expiresAt: Date.now() + RESULT_CACHE_MS });
  return summary;
}
