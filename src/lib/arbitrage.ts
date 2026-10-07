// 国内 3 モールの価格差から「どこで仕入れてどこで売ると一番得か」を計算する（画面側で使う。通信はしない）。
//
//   実質仕入れ値 = 商品価格 + 送料 − ポイント（モールのポイント＋会員ランクなどの上乗せ。現金換算の割合を掛ける）
//   利益         = 販売価格 − 販売手数料 − 発送・納品コスト − 実質仕入れ値
//   利益率       = 利益 ÷ 販売価格
//
// 販売価格は、販売先のモールで今売られている価格（Amazon はカート価格 → FBA の最安値 → 最安値の順、楽天・Yahoo! は最安値）。
// 最適ルートは「利益 × 回転率の重み」が一番大きいルート（利益が同じなら売れやすい方、少し利益が小さくてもよく売れる方を選ぶ）。
// 回転率は Amazon の月の販売回数（Keepa）から、なければ売れ筋ランキングから決める（楽天・Yahoo! で売るルートは分からない）。

import {
  MALLS,
  type AmazonProduct,
  type ArbitrageSettings,
  type JanLookup,
  type Mall,
  type MallOffer,
  type MinRank,
  type TurnoverRank,
} from "./malls";

export type BuyOption = {
  offer: MallOffer;
  /** 送料 [円] */
  shippingJpy: number;
  /** 現金換算したポイント [円] */
  pointsJpy: number;
  /** 実質仕入れ値（商品価格 + 送料 − ポイント）[円] */
  netJpy: number;
};

export type Route = {
  buy: Mall;
  sell: Mall;
  buyOption: BuyOption;
  /** 販売価格 [円] */
  sellPriceJpy: number;
  /** 販売手数料 [円] */
  sellFeesJpy: number;
  /** Amazon の手数料を SP-API で見積もれたか（false なら設定の割合で計算） */
  feesFromApi: boolean;
  /** 発送・納品コスト [円] */
  sellShippingJpy: number;
  profitJpy: number;
  marginPercent: number;
  rank: TurnoverRank;
  /** 推奨ルートの条件（利益・利益率・回転率）を満たすか */
  isTreasure: boolean;
};

export type Analysis = {
  /** 計算できたルート（利益の大きい順） */
  routes: Route[];
  /** 一番利益の大きいルート */
  best?: Route;
  /** Amazon の売れ筋ランキングからの回転率 */
  amazonRank: TurnoverRank;
};

/** Amazon の売れ筋ランキングから回転率ランクを決める（目安。カテゴリによって売れ方は違う） */
export function turnoverRankFromSalesRank(salesRank: number | undefined): TurnoverRank {
  if (salesRank === undefined || !Number.isFinite(salesRank) || salesRank <= 0) return "unknown";
  if (salesRank <= 5_000) return "S";
  if (salesRank <= 30_000) return "A";
  if (salesRank <= 100_000) return "B";
  return "C";
}

/**
 * Amazon の 1 か月の販売回数の目安。Keepa のランキング変動回数（30 日、90 日 ÷ 3）と、Amazon が表示する
 * 「過去 1 か月で ◯ 点以上購入」の一番大きい値。どれもなければ undefined
 */
