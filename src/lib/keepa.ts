// Keepa API で Amazon.co.jp の価格・売れ筋・手数料・リスク判定用のデータを調べる（サーバー側専用）。
// キー（KEEPA_API_KEY）を扱うので、ブラウザ側からは import しないこと。
//
// Keepa の API はキーを URL の key パラメーターで受け取る仕様なので、URL はログやエラーに出さないこと。
// https://keepa.com/#!discuss/t/request-products/110
//
// 取得するもの（1 回の product リクエスト。JAN = code パラメーター）:
//   stats=90     … 現在値・90 日平均（カート価格の 90 日平均）・ランキング変動回数・在庫切れ率・カート獲得率
//   buybox=1     … カート価格と、カートを持っている出品者（FBA／自己発送／Amazon 本体）
//   history=1, days=15 … 直近 15 日の履歴（新品出品者数の 7 日・14 日前の値を読むため。古い履歴は付けない）
// バリエーション商品は、親 ASIN と兄弟 ASIN をもう 1〜2 回調べて「この色・サイズの売れ筋シェア」を出す
// （兄弟の数だけトークンを使うので、上限を超える場合は調べずに注意だけ出す）。

import { cleanEnvValue } from "./env";
import type { AmazonLookup } from "./amazon";
import type { AmazonProduct, MallOffer } from "./malls";

const KEEPA_URL = "https://api.keepa.com/product";
/** Keepa のドメイン番号（5 = Amazon.co.jp） */
const KEEPA_DOMAIN_JP = "5";
/** 平均・販売回数・在庫切れ率を集計する日数 */
const STATS_DAYS = "90";
/** 出品者数の推移を見るために付ける履歴の日数 */
const HISTORY_DAYS = "15";
/** バリエーションの売れ筋シェアを調べる兄弟 ASIN の上限（1 ASIN につき 1 トークン。まとめて 1 回で取得し、6 時間使い回す） */
export const MAX_VARIATIONS_TO_CHECK = 50;
/** Amazon.co.jp 本体の出品者 ID */
const AMAZON_JP_SELLER_ID = "AN1VRQENFRJN5";

/** stats.current・csv の添字（Keepa の CsvType） */
const CSV = {
  AMAZON: 0,
  NEW: 1,
  SALES: 3,
  NEW_FBM_SHIPPING: 7,
  NEW_FBA: 10,
  COUNT_NEW: 11,
  COUNT_REVIEWS: 17,
  BUY_BOX_SHIPPING: 18,
} as const;

/** Keepa 時間（2011-01-01 からの分）を Unix 時間（ミリ秒）にする */
export function keepaMinuteToMs(minute: number): number {
  return (minute + 21564000) * 60000;
}

export class KeepaApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeepaApiError";
  }
}

export function readKeepaKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return cleanEnvValue(env.KEEPA_API_KEY) || undefined;
}

type KeepaProduct = {
  asin?: string;
  parentAsin?: string | null;
  title?: string;
  eanList?: string[] | null;
  upcList?: string[] | null;
  images?: { l?: string; m?: string }[] | null;
  imagesCSV?: string | null;
  categoryTree?: { catId?: number; name?: string }[] | null;
  salesRankReference?: number;
  monthlySold?: number;
  referralFeePercentage?: number | null;
  referralFeePercent?: number | null;
  fbaFees?: { pickAndPackFee?: number } | null;
  variations?: { asin?: string; attributes?: { dimension?: string; value?: string }[] }[] | null;
  csv?: (number[] | null)[] | null;
  stats?: {
    current?: number[];
    avg90?: number[];
    outOfStockPercentage90?: number[];
    salesRankDrops30?: number;
    salesRankDrops90?: number;
    buyBoxIsAmazon?: boolean | null;
    buyBoxIsFBA?: boolean | null;
    buyBoxStats?: Record<string, { percentageWon?: number; isFBA?: boolean }> | null;
  } | null;
};

type KeepaResponse = {
  products?: KeepaProduct[];
  tokensLeft?: number;
  refillIn?: number;
  error?: { type?: string; message?: string };
};

