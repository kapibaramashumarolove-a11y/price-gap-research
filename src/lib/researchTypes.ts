// 自動リサーチ（国内仕入れ × eBay 販売）で使う型と初期値。
// サーバー（/api/research）と画面の両方から使うので、キーなどサーバー専用のものは置かないこと。

/**
 * リサーチの種類。種類によって「同じ商品」の見分け方と eBay の検索方法が変わる。
 * - sealed: 未開封 BOX など。JAN コードで識別し、eBay も JAN（GTIN）で検索する
 * - psa10:  PSA10 鑑定済みカード。カード番号（例: 205/172）で識別し、eBay は「番号 PSA 10」で検索する
 * - single: 未鑑定のシングルカード。カード番号で識別する
 * - other:  その他の商品（スニーカーなど）。JAN コードか型番で識別する
 */
export type ResearchKind = "sealed" | "psa10" | "single" | "other";

export const RESEARCH_KINDS: { id: ResearchKind; label: string; hint: string }[] = [
  { id: "sealed", label: "未開封BOX", hint: "JAN コードで同じ商品を見分けます" },
  { id: "psa10", label: "PSA10", hint: "カード番号（例: 205/172）＋ PSA10 で見分けます" },
  { id: "single", label: "シングル（未鑑定）", hint: "カード番号（例: 205/172）で見分けます" },
  { id: "other", label: "その他", hint: "JAN コードか型番（例: DD1391-100）で見分けます" },
];

/** /api/research に送る検索条件 */
export type ResearchRequest = {
  kind: ResearchKind;
  /** 楽天・Yahoo!ショッピングで検索するキーワード */
  keyword: string;
  /** 除外したい言葉（タイトルに含まれる商品を除く） */
  ngWords: string[];
  /** 国内価格の下限・上限 [円] */
  minPriceJpy?: number;
  maxPriceJpy?: number;
  /**
   * eBay を JAN で検索して見つからなかったときに使うキーワード（英語）。
   * 1 つの商品に絞った検索条件のときだけ設定する（例: "Terastal Festival booster box japanese"）
   */
  ebayKeyword?: string;
  /** eBay で相場を調べる商品数の上限（API の利用回数を抑えるため） */
  maxLookups?: number;
};

export const MAX_LOOKUPS_LIMIT = 30;
export const DEFAULT_MAX_LOOKUPS = 15;

export type ShippingStatus = "free" | "extra" | "unknown";

/** 楽天・Yahoo! の商品 1 件 */
export type DomesticOffer = {
  source: "rakuten" | "yahoo";
  title: string;
  priceJpy: number;
  /** free: 送料無料・送料込み / extra: 送料別 / unknown: 条件付きなど不明 */
  shipping: ShippingStatus;
  url: string;
  shopName: string;
  imageUrl?: string;
};

/** eBay の相場（出品中・即決） */
export type EbayMarket = {
  /** eBay に送った検索キーワード（JAN 検索のときは空） */
  query: string;
  gtin?: string;
  /** JAN で見つからず、ebayKeyword で検索し直した */
  usedKeywordFallback: boolean;
  conditionIds: string[];
  /** eBay 上のヒット件数 */
  total: number;
  /** 関係ない出品（別商品・まとめ売り等）を除いて集計に使った件数 */
  count: number;
  minUsd: number | null;
  /** 安い方から 25% の位置の価格。売れやすい価格の目安として使う */
  p25Usd: number | null;
  medianUsd: number | null;
  /** 集計に使った出品の例（安い順） */
  samples: { title: string; priceUsd: number; url: string }[];
  /** eBay のサイトで同じ条件の出品中・落札済みを見るリンク */
  activeUrl: string;
  soldUrl: string;
};

/** 同じ商品とみなした国内の商品のまとまり＋eBay 相場 */
export type Candidate = {
  /** 識別キー（例: "jan:4521329362342" / "psa10:205/172"） */
  key: string;
  /** 画面に出す識別子（例: "JAN 4521329362342" / "205/172 PSA10"） */
  label: string;
  kind: ResearchKind;
  /** 国内の商品（安い順。楽天・Yahoo! それぞれ数件まで） */
  offers: DomesticOffer[];
  ebay: EbayMarket | null;
  /** eBay を調べられなかった理由 */
  ebayError?: string;
};

export type ResearchResponse = {
  candidates: Candidate[];
  /** 上限を超えたため eBay を調べなかった商品数 */
  skippedLookups: number;
  stats: {
    /** 取得できた件数（未設定やエラーのときは null） */
    rakuten: number | null;
    yahoo: number | null;
    /** 除外ワード等で除いた件数 */
    excluded: number;
    /** JAN・カード番号などが見つからず識別できなかった件数 */
    unidentified: number;
  };
  /** 楽天・Yahoo! のキー未設定やエラーなど、画面に出す注意 */
  warnings: string[];
  fetchedAt: string;
};

/** 保存しておく検索条件（プリセット） */
export type ResearchPreset = ResearchRequest & {
  id: string;
  name: string;
  /** この検索で使う国際送料 [円]（空なら計算条件の値） */
  internationalShippingJpy?: number;
};

export const DEFAULT_PRESETS: ResearchPreset[] = [
  {
    id: "preset-sealed",
    name: "ポケカ 未開封BOX",
    kind: "sealed",
    keyword: "ポケモンカード BOX 未開封 シュリンク付き",
    ngWords: [],
    minPriceJpy: 3000,
    internationalShippingJpy: 3000,
  },
  {
    id: "preset-psa10",
    name: "ポケカ PSA10",
    kind: "psa10",
    keyword: "ポケモンカード PSA10",
    ngWords: [],
    minPriceJpy: 5000,
    internationalShippingJpy: 2000,
  },
  {
    id: "preset-sar",
    name: "ポケカ SAR シングル",
    kind: "single",
    keyword: "ポケモンカード SAR",
    ngWords: [],
    minPriceJpy: 3000,
    internationalShippingJpy: 1500,
  },
];
