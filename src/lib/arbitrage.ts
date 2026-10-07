// 国内 3 モールの価格差から「どこで仕入れてどこで売ると一番得か」を計算する（画面側で使う。通信はしない）。
//
//   実質仕入れ値 = 商品価格 + 送料 − ポイント（モールのポイント＋会員ランクなどの上乗せ。現金換算の割合を掛ける）
//   利益         = 販売価格 − 販売手数料 − 発送・納品コスト − 実質仕入れ値
//   利益率       = 利益 ÷ 販売価格
//
// 販売価格は、楽天・Yahoo! はそのモールの最安値。Amazon（FBA）は保守的に見込む:
//   1. 基本はカート価格（なければ FBA 最安値 → 最安値）
//   2. 安全値: 90 日平均のカート価格の方が安ければそちら（一時的な高騰で仕入れない）
//   3. FBA プレミアム: カートを自己発送（FBM）が持っているなら、FBA は数 % 高くてもカートを取れるので上乗せ
//      （ただし FBA の最安値を超えない）
// Amazon で売るルートには、Keepa のデータからリスク（出品者急増・Amazon 本体の復帰・不人気バリエーションなど）を付け、
// 危険なものは推奨から外す。
// 最適ルートは「利益 × 回転率の重み」が一番大きいルート（少し利益が小さくてもよく売れる方を選ぶ）。
// 回転率は Amazon の月の販売数（Keepa）から、なければ売れ筋ランキングから決める（楽天・Yahoo! で売るルートは分からない）。

import {
  MALLS,
  type AmazonProduct,
  type ArbitrageSettings,
  type JanLookup,
  type Mall,
  type MallOffer,
  type MinRank,
  type Risk,
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
  /** 販売価格の決め方の説明（90 日平均を使った・FBA プレミアムを足したなど） */
  sellPriceNotes: string[];
  /** 販売手数料 [円] */
  sellFeesJpy: number;
  /** Amazon の手数料を Keepa・SP-API のデータで計算できたか（false なら設定の割合で計算） */
  feesFromApi: boolean;
  /** 発送・納品コスト [円] */
  sellShippingJpy: number;
  profitJpy: number;
  marginPercent: number;
  rank: TurnoverRank;
  /** このルートのリスク（Amazon で売るルートのみ） */
  risks: Risk[];
  /** 危険なリスクがあるため推奨から外したか */
  blockedByRisk: boolean;
  /** 推奨ルートの条件（利益・利益率・回転率・リスク）を満たすか */
  isTreasure: boolean;
};

export type Analysis = {
  /** 計算できたルート（利益の大きい順） */
  routes: Route[];
  /** 最適ルート */
  best?: Route;
  /** Amazon の回転率 */
  amazonRank: TurnoverRank;
  /** Amazon で売るときのリスク */
  amazonRisks: Risk[];
};

type PriceSettings = Pick<ArbitrageSettings, "safePrice" | "fbaPremiumPercent">;
type RiskSettings = Pick<ArbitrageSettings, "offerSurgePercent" | "amazonReturnSharePercent" | "variationMinSharePercent">;

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/** Amazon の売れ筋ランキングから回転率ランクを決める（目安。カテゴリによって売れ方は違う） */
export function turnoverRankFromSalesRank(salesRank: number | undefined): TurnoverRank {
  if (salesRank === undefined || !Number.isFinite(salesRank) || salesRank <= 0) return "unknown";
  if (salesRank <= 5_000) return "S";
  if (salesRank <= 30_000) return "A";
  if (salesRank <= 100_000) return "B";
  return "C";
}

/**
 * Amazon の 1 か月の販売数の目安。Keepa のランキング変動回数（30 日、90 日 ÷ 3）と、Amazon が表示する
 * 「過去 1 か月で ◯ 点以上購入」の一番大きい値。どれもなければ undefined
 */
