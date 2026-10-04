// 自動リサーチの結果から利益を計算し、「お宝商品」の条件に合うかを判定する（画面側で使う）。
// 計算式は calculateProfit（src/lib/profit.ts）:
//   利益 = (eBay 売価 − eBay 手数料) × 為替 − (国内仕入れ値 + 国内送料) − 国際送料

import { calculateProfit, type ProfitResult, type Settings } from "./profit";
import type { Candidate, DomesticOffer } from "./researchTypes";

/** eBay の相場として使う値 */
export type PriceBasis = "p25" | "median" | "min";

export const PRICE_BASES: { id: PriceBasis; label: string }[] = [
  { id: "p25", label: "安い方から25%（おすすめ）" },
  { id: "median", label: "中央値" },
  { id: "min", label: "最安値" },
];

/** お宝の条件と、計算に使う前提 */
export type TreasureCriteria = {
  minProfitJpy: number;
  minMarginPercent: number;
  /** eBay の集計件数がこれ未満なら、相場が当てにならないのでお宝にしない */
  minEbayListings: number;
  /**
   * 国内価格が eBay 相場（中央値）のこの割合 [%] 未満なら、付属品・別商品の可能性が高いとみなす。
   * 例: eBay 相場 8 万円・25% なら、2 万円未満の国内商品は仕入れ先に選ばない。0 で無効
   */
  minPriceRatioPercent: number;
  basis: PriceBasis;
  /** 送料別・送料不明の国内商品に足す送料の目安 [円] */
  domesticShippingJpy: number;
};

export const DEFAULT_CRITERIA: TreasureCriteria = {
  minProfitJpy: 3000,
  minMarginPercent: 15,
  minEbayListings: 3,
  minPriceRatioPercent: 25,
  basis: "p25",
  domesticShippingJpy: 800,
};

export type Evaluation = {
  /** 送料を含めて一番安い国内の商品 */
  offer: DomesticOffer;
  /** 仕入れ値（商品価格 + 国内送料）[円] */
  purchaseJpy: number;
  domesticShippingJpy: number;
  /** 計算に使った eBay 売価 [USD] */
  ebayPriceUsd: number;
  profit: ProfitResult;
  isTreasure: boolean;
  /** お宝にならなかった理由（相場の件数不足など） */
  notes: string[];
};

function basisPrice(candidate: Candidate, basis: PriceBasis): number | null {
  const m = candidate.ebay;
  if (!m) return null;
  return basis === "p25" ? m.p25Usd : basis === "median" ? m.medianUsd : m.minUsd;
}

export function shippingCost(offer: DomesticOffer, criteria: Pick<TreasureCriteria, "domesticShippingJpy">): number {
  return offer.shipping === "free" ? 0 : criteria.domesticShippingJpy;
}

/** 1 商品を評価する。国内の商品か eBay 相場がなければ undefined */
export function evaluateCandidate(
  candidate: Candidate,
  settings: Settings,
  criteria: TreasureCriteria,
  internationalShippingJpy?: number,
): Evaluation | undefined {
  const ebayPriceUsd = basisPrice(candidate, criteria.basis);
  if (ebayPriceUsd === null || candidate.offers.length === 0) return undefined;

  // eBay 相場に比べて安すぎる国内商品は、付属品（保護フィルム・ケースなど）や別商品の可能性が高いので仕入れ先に選ばない
  const referenceJpy = (candidate.ebay?.medianUsd ?? ebayPriceUsd) * settings.usdJpy;
  const minPriceJpy = (referenceJpy * criteria.minPriceRatioPercent) / 100;
  const plausible = candidate.offers.filter((o) => o.priceJpy >= minPriceJpy);
  const suspiciousCount = candidate.offers.length - plausible.length;
  const pool = plausible.length > 0 ? plausible : candidate.offers;

  const offer = pool.reduce((best, o) =>
    o.priceJpy + shippingCost(o, criteria) < best.priceJpy + shippingCost(best, criteria) ? o : best,
  );
  const domesticShippingJpy = shippingCost(offer, criteria);

  const profit = calculateProfit(
    {
      purchasePriceJpy: offer.priceJpy,
      purchaseExtraJpy: domesticShippingJpy,
      ebayPriceUsd,
      ebayShippingChargedUsd: 0,
    },
    internationalShippingJpy === undefined ? settings : { ...settings, internationalShippingJpy },
  );

  const notes: string[] = [];
  const count = candidate.ebay?.count ?? 0;
  if (count < criteria.minEbayListings) notes.push(`eBay の比較対象が ${count} 件と少なく、相場が不確かです`);
  if (candidate.ebay?.usedKeywordFallback) notes.push("JAN で見つからず英語キーワードで代用した相場です");
  const tooCheap = plausible.length === 0;
  if (tooCheap) {
    notes.push(
      `国内価格が eBay 相場の ${criteria.minPriceRatioPercent}% 未満です。付属品・別商品の可能性が高いため、お宝から外しています`,
    );
  } else if (suspiciousCount > 0) {
    notes.push(`eBay 相場の ${criteria.minPriceRatioPercent}% 未満の安すぎる国内商品 ${suspiciousCount} 件は、付属品の可能性があるため除きました`);
  }

  const isTreasure =
    !tooCheap &&
    count >= criteria.minEbayListings &&
    profit.profitJpy >= criteria.minProfitJpy &&
    profit.marginPercent >= criteria.minMarginPercent;

  return {
    offer,
    purchaseJpy: offer.priceJpy + domesticShippingJpy,
    domesticShippingJpy,
    ebayPriceUsd,
    profit,
    isTreasure,
    notes,
  };
}
