// 「直接入力でリサーチ」の入力（1 行に 1 商品）を検索条件（商品指定）にする。画面側で使う。
//
// 書き方:
//   BOSS DS-1                        … 型番・英語の商品名はそのまま国内・eBay の両方で検索
//   キヤノン AE-1                    … 日本語が混ざっていても、型番（英数字 3 文字以上）があれば eBay は型番で検索
//   ニコン F3 ボディ | Nikon F3 body  … 「|」の左が国内、右が eBay（英語）
//   4521329362342                    … JAN コードだけでも可

import { normalizeText } from "./identify";
import { normalizeJan, parseResearchRequest } from "./researchRequest";
import type { ItemCondition, ResearchPreset } from "./researchTypes";

const JAPANESE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

/**
 * 日本語まじりの商品名から eBay 用のキーワードを取り出す（英数字の単語だけを残す）。
 * 型番らしい単語（英字と数字を含む 3 文字以上。例: AE-1, DS-1, C3000XG）がなければ、
 * 誤った商品と比べないよう undefined を返す（「F3」のような短い単語だけでは決めない）。
 */
export function deriveEbayKeyword(text: string): string | undefined {
  const t = normalizeText(text);
  if (!JAPANESE.test(t)) return t;
  const ascii = t.split(" ").filter((w) => /^[\x21-\x7e]+$/.test(w));
  const hasModel = ascii.some((w) => w.length >= 3 && /[a-z]/i.test(w) && /\d/.test(w));
  return hasModel ? ascii.join(" ") : undefined;
}

export type QuickLine = {
  /** 何行目か（1 から） */
  line: number;
  text: string;
  preset?: ResearchPreset;
  error?: string;
};

export function parseQuickInput(
  text: string,
  options: { condition: ItemCondition; genre?: string },
  newId: () => string,
): QuickLine[] {
  return text.split(/\r?\n/).flatMap((raw, i): QuickLine[] => {
    const line = raw.trim();
    if (line === "") return [];
    const [domesticPart, ebayPart = ""] = line.split(/\s*[|｜]\s*/, 2);
    const domestic = domesticPart.trim();
    const jan = /^[\d\s-]+$/.test(normalizeText(domestic)) ? normalizeJan(domestic) : undefined;
    if (jan === null) return [{ line: i + 1, text: line, error: "JAN コードが正しくありません（13 桁・8 桁・12 桁の数字）。" }];

    const keyword = jan ? "" : domestic;
    const ebayKeyword = ebayPart.trim() || (jan ? undefined : deriveEbayKeyword(domestic));
    if (!jan && !ebayKeyword) {
      return [
        {
          line: i + 1,
          text: line,
          error: `eBay は英語で検索するので「${domestic} | 英語の商品名」のように、| の後に英語のキーワードを書いてください。`,
        },
      ];
    }
    const parsed = parseResearchRequest({ kind: "item", keyword, ngWords: [], ebayKeyword, jan, condition: options.condition });
    if (typeof parsed === "string") return [{ line: i + 1, text: line, error: parsed }];
    return [
      {
        line: i + 1,
        text: line,
        preset: { ...parsed, id: newId(), name: jan ? `JAN ${jan}` : domestic, genre: options.genre?.trim() || undefined },
      },
    ];
  });
}