export function monthlySalesEstimate(product: AmazonProduct | undefined): number | undefined {
  const drops90 = typeof product?.salesRankDrops90 === "number" && product.salesRankDrops90 >= 0 ? Math.round(product.salesRankDrops90 / 3) : undefined;
  const values = [product?.salesRankDrops30, drops90, product?.monthlySold].filter((v): v is number => typeof v === "number" && v >= 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Amazon の回転率ランク（販売数が分かれば S: 月 10 個以上・A: 3〜9・B: 1〜2・C: 実績なし。分からなければ売れ筋ランキング） */
export function amazonTurnoverRank(product: AmazonProduct | undefined): TurnoverRank {
  const sales = monthlySalesEstimate(product);
  if (sales === undefined) return turnoverRankFromSalesRank(product?.salesRank);
  if (sales >= 10) return "S";
  if (sales >= 3) return "A";
  if (sales >= 1) return "B";
  return "C";
}

/** 最適ルートを選ぶときの回転率の重み（回転率の分からないルートは中くらいとみなす） */
export const TURNOVER_WEIGHT: Record<TurnoverRank, number> = { S: 1, A: 0.85, B: 0.6, C: 0.3, unknown: 0.5 };

/**
 * 最適ルート: 条件（利益・利益率・回転率・リスク）を満たすルートがあればその中から、なければリスクで外していない
 * ルートから（それもなければ全ルートから）、「利益 × 回転率の重み」が一番大きいもの。利益の出るルートがなければ損の一番小さいもの
 */
export function pickBestRoute(routes: Route[]): Route | undefined {
  const safe = routes.filter((r) => !r.blockedByRisk);
  const pool = routes.some((r) => r.isTreasure) ? routes.filter((r) => r.isTreasure) : safe.length > 0 ? safe : routes;
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

/** Amazon（FBA）で売るときの見込み価格と、その決め方の説明（ファイル先頭の 1〜3） */
export function amazonSellPrice(product: AmazonProduct | undefined, settings: PriceSettings): { priceJpy: number; notes: string[] } | undefined {
  const current = product?.buyBoxPriceJpy ?? product?.lowestFbaPriceJpy ?? product?.lowestPriceJpy;
  if (!product || current === undefined) return undefined;
  const notes: string[] = [];
  let price = current;
  const avg = product.buyBoxAvg90Jpy;
  if (settings.safePrice && avg !== undefined && avg < price) {
    price = avg;
    notes.push(`90日平均カート価格 ${yen(avg)} を採用（現在 ${yen(current)} は平均より高い）`);
  }
  const premium = Math.min(10, Math.max(0, settings.fbaPremiumPercent));
  if (product.buyBoxIsFba === false && premium > 0 && product.buyBoxPriceJpy !== undefined) {
    const lifted = Math.round(price * (1 + premium / 100));
    // FBA の出品がもっと安く出ていれば、そこまでしか上げられない
    const fbaCap = product.lowestFbaPriceJpy !== undefined && product.lowestFbaPriceJpy > price ? product.lowestFbaPriceJpy : undefined;
    const next = fbaCap !== undefined ? Math.min(lifted, fbaCap) : lifted;
    if (next > price) {
      notes.push(`カートは自己発送 → FBA プレミアム +${Math.round(((next - price) / price) * 1000) / 10}%（${yen(price)} → ${yen(next)}）`);
      price = next;
    }
  }
  return { priceJpy: price, notes };
}

/** 販売先のモールで売るときの販売価格（Amazon は amazonSellPrice、ほかはそのモールの最安値）。売られていなければ undefined */
export function sellPriceOn(
  lookup: JanLookup,
  mall: Mall,
  settings: PriceSettings = { safePrice: false, fbaPremiumPercent: 0 },
): number | undefined {
  if (mall === "amazon") return amazonSellPrice(lookup.amazon, settings)?.priceJpy;
  const prices = lookup.offers[mall].map((o) => o.priceJpy);
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

/** Amazon で売るときのリスク（Keepa のデータが足りない項目は判定しない） */
export function amazonRisks(product: AmazonProduct | undefined, settings: RiskSettings): Risk[] {
  if (!product) return [];
  const risks: Risk[] = [];

  // 出品者急増（値崩れの前触れ）: 7 日・14 日前より新品出品者が一定割合以上（かつ 2 人以上）増えた
  const now = product.offerCount;
  const past: [number, number | undefined][] = [
    [7, product.offerCount7dAgo],
    [14, product.offerCount14dAgo],
  ];
  for (const [days, before] of past) {
    if (now === undefined || before === undefined || before <= 0) continue;
    const growth = ((now - before) / before) * 100;
    if (growth >= settings.offerSurgePercent && now - before >= 2) {
      risks.push({
        code: "offerSurge",
        level: "danger",
        label: "出品者急増",
        detail: `新品出品者が ${days} 日で ${before} → ${now} 人（+${Math.round(growth)}%）。値崩れの危険があります。`,
      });
      break;
    }
  }

  // Amazon 本体の復帰: 過去 90 日でよくカートを取っていたのに、今は在庫切れでいない
  const share = product.amazonBuyBoxShare90;
  if (share !== undefined && share >= settings.amazonReturnSharePercent && !product.amazonSelling) {
    const oos = product.amazonOutOfStock90 !== undefined ? `・在庫切れ率 ${product.amazonOutOfStock90}%` : "";
    risks.push({
      code: "amazonReturn",
      level: "danger",
      label: "Amazon本体の復帰",
      detail: `過去 90 日で Amazon 本体がカートを ${Math.round(share)}% 獲得${oos}。今は一時的な在庫切れで、補充されるとカートを奪われます。`,
    });
  } else if (product.amazonSelling) {
    risks.push({ code: "amazonSelling", level: "caution", label: "Amazon本体が販売中", detail: "Amazon 本体が販売中のため、カートを取りにくい商品です。" });
  }

  // 不人気バリエーション（ランキングは全バリエーション共通なので、この色・サイズが売れているとは限らない）
  if (product.variationSharePercent !== undefined && product.variationSharePercent < settings.variationMinSharePercent) {
    const basis = product.variationShareBasis === "reviews" ? "レビュー数" : "購入数";
    risks.push({
      code: "variation",
      level: "danger",
      label: "不人気バリエーション",
      detail: `${product.variationCount ?? "複数"} 種類のうち、この色・サイズの${basis}シェアは ${product.variationSharePercent}%。ランキングほど売れない可能性があります。`,
    });
  } else if ((product.variationCount ?? 0) > 1 && product.variationSharePercent === undefined) {
    risks.push({
      code: "manyVariations",
      level: "caution",
      label: "バリエーション要確認",
      detail: `${product.variationCount} 種類のバリエーションがあり、この色・サイズの売れ行きを判定できませんでした。Amazon で確認してください。`,
    });
  }

  // 一時的な高騰（安全値で計算はしているが、念のため知らせる）
  const bb = product.buyBoxPriceJpy;
  const avg = product.buyBoxAvg90Jpy;
  if (bb !== undefined && avg !== undefined && bb > avg * 1.2) {
    risks.push({
      code: "priceSpike",
      level: "caution",
      label: "一時的な高騰",
      detail: `現在のカート価格 ${yen(bb)} は 90 日平均 ${yen(avg)} より ${Math.round((bb / avg - 1) * 100)}% 高い状態です。`,
    });
  }
  return risks;
}

/**
 * 販売手数料。Amazon は Keepa の販売手数料率＋FBA 配送代行手数料で計算（なければ SP-API の見積もりを販売価格の差で調整、
 * それもなければ設定の割合）。楽天・Yahoo! は設定の割合
 */
export function sellFees(
  lookup: JanLookup,
  mall: Mall,
  priceJpy: number,
  settings: ArbitrageSettings,
): { feesJpy: number; fromApi: boolean } {
  const channel = settings.sell[mall];
  if (mall === "amazon") {
    const a = lookup.amazon;
    if (a?.referralFeePercent !== undefined && a.fbaPickAndPackJpy !== undefined) {
      return { feesJpy: Math.round((priceJpy * a.referralFeePercent) / 100 + a.fbaPickAndPackJpy), fromApi: true };
    }
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
  const risks = amazonRisks(lookup.amazon, settings);
  const amazonPrice = amazonSellPrice(lookup.amazon, settings);
  const routes: Route[] = [];
  for (const buy of MALLS) {
    const buyOption = bestBuyOption(lookup.offers[buy], settings);
    if (!buyOption) continue;
    for (const sell of MALLS) {
      if (sell === buy || !settings.sell[sell].enabled) continue;
      const sellPriceJpy = sell === "amazon" ? amazonPrice?.priceJpy : sellPriceOn(lookup, sell);
      if (sellPriceJpy === undefined) continue;
      const { feesJpy, fromApi } = sellFees(lookup, sell, sellPriceJpy, settings);
      const sellShippingJpy = settings.sell[sell].shippingJpy;
      const profitJpy = Math.round(sellPriceJpy - feesJpy - sellShippingJpy - buyOption.netJpy);
      const marginPercent = sellPriceJpy > 0 ? (profitJpy / sellPriceJpy) * 100 : 0;
      const rank = sell === "amazon" ? amazonRank : "unknown";
      const routeRisks = sell === "amazon" ? risks : [];
      const blockedByRisk = settings.excludeRisky && routeRisks.some((r) => r.level === "danger");
      routes.push({
        buy,
        sell,
        buyOption,
        sellPriceJpy,
        sellPriceNotes: sell === "amazon" ? (amazonPrice?.notes ?? []) : [],
        sellFeesJpy: feesJpy,
        feesFromApi: fromApi,
        sellShippingJpy,
        profitJpy,
        marginPercent,
        rank,
        risks: routeRisks,
        blockedByRisk,
        isTreasure:
          !blockedByRisk &&
          profitJpy >= settings.minProfitJpy &&
          marginPercent >= settings.minMarginPercent &&
          meetsMinRank(rank, settings.minRank),
      });
    }
  }
  routes.sort((a, b) => b.profitJpy - a.profitJpy);
  return { routes, best: pickBestRoute(routes), amazonRank, amazonRisks: risks };
}
