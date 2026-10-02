// 商品タイトルから「同じ商品」を見分けるための識別子（JAN・カード番号・型番）を取り出し、
// eBay で相場を調べるための検索条件を作る。通信はしない純粋な関数だけを置く。

import type { ItemCondition, ResearchKind } from "./researchTypes";

// ---- 文字の正規化 ----

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

// ---- 識別子の抽出 ----

/** JAN（EAN-13）のチェックデジットが正しいか */
export function isValidJan(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/** 文章の中から日本の JAN コード（45・49 で始まる 13 桁）を探す */
export function extractJan(text: string): string | undefined {
  for (const m of normalizeText(text).matchAll(/(?<!\d)(4[59]\d{11})(?!\d)/g)) {
    if (isValidJan(m[1])) return m[1];
  }
  return undefined;
}

/**
 * カード番号を探す（例: "205/172"、プロモの "001/SV-P"）。
 * 日付（2025/10/02）を拾わないよう、前後にさらに「/数字」が続くものは除く。
 */
export function extractCardNumber(text: string): string | undefined {
  const t = normalizeText(text);
  const promo = t.match(/(?<![\d/])(\d{3})\s*\/\s*(SV-P|S-P|SM-P|M-P)(?![\w])/i);
  if (promo) return `${promo[1]}/${promo[2].toUpperCase()}`;
  const m = t.match(/(?<![\d/])(\d{1,3})\s*\/\s*(\d{2,3})(?![\d/])/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function isPsa10(text: string): boolean {
  return /PSA\s*10(?!\d)/i.test(normalizeText(text));
}

/** 鑑定済み（PSA・BGS など）の表記があるか */
export function isGraded(text: string): boolean {
  return /\b(PSA|BGS|CGC|ARS)\s*\d|鑑定/i.test(normalizeText(text));
}

/** スニーカーなどの型番（例: Nike の DD1391-100） */
export function extractModelNumber(text: string): string | undefined {
  return normalizeText(text).toUpperCase().match(/(?<![A-Z0-9])([A-Z]{2}\d{4}-\d{3})(?![0-9])/)?.[1];
}

export type Identity = {
  /** 同じ商品をまとめるためのキー */
  key: string;
  /** 画面に出す識別子 */
  label: string;
  jan?: string;
  cardNumber?: string;
  modelNumber?: string;
};

/**
 * 商品を識別する。識別できない（＝別の商品と区別できない）ものは undefined。
 * @param jan API から JAN が直接分かる場合（Yahoo!）はそれを優先する
 */
export function identify(kind: ResearchKind, text: string, jan?: string): Identity | undefined {
  const janCode = jan && isValidJan(jan) ? jan : extractJan(text);
  switch (kind) {
    case "sealed":
      return janCode ? { key: `jan:${janCode}`, label: `JAN ${janCode}`, jan: janCode } : undefined;
    case "psa10": {
      const num = extractCardNumber(text);
      return num && isPsa10(text) ? { key: `psa10:${num}`, label: `${num} PSA10`, cardNumber: num } : undefined;
    }
    case "single": {
      const num = extractCardNumber(text);
      return num ? { key: `single:${num}`, label: num, cardNumber: num } : undefined;
    }
    case "other": {
      if (janCode) return { key: `jan:${janCode}`, label: `JAN ${janCode}`, jan: janCode };
      const model = extractModelNumber(text);
      return model ? { key: `model:${model}`, label: model, modelNumber: model } : undefined;
    }
    case "item":
      // 商品指定は検索条件そのものが 1 つの商品なので、タイトルからの識別はしない
      return undefined;
  }
}

// ---- 国内商品の除外 ----

/** どの種類でも除外する言葉（くじ・オリパ・周辺グッズなど、相場の比較にならないもの） */
const COMMON_NG_WORDS = [
  "オリパ",
  "くじ",
  "ガチャ",
  "福袋",
  "ローダー",
  "スリーブ",
  "デッキシールド",
  "プレイマット",
  "ストレージ",
  "空箱",
  "予約",
  "代行",
  "まとめ売り",
];

/** 商品指定（カメラ・釣具など）で除外する言葉（壊れている・部品用・予約など、相場の比較にならないもの） */
const ITEM_NG_WORDS = ["ジャンク", "部品取り", "故障", "動作未確認", "難あり", "訳あり", "訳アリ", "予約", "代行", "レンタル"];

const SEALED_NG_WORDS = ["開封済", "中古", "シュリンクなし", "シュリンク無し", "訳あり", "訳アリ", "カートン", "パック単品", "バラ"];

/** 種類ごとの除外ルールに当てはまるか（当てはまれば除外する） */
export function isExcludedOffer(kind: ResearchKind, title: string, ngWords: readonly string[] = []): boolean {
  const t = normalizeText(title);
  const words = [...(kind === "item" ? ITEM_NG_WORDS : COMMON_NG_WORDS), ...ngWords.map(normalizeText).filter(Boolean)];
  if (kind === "sealed") words.push(...SEALED_NG_WORDS);
  if (words.some((w) => t.includes(w))) return true;

  // 複数箱のセット（2BOX・3箱など）や 1 パックだけの出品は BOX 1 個の値段と比べられない
  if (kind === "sealed" && /(?<!\d)[2-9]\s*(BOX|箱)|\d+\s*個セット|(?<!\d)1\s*パック(?!入)/i.test(t)) return true;
  if (kind === "single" && isGraded(t)) return true;
  return false;
}

// ---- eBay の検索条件 ----

export type EbaySearchPlan = {
  q?: string;
  gtin?: string;
  conditionIds: string[];
  /** 出品タイトルがこの条件に合うものだけ集計する */
  titleFilter: (title: string) => boolean;
  /** eBay サイトで検索するときのキーワード */
  webQuery: string;
};

/** 偽物・カスタム品・別言語版など、相場から外す出品 */
const EBAY_COMMON_EXCLUDE = /\b(custom|proxy|fan ?art|replica|reprint|orica|metal|digital|code card)\b/i;
const EBAY_OTHER_LANGUAGE = /\b(korean|chinese|s-chinese|t-chinese|indonesian|thai|english)\b/i;
const EBAY_SEALED_EXCLUDE =
  /\bx\s?[2-9]\d*\b|\b[2-9]\d*\s?x\b|\b[2-9]\d*\s?(boxes|box lot|bx)\b|\bcase\b|\bempty\b|\b1\s?pack\b|\bsingle pack\b|\bpack only\b|\bbundle\b|\blot\b/i;
const EBAY_SET_EXCLUDE = /\blot\b|full set|complete set|god pack|\bbundle\b/i;

function containsCardNumber(title: string, cardNumber: string): boolean {
  const [num, den] = cardNumber.split("/");
  const escapedDen = den.replace(/[-]/g, "\\-");
  return new RegExp(`(?<![\\d/])#?${num}\\s*/\\s*${escapedDen}(?![\\d/])`, "i").test(normalizeText(title));
}

/**
 * eBay で相場を調べる方法を決める。
 * @returns 識別子が足りず調べられないときは undefined
 */
export function planEbaySearch(kind: ResearchKind, identity: Identity): EbaySearchPlan | undefined {
  switch (kind) {
    case "sealed":
      if (!identity.jan) return undefined;
      return {
        gtin: identity.jan,
        conditionIds: ["1000"],
        webQuery: identity.jan,
        titleFilter: (t) =>
          /box/i.test(t) &&
          !EBAY_SEALED_EXCLUDE.test(t) &&
          !EBAY_COMMON_EXCLUDE.test(t) &&
          !EBAY_OTHER_LANGUAGE.test(t),
      };
    case "psa10": {
      const num = identity.cardNumber;
      if (!num) return undefined;
      const q = `${num} PSA 10 japanese`;
      return {
        q,
        conditionIds: ["2750"],
        webQuery: q,
        titleFilter: (t) =>
          containsCardNumber(t, num) &&
          /PSA\s*10(?!\d)/i.test(t) &&
          !/\b(BGS|CGC|ARS)\b/i.test(t) &&
          !EBAY_SET_EXCLUDE.test(t) &&
          !EBAY_COMMON_EXCLUDE.test(t) &&
          !EBAY_OTHER_LANGUAGE.test(t),
      };
    }
    case "single": {
      const num = identity.cardNumber;
      if (!num) return undefined;
      const q = `${num} japanese`;
      return {
        q,
        conditionIds: ["4000"],
        webQuery: q,
        titleFilter: (t) =>
          containsCardNumber(t, num) &&
          !/\b(PSA|BGS|CGC|ARS|graded|slab)\b/i.test(t) &&
          !EBAY_SET_EXCLUDE.test(t) &&
          !EBAY_COMMON_EXCLUDE.test(t) &&
          !EBAY_OTHER_LANGUAGE.test(t),
      };
    }
    case "other":
      if (identity.jan) {
        return {
          gtin: identity.jan,
          conditionIds: ["1000"],
          webQuery: identity.jan,
          titleFilter: (t) => !EBAY_COMMON_EXCLUDE.test(t) && !/\blot\b/i.test(t),
        };
      }
      if (identity.modelNumber) {
        const model = identity.modelNumber;
        return {
          q: model,
          conditionIds: ["1000"],
          webQuery: model,
          titleFilter: (t) => normalizeText(t).toUpperCase().includes(model) && !EBAY_COMMON_EXCLUDE.test(t),
        };
      }
      return undefined;
    case "item":
      // 商品指定は planItemEbaySearch を使う
      return undefined;
  }
}

// ---- 商品指定（1 つの検索条件 = 1 つの商品）----

/** キーワードを単語に分ける（全角・半角や大文字・小文字の違いは無視） */
export function keywordTokens(keyword: string): string[] {
  return normalizeText(keyword).toLowerCase().split(" ").filter(Boolean);
}

/** タイトルにキーワードの単語がすべて含まれるか（楽天・Yahoo!・eBay の検索はあいまいなので、ここで絞る） */
export function containsAllTokens(title: string, tokens: readonly string[]): boolean {
  const t = normalizeText(title).toLowerCase();
  return tokens.every((token) => t.includes(token));
}

/**
 * 状態ごとの eBay コンディション ID。
 * 中古は 1500（開封品）・2750（ほぼ新品）・3000（中古）・4000〜6000（状態の良い順）。7000（ジャンク）は含めない。
 */
export function itemConditionIds(condition: ItemCondition): string[] {
  const used = ["1500", "2750", "3000", "4000", "5000", "6000"];
  if (condition === "new") return ["1000"];
  if (condition === "used") return used;
  return ["1000", ...used];
}

/** 部品取り・動作不良・箱や説明書だけ・まとめ売りなど、本体 1 台の相場にならない出品 */
const EBAY_ITEM_EXCLUDE =
  /\bfor parts\b|\bnot working\b|\bjunk\b|\bbroken\b|\bas[- ]is\b|\b(box|case|manual|cover) only\b|\bempty box\b|\blot\b|\bbundle\b|\breplica\b/i;
/** 本体ではなく部品・付属品の出品によく出る言葉 */
const EBAY_ACCESSORY =
  /\b(drag washers?|washers?|screws?|knobs?|part no|parts only|replacement|repair parts?|power supply|ac adapter|adapter|cables?|decals?|stickers?)\b/i;

/**
 * 商品指定の eBay 検索。JAN があれば JAN（GTIN）で、なければ英語キーワードで探す。
 * キーワード検索のときは、キーワードの単語をすべて含む出品だけを集計する。
 * @returns 先に試す検索と、JAN で見つからなかったときのキーワード検索（なければ undefined）
 */
export function planItemEbaySearch(params: {
  jan?: string;
  ebayKeyword?: string;
  condition: ItemCondition;
}): { primary: EbaySearchPlan; fallback?: EbaySearchPlan } | undefined {
  const conditionIds = itemConditionIds(params.condition);
  const keyword = params.ebayKeyword?.trim();
  const keywordPlan: EbaySearchPlan | undefined = keyword
    ? {
        q: keyword,
        conditionIds,
        webQuery: keyword,
        titleFilter: (t) => containsAllTokens(t, keywordTokens(keyword)) && !EBAY_ITEM_EXCLUDE.test(t) && !EBAY_ACCESSORY.test(t),
      }
    : undefined;
  if (params.jan) {
    const primary: EbaySearchPlan = {
      gtin: params.jan,
      conditionIds,
      webQuery: keyword || params.jan,
      titleFilter: (t) => !EBAY_ITEM_EXCLUDE.test(t) && !EBAY_ACCESSORY.test(t),
    };
    return { primary, fallback: keywordPlan };
  }
  return keywordPlan ? { primary: keywordPlan } : undefined;
}

/** eBay サイトの検索リンク。出品中は即決のみ、落札済みはオークションも含める */
export function ebayWebSearchUrl(query: string, sold: boolean): string {
  const url = new URL("https://www.ebay.com/sch/i.html");
  url.searchParams.set("_nkw", query);
  if (sold) {
    url.searchParams.set("LH_Sold", "1");
    url.searchParams.set("LH_Complete", "1");
  } else {
    url.searchParams.set("LH_BIN", "1");
  }
  return url.toString();
}
