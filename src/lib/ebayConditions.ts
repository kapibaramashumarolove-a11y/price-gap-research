// eBay の商品状態（コンディション ID）の定義。
// サーバー側（検索の絞り込み）と画面側（表示・将来の選択 UI）の両方から使うため、
// キーなどサーバー専用のものはこのファイルに置かないこと。
//
// 同じ ID でもカテゴリによって意味が変わるものがある（例：トレーディングカードでは
// 2750 = 鑑定済み（Graded）、4000 = 未鑑定（Ungraded））。
// 参考: https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html

export type EbayCondition = {
  id: string;
  /** 画面に出す名前 */
  label: string;
};

export const EBAY_CONDITIONS: readonly EbayCondition[] = [
  { id: "1000", label: "新品" },
  { id: "1500", label: "新品（その他・箱なし等）" },
  { id: "1750", label: "新品（難あり）" },
  { id: "2000", label: "メーカー整備済み" },
  { id: "2500", label: "出品者による整備済み" },
  { id: "2750", label: "ほぼ新品／カード：鑑定済み（Graded）" },
  { id: "3000", label: "中古" },
  { id: "4000", label: "中古（非常に良い）／カード：未鑑定（Ungraded）" },
  { id: "5000", label: "中古（良い）" },
  { id: "6000", label: "中古（可）" },
  { id: "7000", label: "ジャンク（部品取り・動作不良）" },
];

/** 何も指定しないときの絞り込み：新品のみ（中古が混ざると相場が下がるため） */
export const DEFAULT_CONDITION_IDS: readonly string[] = ["1000"];

const KNOWN_IDS = new Set(EBAY_CONDITIONS.map((c) => c.id));

export function isKnownConditionId(id: string): boolean {
  return KNOWN_IDS.has(id);
}

/** ID の一覧を画面用の名前にする（例：["1000"] → "新品"） */
export function conditionLabel(ids: readonly string[]): string {
  if (ids.length === 0) return "すべての状態";
  return ids.map((id) => EBAY_CONDITIONS.find((c) => c.id === id)?.label ?? id).join("・");
}

/**
 * "1000,3000" のようなカンマ区切りの文字列を ID の配列にする。
 * 空なら既定値（新品のみ）、"all" なら絞り込みなし（空配列）。未知の ID があれば null。
 */
export function parseConditionIds(raw: string | null | undefined): string[] | null {
  const value = (raw ?? "").trim();
  if (value === "") return [...DEFAULT_CONDITION_IDS];
  if (value.toLowerCase() === "all") return [];
  const ids = [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
  return ids.every(isKnownConditionId) ? ids : null;
}