/** Keepa の値（-1・-2 はデータなし・在庫なし）を数値か undefined にする */
function value(arr: number[] | undefined | null, index: number): number | undefined {
  const v = arr?.[index];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function count(v: number | undefined | null): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 履歴（[時刻, 値, 時刻, 値, …]）から、指定した時刻の時点の値を読む（その時点より前に記録がなければ undefined） */
export function historyValueAt(history: number[] | null | undefined, atMs: number): number | undefined {
  if (!history || history.length < 2) return undefined;
  let found: number | undefined;
  for (let i = 0; i + 1 < history.length; i += 2) {
    if (keepaMinuteToMs(history[i]) > atMs) break;
    found = history[i + 1];
  }
  return found !== undefined && found >= 0 ? found : undefined;
}

function hasJan(p: KeepaProduct, jan: string): boolean {
  const codes = [...(p.eanList ?? []), ...(p.upcList ?? [])];
  if (codes.length === 0) return true;
  const strip = (c: string) => c.replace(/^0+/, "");
  return codes.some((c) => strip(String(c)) === strip(jan));
}

function imageOf(p: KeepaProduct): string | undefined {
  const name = p.images?.[0]?.m ?? p.images?.[0]?.l ?? p.imagesCSV?.split(",")[0];
  return name && /^[\w.+-]+$/.test(name) ? `https://m.media-amazon.com/images/I/${name}` : undefined;
}

/**
 * Keepa の商品を、画面で使う Amazon の情報と「Amazon で仕入れる」場合の出品にする。
 * @param nowMs 出品者数の 7 日・14 日前を計算する基準の時刻
 */
export function parseKeepaProduct(p: KeepaProduct, nowMs: number = Date.now()): AmazonLookup {
  const asin = p.asin ?? "";
  const url = `https://www.amazon.co.jp/dp/${encodeURIComponent(asin)}`;
  const title = p.title ?? asin;
  const cur = p.stats?.current;
  const amazonPrice = value(cur, CSV.AMAZON);
  const fbaPrice = value(cur, CSV.NEW_FBA);
  const fbmPrice = value(cur, CSV.NEW_FBM_SHIPPING);
  const newPrice = value(cur, CSV.NEW);
  const buyBox = value(cur, CSV.BUY_BOX_SHIPPING);
  const lowestFba = [amazonPrice, fbaPrice].filter((v): v is number => v !== undefined);
  const lowestAll = [amazonPrice, fbaPrice, fbmPrice, newPrice].filter((v): v is number => v !== undefined);
  const category = p.categoryTree?.find((c) => c.catId === p.salesRankReference)?.name ?? p.categoryTree?.[0]?.name;
  const offerHistory = p.csv?.[CSV.COUNT_NEW];
  const DAY = 24 * 60 * 60 * 1000;
  const amazonShare = p.stats?.buyBoxStats?.[AMAZON_JP_SELLER_ID]?.percentageWon;
  const referral = p.referralFeePercentage ?? p.referralFeePercent;
  const pickAndPack = p.fbaFees?.pickAndPackFee;

  const product: AmazonProduct = {
    asin,
    title,
    imageUrl: imageOf(p),
    salesRank: value(cur, CSV.SALES),
    salesRankCategory: category,
    salesRankDrops30: count(p.stats?.salesRankDrops30),
    salesRankDrops90: count(p.stats?.salesRankDrops90),
    monthlySold: p.monthlySold && p.monthlySold > 0 ? p.monthlySold : undefined,
    buyBoxPriceJpy: buyBox,
    buyBoxAvg90Jpy: value(p.stats?.avg90, CSV.BUY_BOX_SHIPPING),
    lowestFbaPriceJpy: lowestFba.length > 0 ? Math.min(...lowestFba) : undefined,
    lowestPriceJpy: lowestAll.length > 0 ? Math.min(...lowestAll) : undefined,
    offerCount: count(cur?.[CSV.COUNT_NEW]),
    offerCount7dAgo: historyValueAt(offerHistory, nowMs - 7 * DAY),
    offerCount14dAgo: historyValueAt(offerHistory, nowMs - 14 * DAY),
    amazonSelling: amazonPrice !== undefined || p.stats?.buyBoxIsAmazon === true,
    amazonBuyBoxShare90: typeof amazonShare === "number" && amazonShare >= 0 ? amazonShare : undefined,
    amazonOutOfStock90: count(p.stats?.outOfStockPercentage90?.[CSV.AMAZON]),
    buyBoxIsFba: typeof p.stats?.buyBoxIsFBA === "boolean" ? p.stats.buyBoxIsFBA : undefined,
    referralFeePercent: typeof referral === "number" && referral >= 0 ? referral : undefined,
    fbaPickAndPackJpy: typeof pickAndPack === "number" && pickAndPack > 0 ? pickAndPack : undefined,
    url,
  };

  // 手数料（カート価格 → FBA 最安値 → 最安値で見積もり）。画面側では、実際に使う販売価格で計算し直す
  const sellPrice = product.buyBoxPriceJpy ?? product.lowestFbaPriceJpy ?? product.lowestPriceJpy;
  if (sellPrice !== undefined && product.referralFeePercent !== undefined && product.fbaPickAndPackJpy !== undefined) {
    product.fbaFeesJpy = Math.round((sellPrice * product.referralFeePercent) / 100 + product.fbaPickAndPackJpy);
    product.feesForPriceJpy = sellPrice;
  }

  // Amazon で仕入れるときの候補（Keepa は出品ごとのポイントが分からないので 0 として計算）
  const offers: MallOffer[] = [];
  const add = (priceJpy: number | undefined, shopName: string, fba: boolean) => {
    if (priceJpy !== undefined) offers.push({ mall: "amazon", title, priceJpy, shipping: "free", shippingJpy: 0, pointsJpy: 0, url, shopName, fba });
  };
  add(amazonPrice, "Amazon.co.jp", true);
  add(fbaPrice, "出品者（FBA）最安", true);
  add(fbmPrice, "出品者（自社発送）最安・送料込み", false);
  offers.sort((a, b) => a.priceJpy - b.priceJpy);

  const warnings: string[] = [];
  if (sellPrice === undefined) warnings.push("Amazon: 新品の出品がありません（Keepa）。");
  else if (product.fbaFeesJpy === undefined) warnings.push("Amazon: Keepa に手数料の情報がないため、設定の割合で計算しています。");
  return { product, offers, warnings };
}

// ---- 通信 ----

async function keepaRequest(params: Record<string, string>, key: string, fetchFn: typeof fetch): Promise<KeepaResponse> {
  const url = new URL(KEEPA_URL);
  url.searchParams.set("key", key);
  url.searchParams.set("domain", KEEPA_DOMAIN_JP);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetchFn(url, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    throw new KeepaApiError("Amazon（Keepa）: 接続できませんでした（通信エラー）。");
  }
  const data = (await res.json().catch(() => ({}))) as KeepaResponse;
  if (!res.ok || data.error) {
    const detail = data.error?.message ?? data.error?.type ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const wait = data.refillIn ? `約 ${Math.ceil(data.refillIn / 1000)} 秒後` : "しばらく後";
      throw new KeepaApiError(`Amazon（Keepa）: トークンが足りません（残り ${data.tokensLeft ?? 0}）。${wait}に回復します。`);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 402) {
      throw new KeepaApiError(`Amazon（Keepa）: 利用できませんでした（${detail}）。KEEPA_API_KEY と Keepa の API プランを確認してください。`);
    }
    throw new KeepaApiError(`Amazon（Keepa）: 取得に失敗しました（${detail}）。`);
  }
  return data;
}

