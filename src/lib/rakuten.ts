// 楽天市場の商品検索 API（新しい API 基盤 openapi.rakuten.co.jp）の呼び出し方と結果の読み取り。
// ブラウザとサーバーの両方から使う（キーは引数で受け取り、このファイルでは環境変数を読まない）。
//
// 楽天の「Webアプリケーション」は、ブラウザから直接呼ぶ前提の仕組み（CORS で全サイトから許可されている）。
// 楽天はリクエストの Origin / Referer をアプリ設定の「許可されたWebサイト」と照合するので、
// ブラウザから呼べば、開いているサイトの URL が自動で正しく送られる。
// https://webservice.rakuten.co.jp/documentation/ichiba-item-search

import { normalizeText } from "./jan";
import type { MallOffer } from "./malls";

// 2022-06-01 版は 2026 年 8 月に停止し、「API Configuration not found」（HTTP 400）を返すようになった。
// 入出力（formatVersion=2）の項目名は変わっていない
export const RAKUTEN_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";
/** 1 回で取れる最大件数 */
export const RAKUTEN_HITS = 30;

/** JAN を確かめるための説明文などを付けた商品データ */
export type RawDomesticOffer = MallOffer & {
  /** JAN を探すときに使う文章（タイトル＋説明文） */
  searchText: string;
  /** API から分かる JAN（Yahoo! のみ） */
  jan?: string;
  /** API で中古と分かる出品（Yahoo! のみ） */
  used?: boolean;
};

export type RakutenSearchParams = {
  /** 検索キーワード（JAN で照合するときは JAN そのもの） */
  keyword: string;
  minPriceJpy?: number;
  maxPriceJpy?: number;
};

export type RakutenCredentials = { appId: string; accessKey: string; affiliateId?: string };

type RakutenItem = {
  itemName?: string;
  itemPrice?: number;
  itemUrl?: string;
  affiliateUrl?: string;
  shopName?: string;
  itemCaption?: string;
  /** 0: 送料込み, 1: 送料別 */
  postageFlag?: number;
  /** ショップのポイント倍率（1 = 通常の 1 倍） */
  pointRate?: number;
  mediumImageUrls?: (string | { imageUrl?: string })[];
};

// ---- 検索キーワードの整形 ----
// 楽天の検索キーワードの決まり（守らないと「keyword is not valid」になる）:
//   - 単語は半角スペース区切り（AND 検索）
//   - 1 つの単語は半角 2 文字以上（全角の漢字などは 1 文字以上、ひらがな・カタカナ・記号は 2 文字以上）
//   - 全体で半角 128 文字まで（全角は 2 文字として数える）

const RAKUTEN_KEYWORD_MAX_WIDTH = 128;

/** 半角は 1、全角は 2 として幅を数える */
function charWidth(ch: string): number {
  return /[\u0020-\u007e\uff61-\uff9f]/.test(ch) ? 1 : 2;
}

/** 1 文字の単語のうち、楽天で使えるもの（ひらがな・カタカナ・記号・半角以外の全角文字＝漢字など） */
function isValidSingleChar(ch: string): boolean {
  return charWidth(ch) === 2 && !/[\u3040-\u30ff\u3000-\u303f\uff01-\uff60]/.test(ch);
}

/**
 * 楽天の決まりに合うように検索キーワードを整える。全角の英数字・スペースは半角にし、
 * 楽天で使えない 1 文字の単語（例: "Nikon F3 W" の "W"）を除き、長すぎるときは後ろの単語から削る。
 * @returns 使える単語が残らなければ空文字
 */
export function rakutenKeyword(raw: string): string {
  const words = normalizeText(raw)
    .split(" ")
    .filter((w) => [...w].length >= 2 || isValidSingleChar(w));
  const kept: string[] = [];
  let width = 0;
  for (const w of words) {
    const add = [...w].reduce((sum, ch) => sum + charWidth(ch), 0) + (kept.length > 0 ? 1 : 0);
    if (width + add > RAKUTEN_KEYWORD_MAX_WIDTH) break;
    kept.push(w);
    width += add;
  }
  return kept.join(" ");
}

