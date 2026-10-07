// Amazon.co.jp の商品・価格・手数料を Selling Partner API（SP-API）で調べる（サーバー側専用）。
// キー（AMAZON_SP_*）を扱うので、ブラウザ側からは import しないこと。
//
// 必要なもの: Amazon セラーセントラルの大口出品アカウントと、SP-API の開発者登録（自分のアカウント用の「プライベートアプリ」）。
//   AMAZON_SP_CLIENT_ID      … LWA のクライアント ID（amzn1.application-oa2-client.…）
//   AMAZON_SP_CLIENT_SECRET  … LWA のクライアントシークレット
//   AMAZON_SP_REFRESH_TOKEN  … アプリを自分のアカウントで承認したときのリフレッシュトークン（Atzr|…）
// 2023 年 10 月から AWS の署名（SigV4）は不要になり、LWA のアクセストークンだけで呼べる。
//
// 使う API（日本は極東エンドポイント・マーケットプレイス A1VC38T7YXB528）:
//   - Catalog Items 2022-04-01 searchCatalogItems … JAN から ASIN・商品名・画像・売れ筋ランキング（2 回/秒）
//   - Product Pricing v0 getItemOffers          … 新品の出品・カート価格・ポイント（0.5 回/秒）
//   - Product Fees v0 getMyFeesEstimateForASIN  … FBA で売るときの手数料の見積もり（1 回/秒）

import { cleanEnvValue } from "./env";
import type { AmazonProduct, MallOffer } from "./malls";

export const AMAZON_SP_ENDPOINT = "https://sellingpartnerapi-fe.amazon.com";
export const AMAZON_JP_MARKETPLACE = "A1VC38T7YXB528";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
/** Amazon.co.jp 自身が販売している出品の出品者 ID */
const AMAZON_JP_SELLER_ID = "AN1VRQENFRJN5";

export type AmazonCredentials = { clientId: string; clientSecret: string; refreshToken: string };

/** 画面にそのまま表示してよい（キーの値を含まない）エラー */
export class AmazonApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmazonApiError";
  }
}

/** Amazon のキー。3 つともそろっていなければ undefined（Amazon を使わずに比べる） */
export function readAmazonCredentials(env: Record<string, string | undefined> = process.env): AmazonCredentials | undefined {
  const clientId = cleanEnvValue(env.AMAZON_SP_CLIENT_ID);
  const clientSecret = cleanEnvValue(env.AMAZON_SP_CLIENT_SECRET);
  const refreshToken = cleanEnvValue(env.AMAZON_SP_REFRESH_TOKEN);
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
}