/** 1 回のリクエストで送れる ASIN の数（Keepa の上限） */
const KEEPA_BATCH_SIZE = 100;
/** 同じ親 ASIN のバリエーション情報を使い回す時間（同じ商品の色違いを続けて調べてもトークンを使わない） */
const VARIATION_CACHE_MS = 6 * 60 * 60 * 1000;

/** 兄弟 ASIN ごとの、シェア計算に使う値（購入数・レビュー数） */
type VariationMetrics = { sold: number; reviews: number };
const variationCache = new Map<string, { at: number; siblings: string[]; metrics: Map<string, VariationMetrics> }>();

/** テスト用: 使い回しているバリエーション情報を消す */
export function resetKeepaCache() {
  variationCache.clear();
}

function metricsOf(p: KeepaProduct): VariationMetrics {
  return { sold: p.monthlySold && p.monthlySold > 0 ? p.monthlySold : 0, reviews: value(p.stats?.current, CSV.COUNT_REVIEWS) ?? 0 };
}

/**
 * バリエーションの売れ筋シェア。親 ASIN から兄弟 ASIN を調べ、この ASIN の販売数（Amazon の「過去 1 か月で ◯ 点以上購入」。
 * なければレビュー数）が全バリエーションの何 % かを出す。
 *
 * トークンの節約:
 *   - 兄弟 ASIN は 1 件ずつではなく asin=A,B,C… でまとめて取得（100 件ずつ）。履歴（csv）は付けない（history=0）
 *   - 調べている ASIN 自身はすでに取得済みなので、兄弟のリクエストから外す
 *   - 同じ親 ASIN の結果は 6 時間使い回す（色違い・サイズ違いを続けて調べても兄弟を取り直さない）
 * Keepa は 1 商品につき 1 トークンかかるので、兄弟が N 個なら最初の 1 回だけ「親 1 ＋ 兄弟 N−1」トークン。
 */