/** 検索 URL を作る。アクセスキーは URL に載せず、ヘッダー（accessKey）で送ること */
export function buildRakutenSearchUrl(params: RakutenSearchParams, creds: Pick<RakutenCredentials, "appId" | "affiliateId">): URL {
  const url = new URL(RAKUTEN_URL);
  url.searchParams.set("applicationId", creds.appId);
  if (creds.affiliateId) url.searchParams.set("affiliateId", creds.affiliateId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("keyword", rakutenKeyword(params.keyword));
  url.searchParams.set("hits", String(RAKUTEN_HITS));
  url.searchParams.set("availability", "1");
  url.searchParams.set("imageFlag", "1");
  if (params.minPriceJpy) url.searchParams.set("minPrice", String(params.minPriceJpy));
  if (params.maxPriceJpy) url.searchParams.set("maxPrice", String(params.maxPriceJpy));
  return url;
}

/** 楽天のエラーを、直し方が分かる日本語にする（楽天の「許可されたWebサイト」と見比べられるよう、送った URL も添える） */
export function rakutenErrorMessage(status: number, detail: string, origin: string | undefined): string {
  if (status === 429) return "楽天: アクセスが多すぎます。少し待ってからもう一度試してください。";
  const sent = `［HTTP ${status}・楽天に送ったサイト URL: ${origin ?? "なし"}］`;
  if (/access ?key/i.test(detail)) {
    return `楽天: アクセスキーが正しくありません（${detail}）。RAKUTEN_ACCESS_KEY が、RAKUTEN_APP_ID と同じアプリのアクセスキーか確認してください。${sent}`;
  }
  if (/applicationId/i.test(detail)) {
    return `楽天: アプリ ID が正しくありません（${detail}）。2026 年の新しい楽天ウェブサービスで登録したアプリのアプリケーション ID を RAKUTEN_APP_ID に設定してください。${sent}`;
  }
  if (/API Configuration not found/i.test(detail)) {
    return `楽天: 楽天 API のバージョンが使えなくなっています（${detail}）。アプリの更新が必要です（src/lib/rakuten.ts の RAKUTEN_URL）。${sent}`;
  }
  if (/refer|origin|domain|site/i.test(detail) || status === 403) {
    return `楽天: アクセスが拒否されました（${detail}）。楽天のアプリ設定の「許可されたWebサイト」に ${origin ?? "このサイトの URL"} を登録しているか確認してください。${sent}`;
  }
  return `楽天: 検索に失敗しました（${detail}）。${sent}`;
}

/**
 * 楽天の通常ポイント [円]。楽天のポイントは税抜価格の 1%（× ショップの倍率）。
 * SPU（会員ごとの上乗せ）は人によって違うので、画面の設定（上乗せポイント）で足す
 */
export function rakutenPoints(priceJpy: number, pointRate: number | undefined): number {
  const rate = Number.isFinite(pointRate) && (pointRate ?? 0) > 0 ? pointRate! : 1;
  return Math.floor((Math.floor(priceJpy / 1.1) * rate) / 100);
}

/** 楽天の応答（formatVersion=2 の Items）を商品データにする */
export function parseRakutenItems(items: RakutenItem[]): RawDomesticOffer[] {
  return items.flatMap((item): RawDomesticOffer[] => {
    const price = Number(item.itemPrice);
    if (!item.itemName || !item.itemUrl || !Number.isFinite(price)) return [];
    const image = item.mediumImageUrls?.[0];
    return [
      {
        mall: "rakuten",
        title: normalizeText(item.itemName),
        priceJpy: price,
        shipping: item.postageFlag === 0 ? "free" : item.postageFlag === 1 ? "extra" : "unknown",
        pointsJpy: rakutenPoints(price, Number(item.pointRate)),
        url: item.affiliateUrl || item.itemUrl,
        shopName: item.shopName ?? "",
        imageUrl: (typeof image === "string" ? image : image?.imageUrl) || undefined,
        // JAN を探すための文章。送るデータが大きくなりすぎないよう長さを抑える
        searchText: `${item.itemName} ${item.itemCaption ?? ""}`.slice(0, 5000),
      },
    ];
  });
}

/** 楽天の結果。失敗したときは画面に出すエラーメッセージ */
export type RakutenResult = { offers: RawDomesticOffer[] } | { error: string };

/**
 * 楽天で検索する。
 * @param origin エラーメッセージに添える「楽天に送ったサイト URL」
 * @param headers 追加のヘッダー（サーバーから呼ぶときの Referer / Origin など）
 */
export async function fetchRakuten(
  params: RakutenSearchParams,
  creds: RakutenCredentials,
  origin: string | undefined,
  fetchFn: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<RakutenResult> {
  if (rakutenKeyword(params.keyword) === "") {
    return { error: "楽天: 検索キーワードに楽天で使える単語がありません（1 文字だけの単語は楽天では検索できません）。キーワードを変えてください。" };
  }
  let res: Response;
  try {
    res = await fetchFn(buildRakutenSearchUrl(params, creds), {
      headers: { accessKey: creds.accessKey, ...headers },
      cache: "no-store",
    });
  } catch {
    return { error: "楽天: 接続できませんでした（通信エラー）。電波の良いところでもう一度試してください。" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    Items?: RakutenItem[];
    error?: string;
    error_description?: string;
    errors?: { errorMessage?: string };
  };
  // 0 件のときは 404（not_found）が返る
  if (res.status === 404 && data.error === "not_found") return { offers: [] };
  if (!res.ok) {
    const detail = data.errors?.errorMessage ?? data.error_description ?? `HTTP ${res.status}`;
    return { error: rakutenErrorMessage(res.status, detail, origin) };
  }
  return { offers: parseRakutenItems(data.Items ?? []) };
}

// ---- ブラウザから送られてきた楽天の結果の検査（サーバー側で使う）----

const MAX_CLIENT_OFFERS = RAKUTEN_HITS;

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const s = str(value, 2000);
  return s && /^https:\/\//.test(s) ? s : undefined;
}

/**
 * /api/jan に送られてきた楽天の結果（ブラウザで検索したもの）を検査する。
 * 形がおかしい商品は捨て、件数も上限で切る。送られていなければ undefined（サーバー側で検索する）。
 */
export function parseClientRakuten(value: unknown): RakutenResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { offers?: unknown; error?: unknown };
  if (typeof v.error === "string") return { error: v.error.slice(0, 500) };
  if (!Array.isArray(v.offers)) return undefined;
  const offers = v.offers.slice(0, MAX_CLIENT_OFFERS).flatMap((o): RawDomesticOffer[] => {
    if (typeof o !== "object" || o === null) return [];
    const r = o as Record<string, unknown>;
    const title = str(r.title, 500);
    const url = httpsUrl(r.url);
    const priceJpy = typeof r.priceJpy === "number" && Number.isFinite(r.priceJpy) && r.priceJpy >= 0 ? r.priceJpy : undefined;
    const shipping = r.shipping === "free" || r.shipping === "extra" || r.shipping === "unknown" ? r.shipping : undefined;
    if (!title || !url || priceJpy === undefined || !shipping) return [];
    // ポイントは商品価格を超えない範囲だけ受け付ける
    const pointsJpy =
      typeof r.pointsJpy === "number" && Number.isFinite(r.pointsJpy) && r.pointsJpy >= 0 ? Math.min(Math.floor(r.pointsJpy), priceJpy) : 0;
    return [
      {
        mall: "rakuten",
        title,
        priceJpy,
        shipping,
        pointsJpy,
        url,
        shopName: str(r.shopName, 200) ?? "",
        imageUrl: httpsUrl(r.imageUrl),
        searchText: str(r.searchText, 20000) ?? title,
      },
    ];
  });
  return { offers };
}

// ---- 楽天市場ランキング（売れ筋から探す）----
// https://webservice.rakuten.co.jp/documentation/ichiba-item-ranking
// 検索と同じく、ブラウザから直接呼ぶ（「許可されたWebサイト」の確認のため）。

export const RAKUTEN_RANKING_URL = "https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601";

export type RankingPeriod = "realtime" | "daily";

/** ランキングの商品（何位か付き） */
export type RankedOffer = RawDomesticOffer & { rank: number };

export type RakutenRankingResult = { offers: RankedOffer[] } | { error: string };

export function buildRakutenRankingUrl(
  params: { genreId: string; period: RankingPeriod; page: number },
  creds: Pick<RakutenCredentials, "appId" | "affiliateId">,
): URL {
  const url = new URL(RAKUTEN_RANKING_URL);
  url.searchParams.set("applicationId", creds.appId);
  if (creds.affiliateId) url.searchParams.set("affiliateId", creds.affiliateId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  // ジャンル "0" は総合ランキング（genreId を付けない）
  if (params.genreId !== "0") url.searchParams.set("genreId", params.genreId);
  if (params.period === "realtime") url.searchParams.set("period", "realtime");
  url.searchParams.set("page", String(params.page));
  return url;
}

/** 楽天ランキングを 1 ページ（30 件）取得する */
export async function fetchRakutenRanking(
  params: { genreId: string; period: RankingPeriod; page: number },
  creds: RakutenCredentials,
  origin: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<RakutenRankingResult> {
  let res: Response;
  try {
    res = await fetchFn(buildRakutenRankingUrl(params, creds), { headers: { accessKey: creds.accessKey }, cache: "no-store" });
  } catch {
    return { error: "楽天ランキング: 接続できませんでした（通信エラー）。電波の良いところでもう一度試してください。" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    Items?: (RakutenItem & { rank?: number })[];
    error?: string;
    error_description?: string;
    errors?: { errorMessage?: string };
  };
  if (!res.ok) {
    const detail = data.errors?.errorMessage ?? data.error_description ?? `HTTP ${res.status}`;
    return { error: rakutenErrorMessage(res.status, detail, origin).replace(/^楽天:/, "楽天ランキング:") };
  }
  const items = data.Items ?? [];
  const offers = items.flatMap((item, i): RankedOffer[] => {
    const [offer] = parseRakutenItems([item]);
    return offer ? [{ ...offer, rank: Number(item.rank) || (params.page - 1) * 30 + i + 1 }] : [];
  });
  return { offers };
}


// ---- 全自動リサーチ用: ポイント高倍率の商品（ブラウザから呼ぶ）----
// 楽天の商品検索の pointRateFlag=1・pointRate（2〜10 倍以上）で、ポイント高還元の在庫あり商品を探す。
// 楽天の商品データには JAN の項目がないので、商品名・説明文に JAN が書かれているものだけを使う（呼び出し側で抽出）。
// ※ 楽天スーパーDEAL の商品を取り出す公開 API はないため、ポイント倍率で代用している。

export function buildRakutenHighPointUrl(
  params: { genreId: string; minPointRate: number; page: number },
  creds: Pick<RakutenCredentials, "appId" | "affiliateId">,
): URL {
  const url = new URL(RAKUTEN_URL);
  url.searchParams.set("applicationId", creds.appId);
  if (creds.affiliateId) url.searchParams.set("affiliateId", creds.affiliateId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("genreId", params.genreId);
  url.searchParams.set("pointRateFlag", "1");
  url.searchParams.set("pointRate", String(Math.min(10, Math.max(2, params.minPointRate))));
  url.searchParams.set("availability", "1");
  url.searchParams.set("sort", "-reviewCount");
  url.searchParams.set("hits", String(RAKUTEN_HITS));
  url.searchParams.set("page", String(params.page));
  return url;
}

export async function fetchRakutenHighPoint(
  params: { genreId: string; minPointRate: number; page: number },
  creds: RakutenCredentials,
  origin: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<RakutenResult> {
  let res: Response;
  try {
    res = await fetchFn(buildRakutenHighPointUrl(params, creds), { headers: { accessKey: creds.accessKey }, cache: "no-store" });
  } catch {
    return { error: "楽天: 接続できませんでした（通信エラー）。" };
  }
  const data = (await res.json().catch(() => ({}))) as { Items?: RakutenItem[]; error?: string; error_description?: string; errors?: { errorMessage?: string } };
  if (res.status === 404 && data.error === "not_found") return { offers: [] };
  if (!res.ok) {
    const detail = data.errors?.errorMessage ?? data.error_description ?? `HTTP ${res.status}`;
    return { error: rakutenErrorMessage(res.status, detail, origin) };
  }
  return { offers: parseRakutenItems(data.Items ?? []) };
}
