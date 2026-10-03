// 楽天市場の商品検索 API（新しい API 基盤 openapi.rakuten.co.jp）の呼び出し方と結果の読み取り。
// ブラウザとサーバーの両方から使う（キーは引数で受け取り、このファイルでは環境変数を読まない）。
//
// 楽天の「Webアプリケーション」は、ブラウザから直接呼ぶ前提の仕組み（CORS で全サイトから許可されている）。
// 楽天はリクエストの Origin / Referer をアプリ設定の「許可されたWebサイト」と照合するので、
// ブラウザから呼べば、開いているサイトの URL が自動で正しく送られる。
// https://webservice.rakuten.co.jp/documentation/ichiba-item-search

import { normalizeText } from "./identify";
import type { ItemCondition, ResearchKind, DomesticOffer } from "./researchTypes";

export const RAKUTEN_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601";
/** 1 回で取れる最大件数 */
export const RAKUTEN_HITS = 30;

/** 識別子（JAN）を探すための説明文などを付けた国内の商品データ。画面には返さない */
export type RawDomesticOffer = DomesticOffer & {
  /** 識別子を探すときに使う文章（タイトル＋説明文） */
  searchText: string;
  /** API から分かる JAN（Yahoo! のみ） */
  jan?: string;
};

export type RakutenSearchParams = {
  kind: ResearchKind;
  keyword: string;
  minPriceJpy?: number;
  maxPriceJpy?: number;
  jan?: string;
  condition?: ItemCondition;
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
  mediumImageUrls?: (string | { imageUrl?: string })[];
};

/** 検索 URL を作る。アクセスキーは URL に載せず、ヘッダー（accessKey）で送ること */
export function buildRakutenSearchUrl(params: RakutenSearchParams, creds: Pick<RakutenCredentials, "appId" | "affiliateId">): URL {
  const url = new URL(RAKUTEN_URL);
  url.searchParams.set("applicationId", creds.appId);
  if (creds.affiliateId) url.searchParams.set("affiliateId", creds.affiliateId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("keyword", params.keyword || params.jan || "");
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
  if (/refer|origin|domain|site/i.test(detail) || status === 403) {
    return `楽天: アクセスが拒否されました（${detail}）。楽天のアプリ設定の「許可されたWebサイト」に ${origin ?? "このサイトの URL"} を登録しているか確認してください。${sent}`;
  }
  return `楽天: 検索に失敗しました（${detail}）。${sent}`;
}

/** 楽天の応答（formatVersion=2 の Items）を商品データにする */
export function parseRakutenItems(items: RakutenItem[]): RawDomesticOffer[] {
  return items.flatMap((item): RawDomesticOffer[] => {
    const price = Number(item.itemPrice);
    if (!item.itemName || !item.itemUrl || !Number.isFinite(price)) return [];
    const image = item.mediumImageUrls?.[0];
    return [
      {
        source: "rakuten",
        title: normalizeText(item.itemName),
        priceJpy: price,
        shipping: item.postageFlag === 0 ? "free" : item.postageFlag === 1 ? "extra" : "unknown",
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
 * /api/research に送られてきた楽天の結果（ブラウザで検索したもの）を検査する。
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
    return [
      {
        source: "rakuten",
        title,
        priceJpy,
        shipping,
        url,
        shopName: str(r.shopName, 200) ?? "",
        imageUrl: httpsUrl(r.imageUrl),
        searchText: str(r.searchText, 20000) ?? title,
      },
    ];
  });
  return { offers };
}
