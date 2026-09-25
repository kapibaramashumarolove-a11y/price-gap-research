// eBay Browse API の検索結果から「出品中の価格」を集計するロジック。
// 通信部分（src/lib/ebay.ts）と分けておくことで、ネットワークなしでテストできる。
// このファイルには秘密情報を含めないこと（画面側からも型を読み込むため）。

/** 出品 1 件分（画面表示と集計に必要な項目だけ） */
export type EbayListing = {
  title: string;
  /** 商品価格 [USD]（送料は含まない） */
  priceUsd: number;
  /** 購入者負担の送料 [USD]。出品に送料情報がなければ null */
  shippingUsd: number | null;
  condition: string;
  url: string;
};

/** 検索結果の集計（API から画面へ返す形） */
export type EbayPriceSummary = {
  query: string;
  /** "sandbox"（テスト用）または "production"（本番） */
  environment: string;
  /** eBay 上でヒットした総件数（取得したのはその一部の場合がある） */
  totalFound: number;
  /** 集計に使った件数 */
  count: number;
  /** 価格の中央値 [USD]。0 件なら null */
  medianUsd: number | null;
  /** 最安値 [USD]。0 件なら null */
  minUsd: number | null;
  /** 最高値 [USD]。0 件なら null */
  maxUsd: number | null;
  /** 安い順の出品サンプル（確認用に数件） */
  samples: EbayListing[];
};

/** 中央値。件数が偶数なら真ん中 2 つの平均。空なら null */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toUsd(amount: unknown): number | null {
  if (typeof amount !== "object" || amount === null) return null;
  const { value, currency } = amount as { value?: unknown; currency?: unknown };
  if (currency !== "USD") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Browse API `item_summary/search` のレスポンス(JSON)から出品一覧を取り出す。
 * USD 以外の価格や、価格が読めない出品は除外する。
 */
export function parseItemSummaries(json: unknown): { totalFound: number; listings: EbayListing[] } {
  const data = (json ?? {}) as { total?: unknown; itemSummaries?: unknown };
  const summaries = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];

  const listings: EbayListing[] = [];
  for (const raw of summaries) {
    const s = raw as {
      title?: unknown;
      price?: unknown;
      condition?: unknown;
      itemWebUrl?: unknown;
      shippingOptions?: { shippingCost?: unknown }[];
    };
    const priceUsd = toUsd(s.price);
    if (priceUsd === null) continue;
    listings.push({
      title: typeof s.title === "string" ? s.title : "",
      priceUsd,
      shippingUsd: toUsd(s.shippingOptions?.[0]?.shippingCost),
      condition: typeof s.condition === "string" ? s.condition : "",
      url: typeof s.itemWebUrl === "string" ? s.itemWebUrl : "",
    });
  }

  const total = Number(data.total);
  return { totalFound: Number.isFinite(total) ? total : listings.length, listings };
}

/** 出品一覧を集計する */
export function summarizeListings(
  listings: EbayListing[],
  meta: { query: string; environment: string; totalFound: number },
  sampleSize = 5,
): EbayPriceSummary {
  const prices = listings.map((l) => l.priceUsd);
  return {
    ...meta,
    count: listings.length,
    medianUsd: median(prices),
    minUsd: prices.length > 0 ? Math.min(...prices) : null,
    maxUsd: prices.length > 0 ? Math.max(...prices) : null,
    samples: [...listings].sort((a, b) => a.priceUsd - b.priceUsd).slice(0, sampleSize),
  };
}
