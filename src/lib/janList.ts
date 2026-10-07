// 調べる JAN の一覧（貼り付け・CSV の読み込みと書き出し）。画面側で使う。

import { extractJans, isValidJan, normalizeText } from "./jan";

export type JanItem = {
  jan: string;
  /** 自分用のメモ（商品名など。空でもよい） */
  name?: string;
};

export type JanListParseResult = {
  items: JanItem[];
  /** 読み込めなかった行（JAN が見つからない・チェックデジットが違う） */
  errors: { line: number; text: string; message: string }[];
  /** 同じ JAN が 2 回以上あったので 1 つにまとめた数 */
  duplicates: number;
};

/**
 * 貼り付けた文字や CSV から JAN を読み取る。1 行に 1 商品で、JAN 以外の文字は商品名（メモ）として扱う。
 * 例: 「4902370548495」「4902370548495,ニンテンドースイッチ」「ニンテンドースイッチ 4902370548495」
 * 数字のない行（見出しなど）は読み飛ばす。
 */
export function parseJanList(text: string): JanListParseResult {
  const items: JanItem[] = [];
  const errors: JanListParseResult["errors"] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = normalizeText(raw.replace(/"/g, ""));
    if (!/\d/.test(line)) return;
    // 「4902-370-548495」のようなハイフン区切りも JAN として読む
    const jans = extractJans(line.replace(/(\d)-(?=\d)/g, "$1"));
    if (jans.length === 0) {
      const digits = line.match(/\d{8,14}/)?.[0];
      errors.push({
        line: i + 1,
        text: raw.trim().slice(0, 80),
        message: digits && (digits.length === 8 || digits.length === 13) && !isValidJan(digits) ? "JAN のチェックデジットが違います" : "JAN（13 桁・8 桁）が見つかりません",
      });
      return;
    }
    const jan = jans[0];
    if (seen.has(jan)) {
      duplicates++;
      return;
    }
    seen.add(jan);
    const name = line
      .replace(new RegExp(jan.split("").join("-?")), "")
      .replace(/^[\s,，\t;:：、=]+|[\s,，\t;:：、=]+$/g, "")
      .replace(/\s*[,\t]\s*/g, " ")
      .trim();
    items.push(name ? { jan, name: name.slice(0, 100) } : { jan });
  });
  return { items, errors, duplicates };
}

/** 今の一覧に追加する（同じ JAN は、新しい商品名があれば上書き） */
export function mergeJanItems(current: JanItem[], added: JanItem[]): JanItem[] {
  const byJan = new Map(current.map((item) => [item.jan, item]));
  for (const item of added) {
    const prev = byJan.get(item.jan);
    byJan.set(item.jan, { jan: item.jan, name: item.name ?? prev?.name });
  }
  return [...byJan.values()];
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 一覧を CSV にする（Excel で JAN が指数表記にならないよう、JAN は ="…" で書き出す） */
export function janListToCsv(items: JanItem[]): string {
  return ["JAN,商品名", ...items.map((i) => `="${i.jan}",${csvCell(i.name ?? "")}`)].join("\r\n") + "\r\n";
}

/** CSV ファイルの中身を文字にする（UTF-8 で読めなければ、Excel の Shift_JIS として読む） */
export function decodeCsvBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}
