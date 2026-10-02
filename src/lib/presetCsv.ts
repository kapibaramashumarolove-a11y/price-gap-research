// 検索条件（プリセット）を CSV で読み込み・書き出しする（画面側で使う。通信はしない）。
// Excel で編集しやすいよう、見出しは日本語。英語の見出し（name, keyword など）でも読める。

import { normalizeJan, parseResearchRequest } from "./researchRequest";
import { ITEM_CONDITIONS, RESEARCH_KINDS, type ResearchPreset } from "./researchTypes";

// ---- CSV の文字列処理 ----

/**
 * CSV（または TSV）を行・列の配列にする。ダブルクォートで囲んだ値（カンマ・改行・"" を含む）にも対応。
 * 区切り文字は 1 行目にタブがあってカンマがなければタブ、それ以外はカンマ。
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === "") inQuotes = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 空行は除く
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeCsv).join(",")).join("\r\n") + "\r\n";
}

/**
 * ファイルの中身を文字列にする。UTF-8 として読めなければ Shift_JIS（Windows の Excel が CSV 保存で使う）として読む。
 */
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

// ---- 検索条件との変換 ----

type Field =
  | "name"
  | "genre"
  | "kind"
  | "keyword"
  | "jan"
  | "ebayKeyword"
  | "condition"
  | "ngWords"
  | "minPriceJpy"
  | "maxPriceJpy"
  | "internationalShippingJpy"
  | "maxLookups";

/** 書き出すときの列（この順・この見出し） */
export const CSV_COLUMNS: { field: Field; header: string }[] = [
  { field: "name", header: "名前" },
  { field: "genre", header: "ジャンル" },
  { field: "kind", header: "種類" },
  { field: "keyword", header: "検索キーワード" },
  { field: "jan", header: "JAN" },
  { field: "ebayKeyword", header: "eBayキーワード" },
  { field: "condition", header: "状態" },
  { field: "ngWords", header: "除外ワード" },
  { field: "minPriceJpy", header: "最低価格" },
  { field: "maxPriceJpy", header: "最高価格" },
  { field: "internationalShippingJpy", header: "国際送料" },
  { field: "maxLookups", header: "eBay調査件数" },
];

/** 読み込むときに受け付ける見出し（全角・半角・大文字小文字・空白は無視して比べる） */
const HEADER_ALIASES: Record<Field, string[]> = {
  name: ["名前", "商品名", "name"],
  genre: ["ジャンル", "カテゴリ", "カテゴリー", "genre", "category"],
  kind: ["種類", "kind", "type"],
  keyword: ["検索キーワード", "キーワード", "国内キーワード", "keyword"],
  jan: ["jan", "janコード", "jancode", "jan_code", "gtin"],
  ebayKeyword: ["ebayキーワード", "ebay検索キーワード", "英語キーワード", "ebaykeyword", "ebay_keyword"],
  condition: ["状態", "コンディション", "condition"],
  ngWords: ["除外ワード", "ngワード", "ngwords", "ng_words", "exclude"],
  minPriceJpy: ["最低価格", "下限価格", "minprice", "min_price"],
  maxPriceJpy: ["最高価格", "上限価格", "maxprice", "max_price"],
  internationalShippingJpy: ["国際送料", "shipping", "international_shipping"],
  maxLookups: ["ebay調査件数", "調査件数", "maxlookups", "max_lookups"],
};

function headerKey(header: string): string {
  return header.normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
}

const HEADER_TO_FIELD = new Map<string, Field>(
  (Object.entries(HEADER_ALIASES) as [Field, string[]][]).flatMap(([field, names]) =>
    names.map((n) => [headerKey(n), field] as const),
  ),
);

const KIND_ALIASES = new Map<string, ResearchPreset["kind"]>([
  ...RESEARCH_KINDS.map((k) => [headerKey(k.label), k.id] as const),
  ...RESEARCH_KINDS.map((k) => [k.id, k.id] as const),
  [headerKey("シングル"), "single"],
  [headerKey("BOX"), "sealed"],
]);

const CONDITION_ALIASES = new Map<string, NonNullable<ResearchPreset["condition"]>>([
  ...ITEM_CONDITIONS.map((c) => [headerKey(c.label), c.id] as const),
  ...ITEM_CONDITIONS.map((c) => [c.id, c.id] as const),
  [headerKey("新品・中古"), "any"],
  [headerKey("指定なし"), "any"],
]);

export type CsvImportError = { line: number; message: string };

export type CsvImportResult = {
  presets: ResearchPreset[];
  errors: CsvImportError[];
  /** 見出しに知らない列があった場合（読み飛ばした列名） */
  ignoredColumns: string[];
};

/**
 * CSV を検索条件の一覧にする。1 行目は見出し。
 * 各行は /api/research と同じ規則で検査し、問題のある行はエラーとして行番号付きで返す（他の行は読み込む）。
 * @param newId 新しい検索条件の ID を作る関数
 */
