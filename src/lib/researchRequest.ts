// /api/research に送られてきた JSON を検査して ResearchRequest にする（画面に返すエラーは日本語）。

import { isValidJan, normalizeText } from "./identify";
import { DEFAULT_SETTINGS, type Settings } from "./profit";
import { DEFAULT_CRITERIA, MIN_RANKS, PRICE_BASES, type MinRank, type PriceBasis, type TreasureCriteria } from "./researchProfit";
import {
  ITEM_CONDITIONS,
  MAX_LOOKUPS_LIMIT,
  RESEARCH_KINDS,
  type ItemCondition,
  type ResearchKind,
  type ResearchRequest,
} from "./researchTypes";

const KIND_IDS = new Set<string>(RESEARCH_KINDS.map((k) => k.id));
const CONDITION_IDS = new Set<string>(ITEM_CONDITIONS.map((c) => c.id));

/**
 * JAN コードを整える（全角・ハイフン・空白を取り除く）。
 * @returns 空なら undefined、JAN（13 桁はチェックデジットも確認）・EAN-8・UPC（12 桁）として正しくなければ null
 */
export function normalizeJan(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const code = normalizeText(String(raw)).replace(/[-\s]/g, "");
  if (code === "") return undefined;
  if (/^\d{13}$/.test(code)) return isValidJan(code) ? code : null;
  return /^(\d{8}|\d{12})$/.test(code) ? code : null;
}

function optionalNumber(value: unknown, max: number): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.floor(n) : null;
}

/** 送られてきた JSON を検査して ResearchRequest にする。おかしければエラーメッセージを返す */
export function parseResearchRequest(body: unknown): ResearchRequest | string {
  if (typeof body !== "object" || body === null) return "リクエストの形式が正しくありません。";
  const b = body as Record<string, unknown>;

  if (typeof b.kind !== "string" || !KIND_IDS.has(b.kind)) return "種類（kind）が正しくありません。";
  const kind = b.kind as ResearchKind;
  const keyword = typeof b.keyword === "string" ? b.keyword.trim() : "";
  const jan = kind === "item" ? normalizeJan(b.jan) : undefined;
  if (jan === null) return "JAN コードが正しくありません（13 桁・8 桁・12 桁の数字）。";
  // 商品指定で JAN があれば、キーワードなしでも JAN で探せる
  if (keyword.length < 2 && !jan) return "検索キーワードを 2 文字以上で入力してください。";
  if (keyword.length > 100) return "検索キーワードが長すぎます（100 文字まで）。";

  const ngWords = Array.isArray(b.ngWords)
    ? b.ngWords.filter((w): w is string => typeof w === "string").map((w) => w.trim()).filter(Boolean)
    : [];
  if (ngWords.length > 30 || ngWords.some((w) => w.length > 30)) return "除外ワードが多すぎるか長すぎます。";

  const minPriceJpy = optionalNumber(b.minPriceJpy, 100_000_000);
  const maxPriceJpy = optionalNumber(b.maxPriceJpy, 100_000_000);
  const maxLookups = optionalNumber(b.maxLookups, MAX_LOOKUPS_LIMIT);
  if (minPriceJpy === null || maxPriceJpy === null) return "価格の範囲が正しくありません。";
  if (maxLookups === null) return `eBay で調べる件数は ${MAX_LOOKUPS_LIMIT} 件までです。`;

  const ebayKeyword = typeof b.ebayKeyword === "string" ? b.ebayKeyword.trim().slice(0, 100) : "";
  if (kind === "item" && !jan && !ebayKeyword) return "商品指定では eBay 用の英語キーワードか JAN を入力してください。";

  const condition = b.condition === undefined || b.condition === "" ? undefined : String(b.condition);
  if (condition !== undefined && !CONDITION_IDS.has(condition)) return "商品の状態（condition）が正しくありません。";

  return {
    kind,
    keyword,
    ngWords,
    minPriceJpy,
    maxPriceJpy,
    ebayKeyword: ebayKeyword || undefined,
    maxLookups,
    ...(kind === "item" ? { jan, condition: (condition as ItemCondition | undefined) ?? "new" } : {}),
  };
}

// ---- /api/discover（売れ筋から探す）に送られてくる内容の検査 ----

/** 0 以上の有限な数値ならその値、そうでなければ初期値 */
function numberOr(value: unknown, fallback: number, max = 1_000_000_000): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
}

/** 計算条件（為替・手数料・国際送料）。おかしな値は初期値にする */
export function parseSettings(value: unknown): Settings {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    usdJpy: numberOr(v.usdJpy, DEFAULT_SETTINGS.usdJpy, 10_000),
    ebayFeeRate: numberOr(v.ebayFeeRate, DEFAULT_SETTINGS.ebayFeeRate, 100),
    internationalFeeRate: numberOr(v.internationalFeeRate, DEFAULT_SETTINGS.internationalFeeRate, 100),
    perOrderFeeUsd: numberOr(v.perOrderFeeUsd, DEFAULT_SETTINGS.perOrderFeeUsd, 1000),
    internationalShippingJpy: numberOr(v.internationalShippingJpy, DEFAULT_SETTINGS.internationalShippingJpy),
  };
}

/** お宝の条件。おかしな値は初期値にする */
export function parseCriteria(value: unknown): TreasureCriteria {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_CRITERIA;
  return {
    minProfitJpy: numberOr(v.minProfitJpy, d.minProfitJpy),
    minMarginPercent: numberOr(v.minMarginPercent, d.minMarginPercent, 1000),
    minEbayListings: numberOr(v.minEbayListings, d.minEbayListings, 1000),
    minPriceRatioPercent: numberOr(v.minPriceRatioPercent, d.minPriceRatioPercent, 100),
    basis: PRICE_BASES.some((b) => b.id === v.basis) ? (v.basis as PriceBasis) : d.basis,
    minRank: MIN_RANKS.some((r) => r.id === v.minRank) ? (v.minRank as MinRank) : d.minRank,
    domesticShippingJpy: numberOr(v.domesticShippingJpy, d.domesticShippingJpy),
  };
}

/** 1 回に調べるランキングの商品数の上限（eBay の利用回数と処理時間を抑えるため） */
export const MAX_DISCOVER_ITEMS = 30;