export type AmazonDeps = {
  fetchFn?: typeof fetch;
  /** 待ち時間（テストでは待たない） */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

// ---- アクセストークン（1 時間有効。期限の 1 分前まで使い回す）----

let tokenCache: { key: string; token: string; expiresAt: number } | undefined;

/** テスト用: 使い回しているトークンと呼び出し間隔の記録を消す */
export function resetAmazonState() {
  tokenCache = undefined;
  lastCall.clear();
}

async function accessToken(creds: AmazonCredentials, fetchFn: typeof fetch, now: () => number): Promise<string> {
  const key = `${creds.clientId}:${creds.refreshToken}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > now()) return tokenCache.token;
  let res: Response;
  try {
    res = await fetchFn(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      cache: "no-store",
    });
  } catch {
    throw new AmazonApiError("Amazon: 認証サーバーに接続できませんでした（通信エラー）。");
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    const detail = [data.error, data.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
    throw new AmazonApiError(
      `Amazon: アクセストークンを取得できませんでした（${detail}）。AMAZON_SP_CLIENT_ID・AMAZON_SP_CLIENT_SECRET・AMAZON_SP_REFRESH_TOKEN が同じアプリのものか確認してください。`,
    );
  }
  tokenCache = { key, token: data.access_token, expiresAt: now() + Math.max(60, (data.expires_in ?? 3600) - 60) * 1000 };
  return data.access_token;
}

// ---- 呼び出し間隔の制限（API ごとの上限を超えないよう、同じサーバー内で間を空ける）----

type Operation = "catalog" | "offers" | "fees";
const MIN_INTERVAL_MS: Record<Operation, number> = { catalog: 500, offers: 2000, fees: 1000 };
const lastCall = new Map<Operation, number>();

async function throttle(op: Operation, sleep: (ms: number) => Promise<void>, now: () => number) {
  const wait = (lastCall.get(op) ?? -Infinity) + MIN_INTERVAL_MS[op] - now();
  if (wait > 0) await sleep(wait);
  lastCall.set(op, now());
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function spApi<T>(
  op: Operation,
  creds: AmazonCredentials,
  path: string,
  init: { method?: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
  deps: AmazonDeps,
): Promise<T> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const url = new URL(path, AMAZON_SP_ENDPOINT);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  // 上限を超えた（429）ときは 1 回だけ待ってやり直す
  for (let attempt = 0; ; attempt++) {
    await throttle(op, sleep, now);
    const token = await accessToken(creds, fetchFn, now);
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: init.method ?? "GET",
        headers: {
          "x-amz-access-token": token,
          Accept: "application/json",
          "User-Agent": "price-gap-research/1.0 (Language=TypeScript)",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new AmazonApiError("Amazon: 接続できませんでした（通信エラー）。");
    }
    if (res.status === 429 && attempt === 0) {
      await sleep(MIN_INTERVAL_MS[op] * 2);
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as T & { errors?: { code?: string; message?: string }[] };
    if (!res.ok) {
      const detail = data.errors?.map((e) => [e.code, e.message].filter(Boolean).join(": ")).join(" / ") || `HTTP ${res.status}`;
      if (res.status === 429) throw new AmazonApiError("Amazon: アクセスが多すぎます。少し待ってからもう一度試してください。");
      if (res.status === 401 || res.status === 403) {
        throw new AmazonApiError(
          `Amazon: SP-API の利用が拒否されました（${detail}）。アプリに「商品の価格設定」「商品カタログ」の権限（ロール）があり、自分のアカウントで承認済みか確認してください。`,
        );
      }
      throw new AmazonApiError(`Amazon: 取得に失敗しました（${detail}）。`);
    }
    return data;
  }
}

// ---- カタログ（JAN → ASIN）----

type CatalogItem = {
  asin?: string;
  identifiers?: { marketplaceId?: string; identifiers?: { identifierType?: string; identifier?: string }[] }[];
  summaries?: { marketplaceId?: string; itemName?: string }[];
  images?: { marketplaceId?: string; images?: { variant?: string; link?: string; height?: number }[] }[];
  salesRanks?: {
    marketplaceId?: string;
    displayGroupRanks?: { title?: string; rank?: number }[];
    classificationRanks?: { title?: string; rank?: number }[];
  }[];
};

/** カタログの商品に、その JAN（EAN）がそのまま登録されているか（識別子が返ってこなければ確かめられないので true） */
function itemHasJan(item: CatalogItem, jan: string): boolean {
  const ids = (item.identifiers ?? []).flatMap((g) => g.identifiers ?? []);
  if (ids.length === 0) return true;
  return ids.some((i) => /^(EAN|JAN|UPC)$/i.test(i.identifierType ?? "") && (i.identifier ?? "").replace(/^0+/, "") === jan.replace(/^0+/, ""));
}

/** 売れ筋ランキング（大きなカテゴリの順位を優先） */
function salesRankOf(item: CatalogItem): { rank?: number; category?: string } {
  const ranks = item.salesRanks?.find((r) => r.marketplaceId === AMAZON_JP_MARKETPLACE) ?? item.salesRanks?.[0];
  const best = ranks?.displayGroupRanks?.find((r) => Number.isFinite(r.rank)) ?? ranks?.classificationRanks?.find((r) => Number.isFinite(r.rank));
  return best ? { rank: best.rank, category: best.title } : {};
}

function mainImage(item: CatalogItem): string | undefined {
  const images = (item.images?.find((g) => g.marketplaceId === AMAZON_JP_MARKETPLACE) ?? item.images?.[0])?.images ?? [];
  const main = images.filter((i) => i.variant === "MAIN" && i.link?.startsWith("https://"));
  // 一覧で使うので小さめの画像を選ぶ
  return [...main].sort((a, b) => (a.height ?? 0) - (b.height ?? 0)).find((i) => (i.height ?? 0) >= 75)?.link ?? main[0]?.link;
}

export async function searchCatalogByJan(jan: string, creds: AmazonCredentials, deps: AmazonDeps = {}): Promise<CatalogItem[]> {
  const data = await spApi<{ items?: CatalogItem[] }>(
    "catalog",
    creds,
    "/catalog/2022-04-01/items",
    {
      query: {
        identifiers: jan,
        identifiersType: jan.length === 8 ? "EAN" : "JAN",
        marketplaceIds: AMAZON_JP_MARKETPLACE,
        includedData: "summaries,salesRanks,images,identifiers",
        locale: "ja_JP",
      },
    },
    deps,
  );
  return (data.items ?? []).filter((i) => i.asin && itemHasJan(i, jan));
}

// ---- 出品（新品の価格・ポイント）----

type Money = { CurrencyCode?: string; Amount?: number };
type OffersPayload = {
  status?: string;
  Summary?: {
    TotalOfferCount?: number;
    NumberOfOffers?: { condition?: string; fulfillmentChannel?: string; OfferCount?: number }[];
    LowestPrices?: { condition?: string; fulfillmentChannel?: string; LandedPrice?: Money; ListingPrice?: Money }[];
    BuyBoxPrices?: { condition?: string; LandedPrice?: Money }[];
  };
  Offers?: {
    SellerId?: string;
    SubCondition?: string;
    ListingPrice?: Money;
    Shipping?: Money;
    Points?: { PointsNumber?: number };
    IsFulfilledByAmazon?: boolean;
    IsBuyBoxWinner?: boolean;
  }[];
};

const isNew = (condition: string | undefined) => (condition ?? "").toLowerCase() === "new";
const amount = (m: Money | undefined) => (typeof m?.Amount === "number" && Number.isFinite(m.Amount) ? m.Amount : undefined);

export function amazonProductUrl(asin: string): string {
  return `https://www.amazon.co.jp/dp/${encodeURIComponent(asin)}`;
}

/** getItemOffers の結果を、価格のまとめと出品の一覧にする */
export function parseOffers(asin: string, title: string, payload: OffersPayload | undefined) {
  const summary = payload?.Summary;
  const lowest = (summary?.LowestPrices ?? []).filter((p) => isNew(p.condition));
  const landed = (p: (typeof lowest)[number]) => amount(p.LandedPrice) ?? amount(p.ListingPrice);
  const min = (values: (number | undefined)[]) => {
    const nums = values.filter((v): v is number => v !== undefined);
    return nums.length > 0 ? Math.min(...nums) : undefined;
  };
  const prices = {
    lowestFbaPriceJpy: min(lowest.filter((p) => p.fulfillmentChannel === "Amazon").map(landed)),
    lowestPriceJpy: min(lowest.map(landed)),
    buyBoxPriceJpy: min((summary?.BuyBoxPrices ?? []).filter((p) => isNew(p.condition)).map((p) => amount(p.LandedPrice))),
    offerCount:
      summary?.NumberOfOffers?.filter((n) => isNew(n.condition)).reduce((sum, n) => sum + (n.OfferCount ?? 0), 0) ?? summary?.TotalOfferCount,
  };
  const offers = (payload?.Offers ?? []).flatMap((o): MallOffer[] => {
    const price = amount(o.ListingPrice);
    if (price === undefined) return [];
    const shippingJpy = amount(o.Shipping) ?? 0;
    const seller = o.SellerId === AMAZON_JP_SELLER_ID ? "Amazon.co.jp" : o.IsFulfilledByAmazon ? "出品者（FBA）" : "出品者（自社発送）";
    return [
      {
        mall: "amazon",
        title,
        priceJpy: price,
        shipping: shippingJpy === 0 ? "free" : "extra",
        shippingJpy,
        pointsJpy: Math.max(0, Math.floor(o.Points?.PointsNumber ?? 0)),
        url: o.SellerId ? `${amazonProductUrl(asin)}?smid=${encodeURIComponent(o.SellerId)}` : amazonProductUrl(asin),
        shopName: o.IsBuyBoxWinner ? `${seller}・カート獲得` : seller,
        fba: !!o.IsFulfilledByAmazon,
      },
    ];
  });
  offers.sort((a, b) => a.priceJpy + (a.shippingJpy ?? 0) - (b.priceJpy + (b.shippingJpy ?? 0)));
  return { prices, offers };
}

async function getItemOffers(asin: string, creds: AmazonCredentials, deps: AmazonDeps): Promise<OffersPayload | undefined> {
  const data = await spApi<{ payload?: OffersPayload }>(
    "offers",
    creds,
    `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`,
    { query: { MarketplaceId: AMAZON_JP_MARKETPLACE, ItemCondition: "New", CustomerType: "Consumer" } },
    deps,
  );
  return data.payload;
}

// ---- 手数料の見積もり（FBA で販売）----

async function estimateFbaFees(asin: string, priceJpy: number, creds: AmazonCredentials, deps: AmazonDeps): Promise<number | undefined> {
  const data = await spApi<{
    payload?: { FeesEstimateResult?: { Status?: string; FeesEstimate?: { TotalFeesEstimate?: Money } } };
  }>(
    "fees",
    creds,
    `/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`,
    {
      method: "POST",
      body: {
        FeesEstimateRequest: {
          MarketplaceId: AMAZON_JP_MARKETPLACE,
          IsAmazonFulfilled: true,
          PriceToEstimateFees: {
            ListingPrice: { CurrencyCode: "JPY", Amount: priceJpy },
            Shipping: { CurrencyCode: "JPY", Amount: 0 },
          },
          Identifier: `fee-${asin}-${priceJpy}`,
        },
      },
    },
    deps,
  );
  const result = data.payload?.FeesEstimateResult;
  return result?.Status === "Success" ? amount(result.FeesEstimate?.TotalFeesEstimate) : undefined;
}

// ---- まとめ: 1 つの JAN を Amazon で調べる ----

export type AmazonLookup = { product?: AmazonProduct; offers: MallOffer[]; warnings: string[] };

export async function lookupAmazon(jan: string, creds: AmazonCredentials, deps: AmazonDeps = {}): Promise<AmazonLookup> {
  const warnings: string[] = [];
  const items = await searchCatalogByJan(jan, creds, deps);
  if (items.length === 0) return { offers: [], warnings: ["Amazon: この JAN の商品は登録されていません。"] };

  // 同じ JAN に複数の ASIN があるときは、一番売れている（ランキングの小さい）ものを使う
  const ranked = items
    .map((item) => ({ item, ...salesRankOf(item) }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const { item, rank, category } = ranked[0];
  if (items.length > 1) warnings.push(`Amazon: この JAN に ${items.length} 件の商品ページがあります（一番売れている ${item.asin} で計算）。`);

  const asin = item.asin!;
  const summary = item.summaries?.find((s) => s.marketplaceId === AMAZON_JP_MARKETPLACE) ?? item.summaries?.[0];
  const title = summary?.itemName ?? asin;
  const { prices, offers } = parseOffers(asin, title, await getItemOffers(asin, creds, deps));
  const product: AmazonProduct = {
    asin,
    title,
    imageUrl: mainImage(item),
    salesRank: rank,
    salesRankCategory: category,
    ...prices,
    url: amazonProductUrl(asin),
  };

  // 販売価格（FBA 最安値 → カート価格 → 最安値）で手数料を見積もる。見積もれなくても比較は続ける
  const sellPrice = prices.lowestFbaPriceJpy ?? prices.buyBoxPriceJpy ?? prices.lowestPriceJpy;
  if (sellPrice !== undefined) {
    try {
      const fees = await estimateFbaFees(asin, sellPrice, creds, deps);
      if (fees !== undefined) {
        product.fbaFeesJpy = fees;
        product.feesForPriceJpy = sellPrice;
      } else {
        warnings.push("Amazon: 手数料を見積もれなかったため、設定の割合で計算しています。");
      }
    } catch (e) {
      warnings.push(e instanceof AmazonApiError ? `${e.message}（手数料は設定の割合で計算）` : "Amazon: 手数料を見積もれませんでした。");
    }
  } else {
    warnings.push("Amazon: 新品の出品がありません。");
  }
  return { product, offers, warnings };
}
