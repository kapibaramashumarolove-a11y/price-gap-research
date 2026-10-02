// /api/research に送られてきた JSON を検査して ResearchRequest にする（画面に返すエラーは日本語）。

import { MAX_LOOKUPS_LIMIT, RESEARCH_KINDS, type ResearchKind, type ResearchRequest } from "./researchTypes";

const KIND_IDS = new Set<string>(RESEARCH_KINDS.map((k) => k.id));

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
  const keyword = typeof b.keyword === "string" ? b.keyword.trim() : "";
  if (keyword.length < 2) return "検索キーワードを 2 文字以上で入力してください。";
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

  return {
    kind: b.kind as ResearchKind,
    keyword,
    ngWords,
    minPriceJpy,
    maxPriceJpy,
    ebayKeyword: ebayKeyword || undefined,
    maxLookups,
  };
}
