// JAN コード（EAN-13 / EAN-8）の扱いと、文字の正規化。画面・サーバーの両方から使う。

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** 全角英数字・記号を半角にし（NFKC）、HTML の文字参照を戻し、空白をまとめる */
export function normalizeText(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** JAN の区切りに使われる文字（空白・ハイフン・マイナス・長音など。NFKC で半角にならないものも含む） */
const JAN_SEPARATORS = /[\s\-\u2010-\u2015\u2212\u30fc\uff70]/g;

/** JAN（EAN-13・EAN-8）のチェックデジットが正しいか */
export function isValidJan(code: string): boolean {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const body = digits.slice(0, -1);
  // 右から数えて奇数番目（チェックデジットの左隣から）に 3 を掛ける
  const sum = body.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[digits.length - 1];
}

/**
 * 入力された JAN を整える（全角・ハイフン・空白を取り除く）。
 * @returns 空なら undefined、JAN として正しくなければ null
 */
export function normalizeJan(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const code = normalizeText(String(raw)).replace(JAN_SEPARATORS, "");
  if (code === "") return undefined;
  return isValidJan(code) ? code : null;
}

/** 文章の中から正しい JAN（13 桁・8 桁）をすべて取り出す（重複は除く、見つかった順） */
export function extractJans(text: string): string[] {
  const found = normalizeText(text).match(/(?<!\d)(\d{13}|\d{8})(?!\d)/g) ?? [];
  return [...new Set(found.filter(isValidJan))];
}

/** 文章の中に、指定した JAN がそのまま（前後に数字が続かずに）書かれているか */
export function containsJan(text: string, jan: string): boolean {
  // 区切りは JAN の数字の間だけ認める（後ろの「1個」などの数字とつなげない）
  const pattern = [...jan].join(`${JAN_SEPARATORS.source}?`);
  return new RegExp(`(?<!\\d)${pattern}(?!\\d)`).test(normalizeText(text));
}
