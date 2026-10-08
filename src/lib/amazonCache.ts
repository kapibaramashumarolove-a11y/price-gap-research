// ブラウザに保存した Amazon（Keepa）のデータを、サーバーで使い回すための検査（サーバー側）。
// 一定時間内に同じ JAN を調べるときは、ブラウザから送られてきたデータを使って Keepa を呼ばない（トークン 0）。
// 送られてきたデータは形を検査し、知らない項目や形がおかしい値は捨てる。

import type { AmazonLookup } from "./amazon";
import type { AmazonProduct, MallOffer } from "./malls";

/** キャッシュとして使ってよい最長の時間 */
export const MAX_CACHE_HOURS = 24;

const NUMBER_FIELDS = [
  "salesRank",
  "salesRankDrops30",
  "salesRankDrops90",
  "monthlySold",
  "buyBoxPriceJpy",
  "buyBoxAvg90Jpy",
  "offerCount7dAgo",
  "offerCount14dAgo",
  "amazonBuyBoxShare90",
  "amazonOutOfStock90",
  "variationCount",
  "variationSharePercent",
  "referralFeePercent",
  "fbaPickAndPackJpy",
  "lowestFbaPriceJpy",
  "lowestPriceJpy",
  "offerCount",
  "fbaFeesJpy",
  "feesForPriceJpy",
] as const satisfies readonly (keyof AmazonProduct)[];

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : undefined);
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);
const amazonUrl = (v: unknown) => {
  const s = str(v, 500);
  return s && /^https:\/\/www\.amazon\.co\.jp\//.test(s) ? s : undefined;
};
const imageUrl = (v: unknown) => {
  const s = str(v, 500);
  return s && /^https:\/\//.test(s) ? s : undefined;
};

function parseProduct(value: unknown): AmazonProduct | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const asin = str(v.asin, 20);
  const url = amazonUrl(v.url);
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin) || !url) return null;
  const product: AmazonProduct = { asin, title: str(v.title, 500) ?? asin, url, imageUrl: imageUrl(v.imageUrl) };
  for (const key of NUMBER_FIELDS) {
    const n = num(v[key]);
    if (n !== undefined) product[key] = n;
  }
  const category = str(v.salesRankCategory, 100);
  if (category) product.salesRankCategory = category;
  if (typeof v.amazonSelling === "boolean") product.amazonSelling = v.amazonSelling;
  if (typeof v.buyBoxIsFba === "boolean") product.buyBoxIsFba = v.buyBoxIsFba;
  if (v.variationShareBasis === "sold" || v.variationShareBasis === "reviews") product.variationShareBasis = v.variationShareBasis;
  return product;
}

function parseOffers(value: unknown): MallOffer[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 20).flatMap((o): MallOffer[] => {
    if (typeof o !== "object" || o === null) return [];
    const r = o as Record<string, unknown>;
    const priceJpy = num(r.priceJpy);
    const url = amazonUrl(r.url);
    if (r.mall !== "amazon" || priceJpy === undefined || !url) return [];
    return [
      {
        mall: "amazon",
        title: str(r.title, 500) ?? "",
        priceJpy,
        shipping: r.shipping === "free" || r.shipping === "extra" ? r.shipping : "unknown",
        shippingJpy: num(r.shippingJpy),
        pointsJpy: Math.min(num(r.pointsJpy) ?? 0, priceJpy),
        url,
        shopName: str(r.shopName, 100) ?? "",
        fba: typeof r.fba === "boolean" ? r.fba : undefined,
      },
    ];
  });
}

/**
 * ブラウザから送られてきた Amazon のキャッシュを検査する。
 * @param maxHours 使ってよい時間（1〜24 時間）
 * @returns 使えるならその Amazon のデータ。古い・形がおかしいなら undefined（Keepa で取り直す）
 */
export function parseClientAmazonCache(value: unknown, maxHours: unknown, now: number = Date.now()): AmazonLookup | undefined {
  const hours = Math.min(MAX_CACHE_HOURS, Number(maxHours));
  if (!(hours > 0) || typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const fetchedAt = str(v.fetchedAt, 40);
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > hours * 60 * 60 * 1000) return undefined;
  const product = parseProduct(v.product);
  const offers = parseOffers(v.offers);
  if (product === null || offers === null) return undefined;
  const ageHours = Math.max(0, (now - at) / (60 * 60 * 1000));
  const age = ageHours < 1 ? `${Math.max(1, Math.round(ageHours * 60))} 分前` : `${Math.round(ageHours * 10) / 10} 時間前`;
  return {
    product,
    offers,
    warnings: [
      `Amazon: ${age}に Keepa で取得したデータを使いました（キャッシュ・トークン 0）。最新にするには「調べ直す」を押してください。`,
      ...(product ? [] : ["Amazon: この JAN の商品は登録されていません（Keepa）。"]),
    ],
    fetchedAt: new Date(at).toISOString(),
    fromCache: true,
  };
}
