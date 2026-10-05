// 自動リサーチの結果から利益を計算し、「お宝商品」の条件に合うかを判定する（画面側で使う）。
// 計算式は calculateProfit（src/lib/profit.ts）:
//   利益 = (eBay 売価 − eBay 手数料) × 為替 − (国内仕入れ値 + 国内送料) − 国際送料

import { calculateProfit, type ProfitResult, type Settings } from "./profit";
import type { Candidate, DomesticOffer, SalesSignal } from "./researchTypes";

/** eBay の相場として使う値 */
export type PriceBasis = "sold" | "p25" | "median" | "min";

export const PRICE_BASES: { id: PriceBasis; label: string }[] = [
  { id: "sold", label: "売れている価格（安全側・おすすめ）" },
  { id: "p25", label: "安い方から25%" },
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
  /** お宝にする回転率ランクの下限（none: 問わない）。ランクが「不明」の商品は none のときだけお宝になる */
  minRank: MinRank;
  /** 送料別・送料不明の国内商品に足す送料の目安 [円] */
  domesticShippingJpy: number;
};

export const DEFAULT_CRITERIA: TreasureCriteria = {
  minProfitJpy: 3000,
  minMarginPercent: 15,
  minEbayListings: 3,
  minPriceRatioPercent: 25,
  basis: "sold",
  minRank: "none",
  domesticShippingJpy: 800,
};

// ---- 回転率ランク（推定） ----

/** S: 月 5 個以上 / A: 月 1〜4 個 / B: 月 1 個未満（売れた実績あり） / C: 売れた実績なし / unknown: 販売数が分からない */
export type TurnoverRank = "S" | "A" | "B" | "C" | "unknown";
export type MinRank = "none" | "B" | "A" | "S";

export const MIN_RANKS: { id: MinRank; label: string }[] = [
  { id: "none", label: "問わない" },
  { id: "B", label: "B 以上（売れた実績あり）" },
  { id: "A", label: "A 以上（月 1 個以上）" },
  { id: "S", label: "S のみ（月 5 個以上）" },
];

export const RANK_INFO: Record<TurnoverRank, { label: string; hint: string }> = {
  S: { label: "S", hint: "即売れ（推定 月 5 個以上）" },
  A: { label: "A", hint: "高回転（推定 月 1〜4 個）" },
  B: { label: "B", hint: "低回転（推定 月 1 個未満）" },
  C: { label: "C", hint: "売れた実績が見つからない（リスク高）" },
  unknown: { label: "?", hint: "販売数が分からない（中古の 1 点ものなど）。「eBay 落札済み」で確認してください" },
};

/**
 * 売れ行きの推定から回転率ランクを決める。
 * 販売数が分かる出品（複数個まとめて出品しているもの）がなければ「不明」にする（C＝リスク高とは区別する）。
 */
export function turnoverRank(sales: SalesSignal | undefined): TurnoverRank {
  if (!sales || sales.multiQuantityListings === 0) return "unknown";
  if (sales.soldTotal === 0) return "C";
  if (sales.estimatedMonthlySales >= 5) return "S";
  if (sales.estimatedMonthlySales >= 1) return "A";
  return "B";
}

const RANK_ORDER: Record<TurnoverRank, number> = { S: 3, A: 2, B: 1, C: 0, unknown: -1 };

function meetsMinRank(rank: TurnoverRank, min: MinRank): boolean {
  return min === "none" || RANK_ORDER[rank] >= RANK_ORDER[min];
}

export type Evaluation = {
  /** 送料を含めて一番安い国内の商品 */
  offer: DomesticOffer;
  /** 仕入れ値（商品価格 + 国内送料）[円] */
  purchaseJpy: number;
  domesticShippingJpy: number;
  /** 計算に使った eBay 売価 [USD] */
  ebayPriceUsd: number;
  /** 売価として実際に使った値（「売れている出品の価格」がなく安い方から25%で代用したときは p25） */
  usedBasis: PriceBasis;
  rank: TurnoverRank;
  profit: ProfitResult;
  isTreasure: boolean;
  /** お宝にならなかった理由（相場の件数不足など） */
  notes: string[];
};

function basisPrice(candidate: Candidate, basis: PriceBasis): { price: number | null; usedBasis: PriceBasis } {
  const m = candidate.ebay;
  if (!m) return { price: null, usedBasis: basis };
  if (basis === "sold") {
    // 売れている出品の価格は少数の出品から出すので、ぶれることがある。
    // 利益を大きく見積もらないよう、出品中の安い方から 25% と比べて低い方を使う（安全側）
    const sold = m.sales?.soldPriceMedianUsd ?? null;
    if (sold === null) return { price: m.p25Usd, usedBasis: "p25" };
    return m.p25Usd !== null && m.p25Usd < sold ? { price: m.p25Usd, usedBasis: "p25" } : { price: sold, usedBasis: "sold" };
  }
  return { price: basis === "p25" ? m.p25Usd : basis === "median" ? m.medianUsd : m.minUsd, usedBasis: basis };
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
  const { price: ebayPriceUsd, usedBasis } = basisPrice(candidate, criteria.basis);
  if (ebayPriceUsd === null || candidate.offers.length === 0) return undefined;
  const rank = turnoverRank(candidate.ebay?.sales);

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

  if (criteria.basis === "sold" && usedBasis !== "sold" && candidate.ebay?.sales?.soldPriceMedianUsd == null) {
    notes.push("売れた実績のある出品が見つからず、出品中価格（安い方から25%）で計算しています");
  }
  if (!meetsMinRank(rank, criteria.minRank)) {
    notes.push(`回転率ランクが条件（${MIN_RANKS.find((r) => r.id === criteria.minRank)?.label}）に届かないため、お宝から外しています`);
  }

  const isTreasure =
    !tooCheap &&
    meetsMinRank(rank, criteria.minRank) &&
    count >= criteria.minEbayListings &&
    profit.profitJpy >= criteria.minProfitJpy &&
    profit.marginPercent >= criteria.minMarginPercent;

  return {
    offer,
    purchaseJpy: offer.priceJpy + domesticShippingJpy,
    domesticShippingJpy,
    ebayPriceUsd,
    usedBasis,
    rank,
    profit,
    isTreasure,
    notes,
  };
}
