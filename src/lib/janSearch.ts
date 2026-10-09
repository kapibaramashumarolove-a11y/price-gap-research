// キーワード（型番・商品名）検索の結果から JAN ごとにまとめる（「JAN が分からない商品」を探すための補助）。
// 型番が一致する候補を上に、付属品らしい候補（ケース・フィルムなど）は印を付けて下にする。画面・サーバーの両方から使う。

import { extractJans, isValidJan, normalizeText } from "./jan";
import { isMultiUnitListing, isUsedListing } from "./lookup";
import type { Mall } from "./malls";
import type { RawDomesticOffer } from "./rakuten";

export type JanCandidate = {
  jan: string;
  title: string;
  imageUrl?: string;
  minPriceJpy: number;
  /** 見つかった出品数（モールごと） */
  count: number;
  malls: Partial<Record<Mall, number>>;
  /** 検索した型番（英数字を含む単語）が商品名にそのまま入っているか */
  modelMatch: boolean;
  /** 付属品・互換品らしい（ケース・フィルム・互換など。検索語に含まれていない場合だけ） */
  accessory: boolean;
};

/** 付属品・互換品によく使われる言葉 */
const ACCESSORY_PATTERN =
  /ケース|カバー|フィルム|保護|互換|交換用|替え|アダプ[タター]|ケーブル|充電器|充電スタンド|スタンド|ホルダー|ストラップ|スキン|シール|ステッカー|収納|ポーチ|パーツ|部品|対応(?!版)|専用(?!品)|用\s|用$/;

/** 比べるための形（全角→半角・小文字・記号と空白を除く） */
function compact(text: string): string {
  return normalizeText(text).toLowerCase().replace(/[\s\-_/・.()（）［］\[\]]/g, "");
}

/** 検索語のうち型番らしい単語（英字と数字の両方を含む 3 文字以上） */
export function modelTokens(keyword: string): string[] {
  return normalizeText(keyword)
    .split(" ")
    .map(compact)
    .filter((w) => w.length >= 3 && /[a-z]/.test(w) && /\d/.test(w));
}

/**
 * 見つかった出品を JAN ごとにまとめる（JAN のないもの・中古・セット売りは除く）。
 * 並び順: 型番一致 → 付属品でない → 出品の多い順。楽天の出品は JAN の項目がないので、説明文の JAN を使う
 */
export function findJansByKeyword(offers: RawDomesticOffer[], keyword = ""): JanCandidate[] {
  const models = modelTokens(keyword);
  const keywordHasAccessory = ACCESSORY_PATTERN.test(normalizeText(keyword));
  const byJan = new Map<string, JanCandidate>();
  for (const o of offers) {
    const jan = o.jan ?? (o.mall === "rakuten" ? extractJans(o.searchText)[0] : undefined);
    if (!jan || !isValidJan(jan) || isMultiUnitListing(o.title) || isUsedListing(o)) continue;
    const prev = byJan.get(jan);
    if (prev) {
      prev.count++;
      prev.malls[o.mall] = (prev.malls[o.mall] ?? 0) + 1;
      prev.minPriceJpy = Math.min(prev.minPriceJpy, o.priceJpy);
      prev.imageUrl ??= o.imageUrl;
      continue;
    }
    const title = compact(o.title);
    byJan.set(jan, {
      jan,
      title: o.title,
      imageUrl: o.imageUrl,
      minPriceJpy: o.priceJpy,
      count: 1,
      malls: { [o.mall]: 1 },
      modelMatch: models.length > 0 && models.every((m) => title.includes(m)),
      accessory: !keywordHasAccessory && ACCESSORY_PATTERN.test(normalizeText(o.title)),
    });
  }
  return sortCandidates([...byJan.values()]).slice(0, 30);
}

/** 型番一致 → 付属品でない → 出品の多い順 */
export function sortCandidates(list: JanCandidate[]): JanCandidate[] {
  return [...list].sort(
    (a, b) => Number(b.modelMatch) - Number(a.modelMatch) || Number(a.accessory) - Number(b.accessory) || b.count - a.count,
  );
}

/** 楽天・Yahoo! の候補をまとめる（同じ JAN は件数を足す） */
export function mergeCandidates(...lists: JanCandidate[][]): JanCandidate[] {
  const byJan = new Map<string, JanCandidate>();
  for (const c of lists.flat()) {
    const prev = byJan.get(c.jan);
    if (!prev) {
      byJan.set(c.jan, { ...c, malls: { ...c.malls } });
      continue;
    }
    prev.count += c.count;
    prev.minPriceJpy = Math.min(prev.minPriceJpy, c.minPriceJpy);
    prev.imageUrl ??= c.imageUrl;
    prev.modelMatch ||= c.modelMatch;
    prev.accessory &&= c.accessory;
    for (const [m, n] of Object.entries(c.malls)) prev.malls[m as Mall] = (prev.malls[m as Mall] ?? 0) + (n ?? 0);
  }
  return sortCandidates([...byJan.values()]);
}

/** 自動で選ぶならこの候補（型番一致か出品の多い、付属品でないもの）。決められなければ undefined */
export function bestCandidate(list: JanCandidate[]): JanCandidate | undefined {
  const top = sortCandidates(list)[0];
  return top && !top.accessory ? top : undefined;
}