export function monthlySalesEstimate(product: AmazonProduct | undefined): number | undefined {
  const drops90 = typeof product?.salesRankDrops90 === "number" && product.salesRankDrops90 >= 0 ? Math.round(product.salesRankDrops90 / 3) : undefined;
  const values = [product?.salesRankDrops30, drops90, product?.monthlySold].filter((v): v is number => typeof v === "number" && v >= 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Amazon の回転率ランク（販売回数が分かればそれで、なければ売れ筋ランキングで決める） */
export function amazonTurnoverRank(product: AmazonProduct | undefined): TurnoverRank {
  const sales = monthlySalesEstimate(product);
  if (sales === undefined) return turnoverRankFromSalesRank(product?.salesRank);
  if (sales >= 20) return "S";
  if (sales >= 8) return "A";
  if (sales >= 2) return "B";
  return "C";
}

/** 最適ルートを選ぶときの回転率の重み（回転率の分からないルートは中くらいとみなす） */
export const TURNOVER_WEIGHT: Record<TurnoverRank, number> = { S: 1, A: 0.85, B: 0.6, C: 0.3, unknown: 0.5 };

/**
 * 最適ルート: 条件（利益・利益率・回転率）を満たすルートがあればその中から、なければ全ルートから、
 * 「利益 × 回転率の重み」が一番大きいもの。利益の出るルートがなければ、損の一番小さいもの
 */
export function pickBestRoute(routes: Route[]): Route | undefined {
  const pool = routes.some((r) => r.isTreasure) ? routes.filter((r) => r.isTreasure) : routes;
  const score = (r: Route) => (r.profitJpy > 0 ? r.profitJpy * TURNOVER_WEIGHT[r.rank] : r.profitJpy);
  return pool.reduce<Route | undefined>((best, r) => (!best || score(r) > score(best) ? r : best), undefined);
}

const RANK_ORDER: Record<TurnoverRank, number> = { S: 3, A: 2, B: 1, C: 0, unknown: -1 };

export function meetsMinRank(rank: TurnoverRank, min: MinRank): boolean {
  return min === "none" || RANK_ORDER[rank] >= RANK_ORDER[min];
}

/** そのモールで、ポイントと送料を含めて一番安く仕入れられる出品 */
export function bestBuyOption(offers: MallOffer[], settings: ArbitrageSettings): BuyOption | undefined {
  const options = offers.map((offer): BuyOption => {
    const shippingJpy = offer.shipping === "free" ? 0 : (offer.shippingJpy ?? settings.buyShippingJpy);
    const rawPoints = offer.pointsJpy + (offer.priceJpy * settings.extraPointPercent[offer.mall]) / 100;
    const pointsJpy = Math.floor((rawPoints * settings.pointValuePercent) / 100);
    return { offer, shippingJpy, pointsJpy, netJpy: offer.priceJpy + shippingJpy - pointsJpy };
  });
  return options.reduce<BuyOption | undefined>((best, o) => (!best || o.netJpy < best.netJpy ? o : best), undefined);
}

/** 販売先のモールで売るときの販売価格（そのモールで今売られている最安値）。売られていなければ undefined */
export function sellPriceOn(lookup: JanLookup, mall: Mall): number | undefined {
  if (mall === "amazon") {
    const a = lookup.amazon;
    return a?.buyBoxPriceJpy ?? a?.lowestFbaPriceJpy ?? a?.lowestPriceJpy;
  }
  const prices = lookup.offers[mall].map((o) => o.priceJpy);
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

/** 販売手数料。Amazon は SP-API の見積もり（販売価格が違えば販売手数料の差を調整）、なければ設定の割合 */
export function sellFees(
  lookup: JanLookup,
  mall: Mall,
  priceJpy: number,
  settings: ArbitrageSettings,
): { feesJpy: number; fromApi: boolean } {
  const channel = settings.sell[mall];
  if (mall === "amazon") {
    const a = lookup.amazon;
    if (a?.fbaFeesJpy !== undefined && a.feesForPriceJpy !== undefined) {
      const adjust = ((priceJpy - a.feesForPriceJpy) * channel.feePercent) / 100;
      return { feesJpy: Math.round(a.fbaFeesJpy + adjust), fromApi: true };
    }
    return { feesJpy: Math.round((priceJpy * channel.feePercent) / 100 + settings.amazonFallbackFbaFeeJpy), fromApi: false };
  }
  return { feesJpy: Math.round((priceJpy * channel.feePercent) / 100), fromApi: false };
}

/** すべての「仕入れ先 → 販売先」の組み合わせを計算し、利益の大きい順に並べる */
export function analyzeJan(lookup: JanLookup, settings: ArbitrageSettings): Analysis {
  const amazonRank = amazonTurnoverRank(lookup.amazon);
  const routes: Route[] = [];
  for (const buy of MALLS) {
    const buyOption = bestBuyOption(lookup.offers[buy], settings);
    if (!buyOption) continue;
    for (const sell of MALLS) {
      if (sell === buy || !settings.sell[sell].enabled) continue;
      const sellPriceJpy = sellPriceOn(lookup, sell);
      if (sellPriceJpy === undefined) continue;
      const { feesJpy, fromApi } = sellFees(lookup, sell, sellPriceJpy, settings);
      const sellShippingJpy = settings.sell[sell].shippingJpy;
      const profitJpy = Math.round(sellPriceJpy - feesJpy - sellShippingJpy - buyOption.netJpy);
      const marginPercent = sellPriceJpy > 0 ? (profitJpy / sellPriceJpy) * 100 : 0;
      const rank = sell === "amazon" ? amazonRank : "unknown";
      routes.push({
        buy,
        sell,
        buyOption,
        sellPriceJpy,
        sellFeesJpy: feesJpy,
        feesFromApi: fromApi,
        sellShippingJpy,
        profitJpy,
        marginPercent,
        rank,
        isTreasure:
          profitJpy >= settings.minProfitJpy && marginPercent >= settings.minMarginPercent && meetsMinRank(rank, settings.minRank),
      });
    }
  }
  routes.sort((a, b) => b.profitJpy - a.profitJpy);
  return { routes, best: pickBestRoute(routes), amazonRank };
}
