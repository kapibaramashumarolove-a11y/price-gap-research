// 国内 3 モール（Amazon・楽天市場・Yahoo!ショッピング）の比較で使う型と初期値。
// 画面とサーバーの両方から使うので、キーなどサーバー専用のものは置かないこと。

export type Mall = "amazon" | "rakuten" | "yahoo";

export const MALLS: Mall[] = ["amazon", "rakuten", "yahoo"];

export const MALL_LABEL: Record<Mall, string> = { amazon: "Amazon", rakuten: "楽天", yahoo: "Yahoo!" };

/** 販売先としての呼び名（Amazon は FBA で販売する前提） */
export const SELL_LABEL: Record<Mall, string> = { amazon: "Amazon FBA", rakuten: "楽天", yahoo: "Yahoo!" };

export type ShippingStatus = "free" | "extra" | "unknown";

/** 各モールの新品の出品 1 件 */
export type MallOffer = {
  mall: Mall;
  title: string;
  /** 商品価格（税込）[円] */
  priceJpy: number;
  /** free: 送料無料・送料込み / extra: 送料別 / unknown: 条件付きなど不明 */
  shipping: ShippingStatus;
  /** 送料が分かっている場合の金額（Amazon の出品など）[円] */
  shippingJpy?: number;
  /**
   * モールが示しているポイント [円]（楽天: ショップのポイント倍率から計算、Yahoo!: ストアポイント＋ボーナス、
   * Amazon: 出品のポイント）。会員ランクなど人ごとに違う上乗せ分は設定で足す
   */
  pointsJpy: number;
  url: string;
  shopName: string;
  imageUrl?: string;
  /** Amazon の出品のみ: FBA（Amazon 発送）か */
  fba?: boolean;
};

/** Amazon のカタログ・価格情報（SP-API） */
export type AmazonProduct = {
  asin: string;
  title: string;
  imageUrl?: string;
  /** 売れ筋ランキング（小さいほど売れている）と、そのカテゴリ名 */
  salesRank?: number;
  salesRankCategory?: string;
  /** カートを取っている価格（送料込み）[円] */
  buyBoxPriceJpy?: number;
  /** FBA の新品の最安値（送料込み）[円] */
  lowestFbaPriceJpy?: number;
  /** 新品の最安値（送料込み・出品者発送も含む）[円] */
  lowestPriceJpy?: number;
  /** 新品の出品者数 */
  offerCount?: number;
  /** 販売価格で見積もった Amazon の手数料（販売手数料＋FBA 手数料）[円]。見積もれなければ undefined */
  fbaFeesJpy?: number;
  /** 手数料を見積もった販売価格 [円] */
  feesForPriceJpy?: number;
  url: string;
};

/** 1 つの JAN を 3 モールで調べた結果（/api/jan の応答） */
export type JanLookup = {
  jan: string;
  /** 商品名（Amazon → Yahoo! → 楽天の順で見つかったもの） */
  title: string;
  imageUrl?: string;
  /** 各モールの新品・在庫ありの出品（安い順。モールごとに数件まで） */
  offers: Record<Mall, MallOffer[]>;
  amazon?: AmazonProduct;
  /** 各モールのエラーや未設定などの注意 */
  warnings: string[];
  /** 複数個セットなど、1 個の値段ではないため除いた出品数 */
  excludedSets: number;
  /** 中古・開封品・訳ありなど、新品ではないため除いた出品数（古い結果にはない） */
  excludedUsed?: number;
  fetchedAt: string;
};

// ---- 計算の前提（画面の「設定」で変更できる） ----

export type SellChannel = {
  /** このモールで販売するか（出店していないモールは外す） */
  enabled: boolean;
  /** 販売手数料（決済手数料・ポイント原資なども含めた合計）[%]。Amazon は手数料が見積もれないときだけ使う */
  feePercent: number;
  /** 1 個あたりの発送・出品コスト [円]。Amazon は FBA 倉庫への納品送料、楽天・Yahoo! はお客様への送料 */
  shippingJpy: number;
};

export type ArbitrageSettings = {
  /** 仕入れ時に会員ランク・キャンペーンなどで上乗せされるポイント [%]（モールが示すポイントに足す） */
  extraPointPercent: Record<Mall, number>;
  /** ポイントを現金として数える割合 [%]（期間限定ポイントなどを割り引きたいとき） */
  pointValuePercent: number;
  /** 送料別・送料不明の商品を仕入れるときに足す送料 [円] */
  buyShippingJpy: number;
  sell: Record<Mall, SellChannel>;
  /** Amazon の手数料が見積もれなかったときの FBA 手数料（配送代行手数料など）[円] */
  amazonFallbackFbaFeeJpy: number;
  /** お宝（推奨ルート）にする条件 */
  minProfitJpy: number;
  minMarginPercent: number;
  /** お宝にする回転率ランクの下限（none: 問わない） */
  minRank: MinRank;
};

export const DEFAULT_ARBITRAGE_SETTINGS: ArbitrageSettings = {
  extraPointPercent: { amazon: 0, rakuten: 0, yahoo: 0 },
  pointValuePercent: 100,
  buyShippingJpy: 600,
  sell: {
    amazon: { enabled: true, feePercent: 10, shippingJpy: 100 },
    rakuten: { enabled: true, feePercent: 10, shippingJpy: 700 },
    yahoo: { enabled: true, feePercent: 8, shippingJpy: 700 },
  },
  amazonFallbackFbaFeeJpy: 500,
  minProfitJpy: 1000,
  minMarginPercent: 10,
  minRank: "none",
};

// ---- 回転率ランク（Amazon の売れ筋ランキングから） ----

export type TurnoverRank = "S" | "A" | "B" | "C" | "unknown";
export type MinRank = "none" | "B" | "A" | "S";

export const MIN_RANKS: { id: MinRank; label: string }[] = [
  { id: "none", label: "問わない" },
  { id: "B", label: "B 以上" },
  { id: "A", label: "A 以上（高回転）" },
  { id: "S", label: "S のみ（即売れ）" },
];

export const RANK_INFO: Record<TurnoverRank, { label: string; hint: string }> = {
  S: { label: "S", hint: "即売れ（Amazon ランキング 5,000 位以内）" },
  A: { label: "A", hint: "高回転（Amazon ランキング 3 万位以内）" },
  B: { label: "B", hint: "中回転（Amazon ランキング 10 万位以内）" },
  C: { label: "C", hint: "低回転（Amazon ランキング 10 万位より下）" },
  unknown: { label: "?", hint: "回転率が分からない（Amazon 以外で販売、またはランキングなし）" },
};
