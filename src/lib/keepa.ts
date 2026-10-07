// Keepa API で Amazon.co.jp の価格・売れ筋ランキング・販売回数・手数料を調べる（サーバー側専用）。
// キー（KEEPA_API_KEY）を扱うので、ブラウザ側からは import しないこと。
//
// Keepa の API はキーを URL の key パラメーターで受け取る仕様なので、URL はログやエラーに出さないこと。
// https://keepa.com/#!discuss/t/request-products/110
// 1 商品（stats 付き・履歴なし）で 1 トークン使う。トークンはプランごとに 1 分あたりの量で回復する。

import { cleanEnvValue } from "./env";
import type { AmazonLookup } from "./amazon";
import type { AmazonProduct, MallOffer } from "./malls";

const KEEPA_URL = "https://api.keepa.com/product";
/** Keepa のドメイン番号（5 = Amazon.co.jp） */
const KEEPA_DOMAIN_JP = "5";
/** 平均・販売回数を集計する日数 */
const STATS_DAYS = "90";

/** stats.current などの添字（Keepa の CsvType） */
const CSV = { AMAZON: 0, NEW: 1, SALES: 3, NEW_FBM_SHIPPING: 7, NEW_FBA: 10, COUNT_NEW: 11, BUY_BOX_SHIPPING: 18 } as const;

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
  stats?: {
    current?: number[];
    avg90?: number[];
    salesRankDrops30?: number;
    salesRankDrops90?: number;
  } | null;
};

type KeepaResponse = {
  products?: KeepaProduct[];
  tokensLeft?: number;
  refillIn?: number;
  error?: { type?: string; message?: string };
};

/** Keepa の値（-1・-2 はデータなし・在庫なし）を数値か undefined にする */
function value(arr: number[] | undefined, index: number): number | undefined {
  const v = arr?.[index];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function count(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
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

/** Keepa の商品を、画面で使う Amazon の情報と「Amazon で仕入れる」場合の出品にする */
export function parseKeepaProduct(p: KeepaProduct): AmazonLookup {
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
    lowestFbaPriceJpy: lowestFba.length > 0 ? Math.min(...lowestFba) : undefined,
    lowestPriceJpy: lowestAll.length > 0 ? Math.min(...lowestAll) : undefined,
    offerCount: count(cur?.[CSV.COUNT_NEW]),
    amazonSelling: amazonPrice !== undefined,
    url,
  };

  // 手数料: 販売手数料（%）＋ FBA 配送代行手数料（円）を、販売価格（FBA 最安値 → カート → 最安値）で計算
  const sellPrice = product.lowestFbaPriceJpy ?? product.buyBoxPriceJpy ?? product.lowestPriceJpy;
  const referral = p.referralFeePercentage ?? p.referralFeePercent;
  const pickAndPack = p.fbaFees?.pickAndPackFee;
  if (sellPrice !== undefined && typeof referral === "number" && typeof pickAndPack === "number" && pickAndPack > 0) {
    product.fbaFeesJpy = Math.round((sellPrice * referral) / 100 + pickAndPack);
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
  if (amazonPrice !== undefined) warnings.push("Amazon: Amazon 本体が販売しているため、出品してもカートを取りにくい商品です。");
  if (sellPrice === undefined) warnings.push("Amazon: 新品の出品がありません（Keepa）。");
  else if (product.fbaFeesJpy === undefined) warnings.push("Amazon: Keepa に手数料の情報がないため、設定の割合で計算しています。");
  return { product, offers, warnings };
}

/** 1 つの JAN を Keepa で調べる */
export async function lookupKeepa(jan: string, key: string, fetchFn: typeof fetch = fetch): Promise<AmazonLookup> {
  const url = new URL(KEEPA_URL);
  url.searchParams.set("key", key);
  url.searchParams.set("domain", KEEPA_DOMAIN_JP);
  url.searchParams.set("code", jan);
  url.searchParams.set("stats", STATS_DAYS);
  url.searchParams.set("history", "0");

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

  const products = (data.products ?? []).filter((p) => p.asin && hasJan(p, jan));
  if (products.length === 0) return { offers: [], warnings: ["Amazon: この JAN の商品は登録されていません（Keepa）。"] };
  // 同じ JAN に複数の ASIN があるときは、一番売れている（ランキングの小さい）ものを使う
  const rankOf = (p: KeepaProduct) => value(p.stats?.current, CSV.SALES) ?? Infinity;
  const best = [...products].sort((a, b) => rankOf(a) - rankOf(b))[0];
  const result = parseKeepaProduct(best);
  if (products.length > 1) result.warnings.push(`Amazon: この JAN に ${products.length} 件の商品ページがあります（一番売れている ${best.asin} で計算）。`);
  if (typeof data.tokensLeft === "number" && data.tokensLeft < 5) {
    result.warnings.push(`Amazon（Keepa）: 残りトークンが少なくなっています（${data.tokensLeft}）。`);
  }
  return result;
}
