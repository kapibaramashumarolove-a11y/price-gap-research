// 国内（楽天・Yahoo!ショッピング）で仕入れて eBay で販売した場合の利益を計算するロジック。
// 画面(UI)から切り離して、テストしやすくしている。

/** アプリ全体で共通の計算条件（設定画面で変更できる値） */
export type Settings = {
  /** 1 USD あたりの円 */
  usdJpy: number;
  /** eBay 落札手数料 (Final Value Fee) の率 [%] */
  ebayFeeRate: number;
  /** eBay 海外取引手数料 (International fee) の率 [%] */
  internationalFeeRate: number;
  /** 1 注文あたりの固定手数料 [USD] */
  perOrderFeeUsd: number;
  /** 国際送料 [円] */
  internationalShippingJpy: number;
};

/** 利益計算の入力値（1 商品分） */
export type ProfitInput = {
  /** 国内での仕入れ価格 [円] */
  purchasePriceJpy: number;
  /** 国内送料など、仕入れにかかるその他の費用 [円] */
  purchaseExtraJpy: number;
  /** eBay での想定販売価格 [USD] */
  ebayPriceUsd: number;
  /** 購入者から受け取る送料 [USD] */
  ebayShippingChargedUsd: number;
};

export type ProfitResult = {
  /** eBay で受け取る総額（商品価格 + 送料）[USD] */
  revenueUsd: number;
  /** eBay 手数料の合計 [USD] */
  ebayFeesUsd: number;
  /** 手数料差し引き後の入金額 [円] */
  payoutJpy: number;
  /** 仕入れ + 国際送料の合計 [円] */
  totalCostJpy: number;
  /** 利益 [円] */
  profitJpy: number;
  /** 利益率（売上に対する利益の割合）[%] */
  marginPercent: number;
};

export const DEFAULT_SETTINGS: Settings = {
  usdJpy: 150,
  ebayFeeRate: 13.25,
  internationalFeeRate: 1.65,
  perOrderFeeUsd: 0.4,
  internationalShippingJpy: 4000,
};

export function calculateProfit(item: ProfitInput, settings: Settings): ProfitResult {
  const revenueUsd = item.ebayPriceUsd + item.ebayShippingChargedUsd;
  const feeRate = (settings.ebayFeeRate + settings.internationalFeeRate) / 100;
  const ebayFeesUsd = revenueUsd * feeRate + settings.perOrderFeeUsd;

  const payoutJpy = (revenueUsd - ebayFeesUsd) * settings.usdJpy;
  const totalCostJpy =
    item.purchasePriceJpy + item.purchaseExtraJpy + settings.internationalShippingJpy;
  const profitJpy = payoutJpy - totalCostJpy;

  const revenueJpy = revenueUsd * settings.usdJpy;
  const marginPercent = revenueJpy > 0 ? (profitJpy / revenueJpy) * 100 : 0;

  return { revenueUsd, ebayFeesUsd, payoutJpy, totalCostJpy, profitJpy, marginPercent };
}