async function checkVariations(
  self: KeepaProduct,
  parentAsin: string,
  key: string,
  fetchFn: typeof fetch,
  now: number,
): Promise<Pick<AmazonProduct, "variationCount" | "variationSharePercent" | "variationShareBasis">> {
  const selfAsin = self.asin ?? "";
  let cached = variationCache.get(parentAsin);
  if (!cached || now - cached.at > VARIATION_CACHE_MS) {
    const parent = (await keepaRequest({ asin: parentAsin, history: "0" }, key, fetchFn)).products?.[0];
    const siblings = [...new Set((parent?.variations ?? []).map((v) => v.asin).filter((a): a is string => !!a))];
    const metrics = new Map<string, VariationMetrics>();
    if (siblings.length > 1 && siblings.length <= MAX_VARIATIONS_TO_CHECK) {
      const others = siblings.filter((a) => a !== selfAsin);
      for (let i = 0; i < others.length; i += KEEPA_BATCH_SIZE) {
        // 購入数（monthlySold）とレビュー数（stats.current）だけ使うので、集計は最小の 1 日・履歴なし
        const data = await keepaRequest({ asin: others.slice(i, i + KEEPA_BATCH_SIZE).join(","), stats: "1", history: "0" }, key, fetchFn);
        for (const p of data.products ?? []) if (p.asin) metrics.set(p.asin, metricsOf(p));
      }
    }
    cached = { at: now, siblings, metrics };
    variationCache.set(parentAsin, cached);
  }

  const { siblings } = cached;
  if (siblings.length <= 1) return { variationCount: siblings.length || undefined };
  if (siblings.length > MAX_VARIATIONS_TO_CHECK) return { variationCount: siblings.length };

  // 自分の値は今取得した最新のものを使う
  const metrics = new Map(cached.metrics);
  metrics.set(selfAsin, metricsOf(self));
  cached.metrics.set(selfAsin, metricsOf(self));
  const all = siblings.map((a) => metrics.get(a)).filter((m): m is VariationMetrics => !!m);
  const mine = metrics.get(selfAsin)!;
  const share = (key: keyof VariationMetrics) => {
    const total = all.reduce((sum, m) => sum + m[key], 0);
    return total > 0 ? Math.round((mine[key] / total) * 1000) / 10 : undefined;
  };
  const bySold = share("sold");
  if (bySold !== undefined) return { variationCount: siblings.length, variationSharePercent: bySold, variationShareBasis: "sold" };
  const byReviews = share("reviews");
  return { variationCount: siblings.length, variationSharePercent: byReviews, variationShareBasis: byReviews === undefined ? undefined : "reviews" };
}

/** 1 つの JAN を Keepa で調べる */
export async function lookupKeepa(jan: string, key: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<AmazonLookup> {
  const data = await keepaRequest(
    // カート価格（current[18]）と持ち主、直近 15 日の履歴（出品者数の推移）を含める
    { code: jan, stats: STATS_DAYS, buybox: "1", history: "1", days: HISTORY_DAYS },
    key,
    fetchFn,
  );

  const products = (data.products ?? []).filter((p) => p.asin && hasJan(p, jan));
  if (products.length === 0) return { offers: [], warnings: ["Amazon: この JAN の商品は登録されていません（Keepa）。"] };
  // 同じ JAN に複数の ASIN があるときは、一番売れている（ランキングの小さい）ものを使う
  const rankOf = (p: KeepaProduct) => value(p.stats?.current, CSV.SALES) ?? Infinity;
  const best = [...products].sort((a, b) => rankOf(a) - rankOf(b))[0];
  const result = parseKeepaProduct(best, now());
  if (products.length > 1) result.warnings.push(`Amazon: この JAN に ${products.length} 件の商品ページがあります（一番売れている ${best.asin} で計算）。`);

  if (best.parentAsin && result.product) {
    try {
      Object.assign(result.product, await checkVariations(best, best.parentAsin, key, fetchFn, now()));
    } catch (e) {
      result.warnings.push(e instanceof KeepaApiError ? `${e.message}（バリエーションの確認）` : "Amazon（Keepa）: バリエーションを確認できませんでした。");
    }
  }
  if (typeof data.tokensLeft === "number" && data.tokensLeft < 5) {
    result.warnings.push(`Amazon（Keepa）: 残りトークンが少なくなっています（${data.tokensLeft}）。`);
  }
  return result;
}
