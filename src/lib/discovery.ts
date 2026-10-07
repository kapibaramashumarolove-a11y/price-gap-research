// 全自動バルクリサーチの選択肢（画面・サーバー共通）。
// カテゴリは、Keepa（Amazon）・Yahoo! はカテゴリ名で照合し（ID は実行時に各 API から取得）、楽天はジャンル ID を使う。

export type DiscoverySource = "keepa" | "rakuten" | "yahoo";
export type DiscoveryCategory = "all" | "electronics" | "toys" | "beauty" | "daily";

export const DISCOVERY_SOURCES: { id: DiscoverySource; label: string; hint: string }[] = [
  { id: "keepa", label: "Keepa条件抽出", hint: "Amazon ランキング 5 万位以内・Amazon 本体なし・新品出品者 2〜10 人" },
  { id: "rakuten", label: "楽天 高ポイント", hint: "ポイント 5 倍以上の在庫あり商品（説明文に JAN があるもの）" },
  { id: "yahoo", label: "Yahoo!ランキング", hint: "評価の高い人気商品ランキング（JAN つき）" },
];

export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  /** Amazon（Keepa）のトップカテゴリ名に合う正規表現 */
  amazon?: string;
  /** Yahoo! のトップカテゴリ名に合う正規表現 */
  yahoo?: string;
  /** 楽天のジャンル ID（0 = すべて） */
  rakutenGenreId: string;
}[] = [
  { id: "all", label: "すべて", rakutenGenreId: "0" },
  { id: "electronics", label: "家電", amazon: "家電", yahoo: "家電", rakutenGenreId: "562637" },
  { id: "toys", label: "おもちゃ", amazon: "おもちゃ|ホビー", yahoo: "おもちゃ|ホビー|ゲーム", rakutenGenreId: "566382" },
  { id: "beauty", label: "ビューティー", amazon: "ビューティー|コスメ", yahoo: "ビューティー|コスメ|美容", rakutenGenreId: "100939" },
  { id: "daily", label: "日用品", amazon: "ドラッグストア|日用品|ホーム", yahoo: "日用品|キッチン|ドラッグ|ヘルス", rakutenGenreId: "215783" },
];

export const DISCOVERY_LIMITS = [20, 50, 100] as const;

/** 楽天の高ポイント検索で使う最低ポイント倍率 */
export const RAKUTEN_MIN_POINT_RATE = 5;

export function categoryPattern(category: DiscoveryCategory, mall: "amazon" | "yahoo"): RegExp | undefined {
  const source = DISCOVERY_CATEGORIES.find((c) => c.id === category)?.[mall];
  return source ? new RegExp(source) : undefined;
}