export function presetsFromCsv(text: string, newId: () => string): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { presets: [], errors: [{ line: 1, message: "CSV が空です。" }], ignoredColumns: [] };

  const header = rows[0].map((h) => HEADER_TO_FIELD.get(headerKey(h)));
  const ignoredColumns = rows[0].filter((_, i) => !header[i] && rows[0][i].trim() !== "");
  if (!header.includes("name")) {
    return { presets: [], errors: [{ line: 1, message: "1 行目に「名前」の列が必要です。" }], ignoredColumns };
  }

  const presets: ResearchPreset[] = [];
  const errors: CsvImportError[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (field: Field) => {
      const index = header.indexOf(field);
      return index >= 0 ? (cells[index] ?? "").trim() : "";
    };

    const name = get("name");
    if (name === "") {
      errors.push({ line, message: "名前がありません。" });
      return;
    }
    const kindRaw = get("kind");
    const kind = kindRaw === "" ? "item" : KIND_ALIASES.get(headerKey(kindRaw));
    if (!kind) {
      errors.push({ line, message: `種類「${kindRaw}」が分かりません（${RESEARCH_KINDS.map((k) => k.label).join("・")}）。` });
      return;
    }
    const conditionRaw = get("condition");
    const condition = conditionRaw === "" ? "new" : CONDITION_ALIASES.get(headerKey(conditionRaw));
    if (!condition) {
      errors.push({ line, message: `状態「${conditionRaw}」が分かりません（新品・中古・すべて）。` });
      return;
    }
    const jan = normalizeJan(get("jan"));
    if (jan === null) {
      errors.push({ line, message: `JAN「${get("jan")}」が正しくありません。Excel で「4.52E+12」のような表示になっていないか確認してください。` });
      return;
    }
    // 全角数字・金額のカンマ・「円」などを取り除いて数値にする
    const number = (field: Field) => (get(field) === "" ? undefined : get(field).normalize("NFKC").replace(/[,円¥]/g, ""));

    // /api/research と同じ規則で検査する
    const parsed = parseResearchRequest({
      kind,
      keyword: get("keyword"),
      ngWords: get("ngWords").split(/[\s,、]+/),
      minPriceJpy: number("minPriceJpy"),
      maxPriceJpy: number("maxPriceJpy"),
      ebayKeyword: get("ebayKeyword"),
      maxLookups: number("maxLookups"),
      jan,
      condition,
    });
    if (typeof parsed === "string") {
      errors.push({ line, message: parsed });
      return;
    }
    const shipping = number("internationalShippingJpy");
    const shippingJpy = shipping === undefined ? undefined : Number(shipping);
    if (shippingJpy !== undefined && !(Number.isFinite(shippingJpy) && shippingJpy >= 0)) {
      errors.push({ line, message: "国際送料には 0 以上の数値を入力してください。" });
      return;
    }

    presets.push({
      ...parsed,
      id: newId(),
      name,
      genre: get("genre") || undefined,
      internationalShippingJpy: shippingJpy,
    });
  });
  return { presets, errors, ignoredColumns };
}

/** 検索条件の一覧を CSV にする（Excel でそのまま開けるよう、ダウンロード時に BOM を付けること） */
export function presetsToCsv(presets: ResearchPreset[]): string {
  const kindLabel = (kind: ResearchPreset["kind"]) => RESEARCH_KINDS.find((k) => k.id === kind)?.label ?? kind;
  const conditionLabel = (p: ResearchPreset) =>
    p.kind === "item" ? (ITEM_CONDITIONS.find((c) => c.id === (p.condition ?? "new"))?.label ?? "") : "";
  const str = (n: number | undefined) => (n === undefined ? "" : String(n));
  return toCsv([
    CSV_COLUMNS.map((c) => c.header),
    ...presets.map((p) => [
      p.name,
      p.genre ?? "",
      kindLabel(p.kind),
      p.keyword,
      p.jan ?? "",
      p.ebayKeyword ?? "",
      conditionLabel(p),
      p.ngWords.join(" "),
      str(p.minPriceJpy),
      str(p.maxPriceJpy),
      str(p.internationalShippingJpy),
      str(p.maxLookups),
    ]),
  ]);
}

/** 入力例（テンプレート）。キーワードは例なので、実際に調べたい商品に書き換えて使う */
export const CSV_TEMPLATE = toCsv([
  CSV_COLUMNS.map((c) => c.header),
  ["Nikon F3 ボディ", "カメラ", "商品指定", "ニコン F3 ボディ", "", "Nikon F3 body", "中古", "", "10000", "", "3000", ""],
  ["シマノ 22ステラ C3000XG", "釣具", "商品指定", "シマノ 22ステラ C3000XG", "", "Shimano 22 Stella C3000XG", "新品", "", "30000", "", "2500", ""],
  ["神々のトライフォース SFC", "レトロゲーム", "商品指定", "神々のトライフォース スーパーファミコン", "", "Zelda Triforce Super Famicom", "中古", "箱なし", "", "", "1500", ""],
  ["BOSS DS-1", "エフェクター", "商品指定", "BOSS DS-1", "", "Boss DS-1", "中古", "", "3000", "", "2000", ""],
  ["ポケカ 未開封BOX", "ポケモンカード", "未開封BOX", "ポケモンカード BOX 未開封 シュリンク付き", "", "", "", "", "3000", "", "3000", "15"],
]);

/** 読み込み方。merge: 同じ名前の検索条件は更新して、ほかは追加 / replace: すべて置き換え */
export type CsvMode = "merge" | "replace";

/** CSV で読み込んだ検索条件を今の一覧に反映する。merge は同じ名前を更新（ID は元のまま）して、ほかは追加 */
export function applyImportedPresets(current: ResearchPreset[], imported: ResearchPreset[], mode: CsvMode): ResearchPreset[] {
  if (mode === "replace") return imported;
  const next = [...current];
  for (const preset of imported) {
    const i = next.findIndex((p) => p.name === preset.name);
    if (i >= 0) next[i] = { ...preset, id: next[i].id };
    else next.push(preset);
  }
  return next;
}
