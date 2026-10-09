"use client";

// 電脳せどりのリサーチ画面（楽天市場・Yahoo!ショッピング）。
// 登録した JAN を 1 つずつ楽天・Yahoo! で調べ、ポイント・送料込みの最安仕入れ値と、楽天 ⇄ Yahoo! の価格差を表示する。
// Amazon は API を使わず、利用者が Keepa で確認する（Amazon・Keepa へのリンクと、販売価格の入力欄を出す）。
// JAN の一覧・計算の前提・最後の結果はブラウザの localStorage に保存する。

import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeJan, bestBuyOption, type Analysis, type Route } from "@/lib/arbitrage";
import { loadJson, saveJson } from "@/lib/browserStorage";
import {
  DISCOVERY_CATEGORIES,
  DISCOVERY_LIMITS,
  DISCOVERY_SOURCES,
  RAKUTEN_MIN_POINT_RATE,
  type DiscoveryCategory,
  type DiscoverySource,
} from "@/lib/discovery";
import { containsJan, extractJans, normalizeJan } from "@/lib/jan";
import { decodeCsvBytes, janListToCsv, mergeJanItems, parseJanList, type JanItem, type JanListParseResult } from "@/lib/janList";
import { bestCandidate, findJansByKeyword, mergeCandidates, type JanCandidate } from "@/lib/janSearch";
import { decodeJanFromImage, loadImage, toUploadDataUrl } from "@/lib/photoClient";
import {
  DEFAULT_ARBITRAGE_SETTINGS,
  MALL_LABEL,
  MALLS,
  SELL_LABEL,
  type ArbitrageSettings,
  type JanLookup,
  type Mall,
  type MallOffer,
} from "@/lib/malls";
import { fetchRakuten, fetchRakutenHighPoint, fetchRakutenRanking, type RakutenCredentials, type RakutenResult } from "@/lib/rakuten";
import { INPUT_CLASS } from "./Fields";

const ITEMS_KEY = "price-gap:jan-items";
const SETTINGS_KEY = "price-gap:arbitrage-settings";
const RESULTS_KEY = "price-gap:jan-results";
const ONLY_TREASURES_KEY = "price-gap:only-treasures";
const MODE_KEY = "price-gap:mode";
const VIEW_KEY = "price-gap:result-view";
const BULK_KEY = "price-gap:bulk-options";

type Mode = "single" | "bulk";
type SortKey = "profit" | "margin" | "price";
type ResultView = { sort: SortKey; minProfitJpy: number };
const DEFAULT_VIEW: ResultView = { sort: "profit", minProfitJpy: 0 };
const MIN_PROFIT_FILTERS = [0, 1000, 3000, 5000];

type BulkOptions = { sources: DiscoverySource[]; category: DiscoveryCategory; limit: number };
const DEFAULT_BULK: BulkOptions = { sources: ["rakuten", "yahoo"], category: "all", limit: 20 };
/** 途中で止まったリサーチの続き（画面を閉じても、開き直すと再開できるように保存） */
const QUEUE_KEY = "price-gap:research-queue";
const SKIP_RECENT_KEY = "price-gap:skip-recent";
/** 仕入れ先として調べるモール（Amazon は API を使わないので仕入れ先にしない） */
const BUY_MALLS: Mall[] = ["rakuten", "yahoo"];
const AMAZON_PRICES_KEY = "price-gap:amazon-prices";

/** 楽天・Yahoo! の中で、ポイント・送料込みの実質価格が一番安い仕入れ値（出品がなければ Infinity） */
function cheapestNet(lookup: JanLookup, settings: ArbitrageSettings): number {
  const nets = BUY_MALLS.map((m) => bestBuyOption(lookup.offers[m], settings)?.netJpy).filter((n): n is number => n !== undefined);
  return nets.length > 0 ? Math.min(...nets) : Infinity;
}

/** Amazon で JAN を検索する URL（API は使わず、利用者が自分で確認する） */
function amazonSearchUrl(jan: string): string {
  return `https://www.amazon.co.jp/s?k=${encodeURIComponent(jan)}`;
}

/** Keepa で JAN を検索する URL（5 = Amazon.co.jp） */
function keepaSearchUrl(jan: string): string {
  return `https://keepa.com/#!search/5-${encodeURIComponent(jan)}`;
}

/**
 * 計算に使う Amazon のデータを、手入力の販売価格だけにする（API の Amazon データは使わない。
 * 以前 Keepa で調べた結果が残っていても無視する）。販売価格がなければ Amazon は計算に入れない
 */
function withManualAmazon(lookup: JanLookup, priceJpy: number | undefined): JanLookup {
  return {
    ...lookup,
    offers: { ...lookup.offers, amazon: [] },
    amazon: priceJpy && priceJpy > 0 ? { asin: "", title: lookup.title, url: amazonSearchUrl(lookup.jan), buyBoxPriceJpy: priceJpy } : undefined,
  };
}
/** 「最近調べた商品は飛ばす」の期間 [時間] */
const RECENT_HOURS = 6;
type Queue = { jans: string[]; next: number; savedAt: string };

/** 調べている間、画面が自動で消えないようにする（Screen Wake Lock。対応していないブラウザでは何もしない） */
function keepScreenOn(): () => void {
  type Sentinel = { release: () => Promise<void> };
  const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<Sentinel> } };
  if (!nav.wakeLock) return () => {};
  let sentinel: Sentinel | undefined;
  let active = true;
  const acquire = () => {
    if (active && document.visibilityState === "visible") {
      nav.wakeLock!.request("screen").then((s) => (sentinel = s)).catch(() => {});
    }
  };
  // 別のアプリから戻ってきたら取り直す（iPhone はアプリを切り替えると解除される）
  document.addEventListener("visibilitychange", acquire);
  acquire();
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", acquire);
    sentinel?.release().catch(() => {});
  };
}

/** 楽天の API は 1 秒に 1 回までなので、JAN と JAN の間を空ける [ミリ秒] */
const MIN_GAP_MS = 1100;
/** 一覧で最初に表示する JAN の数 */
const ITEM_PREVIEW_COUNT = 8;

/** 楽天ランキングのジャンル（楽天のジャンル ID） */
const RANKING_GENRES: { id: string; label: string }[] = [
  { id: "0", label: "総合" },
  { id: "101205", label: "テレビゲーム" },
  { id: "566382", label: "おもちゃ" },
  { id: "101164", label: "ホビー" },
  { id: "211742", label: "TV・オーディオ・カメラ" },
  { id: "562637", label: "家電" },
  { id: "100026", label: "パソコン・周辺機器" },
  { id: "100939", label: "美容・コスメ・香水" },
  { id: "100227", label: "食品" },
  { id: "100316", label: "水・ソフトドリンク" },
  { id: "215783", label: "日用品雑貨・文房具・手芸" },
  { id: "100533", label: "キッズ・ベビー・マタニティ" },
];

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });


const BUTTON = "flex min-h-12 items-center justify-center rounded-lg px-3 text-center text-sm active:opacity-70 disabled:opacity-40";
const PRIMARY = `${BUTTON} bg-foreground text-base font-medium text-background`;
const SECONDARY = `${BUTTON} border border-black/25 dark:border-white/30`;

function loadSettings(): ArbitrageSettings {
  const d = DEFAULT_ARBITRAGE_SETTINGS;
  const saved = loadJson<Partial<ArbitrageSettings>>(SETTINGS_KEY) ?? {};
  return {
    ...d,
    ...saved,
    // 回転率は Keepa で手動確認するので、推奨の条件には使わない（以前の設定が残っていても外す）
    minRank: "none",
    extraPointPercent: { ...d.extraPointPercent, ...saved.extraPointPercent },
    sell: {
      amazon: { ...d.sell.amazon, ...saved.sell?.amazon },
      rakuten: { ...d.sell.rakuten, ...saved.sell?.rakuten },
      yahoo: { ...d.sell.yahoo, ...saved.sell?.yahoo },
    },
  };
}

/** 文字列をファイルとしてダウンロードさせる（Excel で文字化けしないよう BOM を付ける） */
function downloadCsv(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Row = { item: JanItem; lookup: JanLookup; analysis: Analysis };

export default function ArbitrageDashboard() {
  const [items, setItems] = useState<JanItem[]>(() => loadJson<JanItem[]>(ITEMS_KEY) ?? []);
  const [settings, setSettings] = useState<ArbitrageSettings>(loadSettings);
  const [results, setResults] = useState<Record<string, JanLookup>>(() => loadJson(RESULTS_KEY) ?? {});
  const [onlyTreasures, setOnlyTreasures] = useState<boolean>(() => loadJson<boolean>(ONLY_TREASURES_KEY) ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<{ jan: string; index: number; total: number; jans: string[]; note?: string } | null>(null);
  const [mode, setMode] = useState<Mode>(() => loadJson<Mode>(MODE_KEY) ?? "single");
  const [view, setView] = useState<ResultView>(() => ({ ...DEFAULT_VIEW, ...loadJson<Partial<ResultView>>(VIEW_KEY) }));
  /** 最後の全自動リサーチで調べた JAN（結果を「今回の分だけ」に絞るため） */
  const [lastBulkJans, setLastBulkJans] = useState<string[]>([]);
  const [onlyLastBulk, setOnlyLastBulk] = useState(false);
  const [skipRecent, setSkipRecent] = useState<boolean>(() => loadJson<boolean>(SKIP_RECENT_KEY) ?? true);
  /** 前回途中で止まったリサーチ（画面を閉じた・電波が切れたなど） */
  const [pendingQueue, setPendingQueue] = useState<Queue | null>(() => {
    const q = loadJson<Queue>(QUEUE_KEY);
    return q && Array.isArray(q.jans) && q.next < q.jans.length ? q : null;
  });
  const [runNotice, setRunNotice] = useState("");
  /** Keepa で確認した Amazon の販売価格（JAN ごと・手入力。入れると「→ Amazon FBA 販売」の利益も出す） */
  const [amazonPrices, setAmazonPrices] = useState<Record<string, number>>(() => loadJson(AMAZON_PRICES_KEY) ?? {});
  const [showAllItems, setShowAllItems] = useState(false);
  const stopRequested = useRef(false);
  const rakutenCredentials = useRef<Promise<RakutenCredentials | null> | null>(null);

  useEffect(() => saveJson(ITEMS_KEY, items), [items]);
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings]);
  useEffect(() => saveJson(RESULTS_KEY, results), [results]);
  useEffect(() => saveJson(ONLY_TREASURES_KEY, onlyTreasures), [onlyTreasures]);
  useEffect(() => saveJson(MODE_KEY, mode), [mode]);
  useEffect(() => saveJson(VIEW_KEY, view), [view]);
  useEffect(() => saveJson(SKIP_RECENT_KEY, skipRecent), [skipRecent]);
  useEffect(() => saveJson(AMAZON_PRICES_KEY, amazonPrices), [amazonPrices]);

  // 調べた JAN ごとに、今の設定で全ルートを計算し、一番利益の大きいルートの順に並べる
  const rows = useMemo(() => {
    const list: Row[] = items.flatMap((item) => {
      const lookup = results[item.jan];
      if (!lookup) return [];
      const withAmazon = withManualAmazon(lookup, amazonPrices[item.jan]);
      return [{ item, lookup: withAmazon, analysis: analyzeJan(withAmazon, settings) }];
    });
    const profit = (r: Row) => r.analysis.best?.profitJpy ?? -Infinity;
    const key: Record<SortKey, (r: Row) => number> = {
      profit,
      margin: (r) => r.analysis.best?.marginPercent ?? -Infinity,
      // 仕入れ値（ポイント・送料込みの実質価格）の安い順
      price: (r) => -cheapestNet(r.lookup, settings),
    };
    return list.sort((a, b) => key[view.sort](b) - key[view.sort](a));
  }, [items, results, settings, view.sort, amazonPrices]);
  const treasureCount = rows.filter((r) => r.analysis.best?.isTreasure).length;
  const lastBulkSet = new Set(lastBulkJans);
  const visibleRows = rows.filter((r) => {
    const best = r.analysis.best;
    if (onlyTreasures && !best?.isTreasure) return false;
    if (view.minProfitJpy > 0 && (best?.profitJpy ?? -Infinity) < view.minProfitJpy) return false;
    if (onlyLastBulk && lastBulkSet.size > 0 && !lastBulkSet.has(r.item.jan)) return false;
    return true;
  });
  // 実行中のリサーチで見つかった利益商品（推奨ルートの条件を満たすもの）の数
  const foundInRun = running ? rows.filter((r) => running.jans.includes(r.item.jan) && r.analysis.best?.isTreasure).length : 0;

  /** 楽天のキー（ログイン済みのときだけサーバーから受け取る。未設定なら null）。1 回だけ取りに行く */
  function loadRakutenCredentials(): Promise<RakutenCredentials | null> {
    rakutenCredentials.current ??= fetch("/api/rakuten/credentials", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body?.configured ? { appId: body.appId, accessKey: body.accessKey, affiliateId: body.affiliateId } : null))
      .catch(() => null);
    return rakutenCredentials.current;
  }

  /** 1 つの JAN を楽天・Yahoo! で調べる */
  async function lookup(jan: string): Promise<void> {
    setErrors((prev) => ({ ...prev, [jan]: "" }));
    try {
      // 楽天はブラウザから直接検索する（楽天が「許可されたWebサイト」をブラウザの送る URL で確認するため）。
      // 送る量を減らすため、JAN が書かれている商品だけを送る（サーバーでも同じ確認をする）
      const creds = await loadRakutenCredentials();
      let rakuten: RakutenResult | undefined = creds ? await fetchRakuten({ keyword: jan }, creds, window.location.origin) : undefined;
      if (rakuten && "offers" in rakuten) rakuten = { offers: rakuten.offers.filter((o) => containsJan(o.searchText, jan)) };
      const res = await fetch("/api/jan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jan, rakuten }),
      });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [jan]: body.error ?? `取得に失敗しました（HTTP ${res.status}）。` }));
        return;
      }
      setResults((prev) => ({ ...prev, [jan]: body as JanLookup }));
    } catch {
      setErrors((prev) => ({ ...prev, [jan]: "サーバーに接続できませんでした。" }));
    }
  }

  /** JAN を 1 件ずつ順番に調べる（バッチ処理）。楽天の 1 秒 1 回の制限のため間を空ける（中止ボタンで止められる） */
  async function runAll(all: string[], options: { skipRecent?: boolean } = {}) {
    // まとめて調べるときは、最近調べた商品を飛ばす（「調べる」「調べ直す」は必ず調べる）
    const recentMs = RECENT_HOURS * 60 * 60 * 1000;
    const jans =
      options.skipRecent && skipRecent
        ? all.filter((jan) => {
            const fetched = results[jan]?.fetchedAt;
            return !fetched || Date.now() - new Date(fetched).getTime() > recentMs;
          })
        : all;
    const skipped = all.length - jans.length;
    setRunNotice(skipped > 0 ? `${skipped} 件は ${RECENT_HOURS} 時間以内に調べ済みのため飛ばしました。` : "");
    if (jans.length === 0) return;

    stopRequested.current = false;
    setPendingQueue(null);
    const releaseScreen = keepScreenOn();
    for (const [index, jan] of jans.entries()) {
      // 「中止」が押されたら、今の JAN が終わったところで止める
      if (stopRequested.current) break;
      // 画面を閉じても、開き直したときに続きから再開できるよう、どこまで進んだかを保存する
      saveJson(QUEUE_KEY, { jans, next: index, savedAt: new Date().toISOString() } satisfies Queue);
      setRunning({ jan, index: index + 1, total: jans.length, jans });
      const started = Date.now();
      await lookup(jan);
      const rest = MIN_GAP_MS - (Date.now() - started);
      if (rest > 0 && index < jans.length - 1) await wait(rest);
    }
    // 最後まで終わったか、自分で中止したときは続きを残さない
    saveJson(QUEUE_KEY, null);
    releaseScreen();
    setRunning(null);
    // 1 件だけ調べたときは、その結果までスクロールする
    if (jans.length === 1) {
      setTimeout(() => document.getElementById(`jan-${jans[0]}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    }
  }

  /** 全自動リサーチで集めた商品を一覧に足し、まとめて調べる */
  async function runBulk(found: JanItem[]) {
    addItems(found);
    const jans = found.map((i) => i.jan);
    setLastBulkJans(jans);
    setOnlyLastBulk(true);
    await runAll(jans, { skipRecent: true });
  }

  function addItems(added: JanItem[]) {
    setItems((prev) => mergeJanItems(prev, added));
  }

  function removeItem(jan: string) {
    setItems((prev) => prev.filter((i) => i.jan !== jan));
    setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== jan)));
  }

  function clearItems() {
    if (!window.confirm(`登録した JAN ${items.length} 件と結果をすべて削除しますか？`)) return;
    setItems([]);
    setResults({});
  }

  const busy = running !== null;
  const listedItems = showAllItems ? items : items.slice(0, ITEM_PREVIEW_COUNT);
  // 同じ注意はまとめて、何件の JAN で出たかを添える
  const allWarnings = [
    ...rows
      .flatMap((r) => r.lookup.warnings)
      .reduce((map, w) => map.set(w, (map.get(w) ?? 0) + 1), new Map<string, number>()),
  ];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 pt-2 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:pt-4">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">電脳せどり リサーチ（楽天・Yahoo!）</h1>
          <form method="post" action="/api/logout" className="shrink-0">
            <button type="submit" className="min-h-11 px-2 text-sm underline opacity-70 active:opacity-100">
              ログアウト
            </button>
          </form>
        </div>
        <p className="text-sm opacity-80">
          楽天・Yahoo! の最安仕入れ値（ポイント・送料込み）を JAN で照合して調べます。Amazon は各商品の「Keepa で見る」で確認できます。
        </p>
        <ConnectionStatus />
      </header>

      {/* リサーチモードの切り替え */}
      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-lg bg-black/[.06] p-1 dark:bg-white/[.08]">
        {(
          [
            ["single", "検索（JAN・型番・写真）"],
            ["bulk", "全自動バルクリサーチ"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={`min-h-11 rounded-md px-2 text-sm font-medium ${mode === id ? "bg-background shadow" : "opacity-70"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "single" ? (
        <>
          <QuickSearch
            loadRakutenCredentials={loadRakutenCredentials}
            busy={busy}
            onResearch={(found) => {
              addItems(found);
              void runAll(found.map((i) => i.jan));
            }}
          />
          <AddJans
            onAdd={addItems}
            onAddAndRun={(added) => {
              addItems(added);
              void runAll(added.map((i) => i.jan));
            }}
            busy={busy}
          />
          <Discover existing={items} onAdd={addItems} loadRakutenCredentials={loadRakutenCredentials} busy={busy} />
        </>
      ) : (
        <BulkResearch
          loadRakutenCredentials={loadRakutenCredentials}
          onStart={runBulk}
          busy={busy}
        />
      )}

      {pendingQueue && !running && (
        <div className="space-y-2 rounded-lg border-2 border-amber-500/70 p-3 text-sm" role="status">
          <p>
            前回のリサーチが途中で止まっています（{pendingQueue.jans.length} 件中 {pendingQueue.next} 件まで完了・残り{" "}
            {pendingQueue.jans.length - pendingQueue.next} 件）。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => void runAll(pendingQueue.jans.slice(pendingQueue.next))} className={PRIMARY}>
              続きから再開
            </button>
            <button
              type="button"
              onClick={() => {
                saveJson(QUEUE_KEY, null);
                setPendingQueue(null);
              }}
              className={SECONDARY}
            >
              やめる
            </button>
          </div>
        </div>
      )}

      {running && <RunProgress running={running} found={foundInRun} onStop={() => (stopRequested.current = true)} />}
      {runNotice && !running && <p className="text-xs opacity-70">{runNotice}</p>}

      {/* 登録した JAN */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">調べる JAN（{items.length}件）</h2>
          {items.length > 0 && (
            <div className="flex gap-3 text-sm">
              <button
                type="button"
                onClick={() => downloadCsv(`jan-list-${new Date().toISOString().slice(0, 10)}.csv`, janListToCsv(items))}
                className="min-h-11 underline opacity-70"
              >
                CSV に書き出す
              </button>
              <button type="button" onClick={clearItems} disabled={busy} className="min-h-11 text-red-600 underline opacity-80 disabled:opacity-40">
                すべて削除
              </button>
            </div>
          )}
        </div>
        {items.length === 0 ? (
          <p className="text-sm opacity-70">「単体JAN検索」で登録するか、「全自動バルクリサーチ」で自動で集めてください。</p>
        ) : (
          <>
            <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
              {listedItems.map((item) => (
                <li key={item.jan} className="flex items-center gap-2 px-3 py-1">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{item.name || results[item.jan]?.title || "（名前なし）"}</div>
                    <div className="font-mono text-xs opacity-60">
                      {item.jan}
                      {results[item.jan] && ` ・ ${dateTime.format(new Date(results[item.jan].fetchedAt))} に調査`}
                    </div>
                    {errors[item.jan] && <div className="text-xs text-red-600">{errors[item.jan]}</div>}
                  </div>
                  <button type="button" onClick={() => void runAll([item.jan])} disabled={busy} className="min-h-11 px-2 text-sm underline disabled:opacity-40">
                    調べる
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(item.jan)}
                    disabled={busy}
                    aria-label={`${item.jan} を削除`}
                    className="min-h-11 min-w-11 text-lg opacity-60 disabled:opacity-30"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {items.length > ITEM_PREVIEW_COUNT && (
              <button type="button" onClick={() => setShowAllItems((v) => !v)} className="min-h-11 text-sm underline opacity-70">
                {showAllItems ? "閉じる" : `残り ${items.length - ITEM_PREVIEW_COUNT} 件を表示`}
              </button>
            )}
            {!busy && (
              <button
                type="button"
                onClick={() => void runAll(items.map((i) => i.jan), { skipRecent: true })}
                className={`${PRIMARY} w-full sm:w-auto sm:px-8`}
              >
                すべて調べる（{items.length}件）
              </button>
            )}
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={skipRecent} onChange={(e) => setSkipRecent(e.target.checked)} className="h-5 w-5" />
              {RECENT_HOURS} 時間以内に調べた商品は飛ばす
            </label>
            <p className="text-xs opacity-60">
              スマホのブラウザの中で 1 件ずつ調べます。画面を閉じる・別のアプリに切り替えると止まりますが、開き直すと「続きから再開」できます。
              調べている間は画面が自動で消えないようにしています。
            </p>
          </>
        )}
      </section>

      <SettingsPanel settings={settings} onChange={setSettings} />

      {/* 結果 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">
            結果{" "}
            <span className="text-sm font-normal opacity-70">
              表示 {visibleRows.length} 件 ／ 推奨 {treasureCount} 件 ／ 調査済み {rows.length} 件
            </span>
          </h2>
        </div>

        {/* 並び替え・絞り込み */}
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs opacity-70">並び替え</span>
            <select value={view.sort} onChange={(e) => setView({ ...view, sort: e.target.value as SortKey })} className={INPUT_CLASS}>
              <option value="profit">見込み利益順</option>
              <option value="margin">利益率順</option>
              <option value="price">仕入れ値の安い順</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs opacity-70">見込み利益</span>
            <select value={view.minProfitJpy} onChange={(e) => setView({ ...view, minProfitJpy: Number(e.target.value) })} className={INPUT_CLASS}>
              {MIN_PROFIT_FILTERS.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "すべて" : `${yen.format(v)}以上のみ`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={onlyTreasures} onChange={(e) => setOnlyTreasures(e.target.checked)} className="h-5 w-5" />
            推奨条件クリアのみ
          </label>
          {lastBulkJans.length > 0 && (
            <label className="col-span-2 flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={onlyLastBulk} onChange={(e) => setOnlyLastBulk(e.target.checked)} className="h-5 w-5" />
              今回の全自動リサーチ分（{lastBulkJans.length}件）だけ
            </label>
          )}
        </div>

        {allWarnings.length > 0 && (
          <details className="rounded-lg border border-amber-500/50 p-3 text-xs text-amber-800 dark:text-amber-300">
            <summary className="flex min-h-8 cursor-pointer items-center">注意 {allWarnings.length} 件</summary>
            <ul className="mt-1 space-y-1">
              {allWarnings.map(([w, count]) => (
                <li key={w}>
                  ⚠ {w}
                  {count > 1 && <span className="opacity-70">（{count} 件）</span>}
                </li>
              ))}
            </ul>
          </details>
        )}

        {visibleRows.length === 0 ? (
          <p className="text-sm opacity-70">
            {rows.length === 0 ? "まだ調べていません。" : "絞り込みに合う商品はありません（絞り込みを外すとすべて表示します）。"}
          </p>
        ) : (
          <>
          <RouteSummary rows={visibleRows} />
          <ul className="space-y-4">
            {visibleRows.map((row) => (
              <ResultCard
                key={row.item.jan}
                row={row}
                settings={settings}
                onRefresh={() => void runAll([row.item.jan])}
                busy={busy}
                amazonPrice={amazonPrices[row.item.jan]}
                onAmazonPrice={(price) =>
                  setAmazonPrices((prev) => {
                    const next = { ...prev };
                    if (price) next[row.item.jan] = price;
                    else delete next[row.item.jan];
                    return next;
                  })
                }
              />
            ))}
          </ul>
          </>
        )}
      </section>
    </main>
  );
}

// ---- 接続状況（API キーが設定されているか。値は扱わない） ----

type ConfigStatus = { rakuten: boolean; yahoo: boolean; photoAi?: boolean };

function ConnectionStatus() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  useEffect(() => {
    fetch("/api/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  if (!status) return null;

  const items: [string, boolean][] = [
    ["楽天", status.rakuten],
    ["Yahoo!", status.yahoo],
  ];
  return (
    <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
      {items.map(([label, ok]) => (
        <span key={label} className={`rounded-full px-2 py-0.5 font-medium ${ok ? "bg-green-600/15 text-green-800 dark:text-green-300" : "bg-red-600/15 text-red-700 dark:text-red-300"}`}>
          {ok ? "✓" : "✕"} {label}: {ok ? "OK" : "未設定"}
        </span>
      ))}
      <span className={`rounded-full px-2 py-0.5 ${status.photoAi ? "bg-green-600/15 font-medium text-green-800 dark:text-green-300" : "opacity-60"}`}>
        {status.photoAi ? "✓ 写真AI: OK" : "写真AI: 未設定（バーコードは読めます）"}
      </span>
      <span className="rounded-full px-2 py-0.5 opacity-60">Amazon: Keepa で手動確認</span>
    </div>
  );
}

// ---- 進捗 ----

function RunProgress({
  running,
  found,
  onStop,
}: {
  running: { jan: string; index: number; total: number; note?: string };
  found: number;
  onStop: () => void;
}) {
  const percent = Math.round(((running.index - 1) / running.total) * 100);
  return (
    <div className="sticky top-0 z-10 space-y-2 rounded-lg border border-black/15 bg-background p-3 shadow dark:border-white/20" role="status">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-semibold">
            {running.index}/{running.total} 件処理中…（利益商品 {found} 件発見）
          </div>
          <div className={`text-xs ${running.note ? "font-semibold text-amber-700 dark:text-amber-400" : "truncate opacity-70"}`}>
            {running.note ?? (
              <>
                調査中: <span className="font-mono">{running.jan}</span>
              </>
            )}
          </div>
        </div>
        <button type="button" onClick={onStop} className={SECONDARY}>
          中止
        </button>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
        <div className="h-full rounded-full bg-green-600 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="text-xs opacity-60">画面を閉じると止まります（開き直すと続きから再開できます）。</div>
    </div>
  );
}

// ---- 全自動バルクリサーチ（起点の商品を自動で集める） ----

function BulkResearch({
  loadRakutenCredentials,
  onStart,
  busy,
}: {
  loadRakutenCredentials: () => Promise<RakutenCredentials | null>;
  onStart: (found: JanItem[]) => Promise<void>;
  busy: boolean;
}) {
  const [options, setOptions] = useState<BulkOptions>(() => {
    const saved = { ...DEFAULT_BULK, ...loadJson<Partial<BulkOptions>>(BULK_KEY) };
    // 以前の「Keepa条件抽出」は廃止したので外す
    const sources = saved.sources.filter((s) => DISCOVERY_SOURCES.some((d) => d.id === s));
    return { ...saved, sources: sources.length > 0 ? sources : DEFAULT_BULK.sources };
  });
  const [log, setLog] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  useEffect(() => saveJson(BULK_KEY, options), [options]);

  const toggleSource = (id: DiscoverySource) =>
    setOptions((prev) => ({ ...prev, sources: prev.sources.includes(id) ? prev.sources.filter((s) => s !== id) : [...prev.sources, id] }));

  /** 楽天のポイント高倍率の商品から、説明文に JAN がある商品を集める（ブラウザから呼ぶ） */
  async function collectRakuten(limit: number): Promise<{ items: JanItem[]; message: string }> {
    const creds = await loadRakutenCredentials();
    if (!creds) return { items: [], message: "楽天: RAKUTEN_APP_ID・RAKUTEN_ACCESS_KEY が設定されていません。" };
    const genreId = DISCOVERY_CATEGORIES.find((c) => c.id === options.category)?.rakutenGenreId ?? "0";
    const items: JanItem[] = [];
    let checked = 0;
    // 1 ページ 30 件。JAN が書かれている商品は一部なので、最大 5 ページ（1 秒あける）
    for (let page = 1; page <= 5 && items.length < limit; page++) {
      if (page > 1) await wait(MIN_GAP_MS);
      const result = await fetchRakutenHighPoint({ genreId, minPointRate: RAKUTEN_MIN_POINT_RATE, page }, creds, window.location.origin);
      if ("error" in result) return { items, message: result.error };
      checked += result.offers.length;
      for (const o of result.offers) {
        const jan = extractJans(o.searchText)[0];
        if (jan && !items.some((i) => i.jan === jan)) items.push({ jan, name: o.title.slice(0, 60) });
        if (items.length >= limit) break;
      }
      if (result.offers.length < 30) break;
    }
    return { items, message: `楽天 高ポイント: ${checked} 件のうち JAN が分かる商品 ${items.length} 件` };
  }

  async function collectYahoo(limit: number): Promise<{ items: JanItem[]; message: string }> {
    const label = "Yahoo!ランキング";
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "yahoo", category: options.category, limit }),
      });
      if (res.status === 401) {
        window.location.reload();
        return { items: [], message: "" };
      }
      const body = await res.json();
      if (!res.ok) return { items: [], message: body.error ?? `${label}: 取得に失敗しました（HTTP ${res.status}）。` };
      const items = (body.items as { jan: string; title: string }[]).map((i) => ({ jan: i.jan, name: i.title.slice(0, 60) }));
      const extra = body.warnings as string[];
      return { items, message: `${label}: ${items.length} 件${extra.length > 0 ? `（${extra.join("・")}）` : ""}` };
    } catch {
      return { items: [], message: `${label}: サーバーに接続できませんでした。` };
    }
  }

  async function start() {
    if (options.sources.length === 0) return;
    setCollecting(true);
    setLog([]);
    // 件数はソースごとに等分（合計が「取得件数」になるように）
    const per = Math.ceil(options.limit / options.sources.length);
    const found: JanItem[] = [];
    for (const source of DISCOVERY_SOURCES.map((s) => s.id).filter((id) => options.sources.includes(id))) {
      const { items, message } = source === "rakuten" ? await collectRakuten(per) : await collectYahoo(per);
      if (message) setLog((prev) => [...prev, message]);
      for (const item of items) if (!found.some((f) => f.jan === item.jan)) found.push(item);
    }
    setCollecting(false);
    const targets = found.slice(0, options.limit);
    if (targets.length === 0) {
      setLog((prev) => [...prev, "調べる商品が見つかりませんでした。カテゴリやソースを変えてください。"]);
      return;
    }
    setLog((prev) => [...prev, `合計 ${targets.length} 件を楽天・Yahoo! で比較します。`]);
    await onStart(targets);
  }

  return (
    <section className="space-y-4 rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div>
        <h2 className="font-semibold">全自動バルクリサーチ</h2>
        <p className="text-xs opacity-70">型番・JAN の入力は不要です。条件に合う商品を自動で集め、JAN で楽天・Yahoo! を一括比較します。</p>
      </div>

      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-semibold">対象ソース</legend>
        {DISCOVERY_SOURCES.map((s) => (
          <label key={s.id} className="flex min-h-11 items-start gap-2 py-1 text-sm">
            <input type="checkbox" checked={options.sources.includes(s.id)} onChange={() => toggleSource(s.id)} className="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              {s.label}
              <span className="block text-xs opacity-60">{s.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span>対象カテゴリ</span>
          <select
            value={options.category}
            onChange={(e) => setOptions({ ...options, category: e.target.value as DiscoveryCategory })}
            className={INPUT_CLASS}
          >
            {DISCOVERY_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span>取得件数</span>
          <select value={options.limit} onChange={(e) => setOptions({ ...options, limit: Number(e.target.value) })} className={INPUT_CLASS}>
            {DISCOVERY_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n} 件
              </option>
            ))}
          </select>
        </label>
      </div>

      <button type="button" onClick={() => void start()} disabled={busy || collecting || options.sources.length === 0} className={`${PRIMARY} w-full`}>
        {collecting ? "商品を集めています…" : "全自動リサーチ開始"}
      </button>
      {log.length > 0 && (
        <ul className="space-y-0.5 text-xs opacity-80" role="status">
          {log.map((l, i) => (
            <li key={i}>・{l}</li>
          ))}
        </ul>
      )}
      <p className="text-xs opacity-60">
        集めた商品は JAN で楽天・Yahoo! の新品の最安値（ポイント・送料込みの実質価格）を比べます。Amazon は各商品の「Keepa で見る」から確認してください。
        楽天スーパーDEAL の商品を取り出す公開 API はないため、ポイント 5 倍以上の商品で代用しています。
      </p>
    </section>
  );
}

// ---- かんたん検索（JAN・型番・商品名・写真） ----

const QUICK_HISTORY_KEY = "price-gap:quick-history";
/** 「上位をまとめて調べる」で調べる候補の数 */
const QUICK_TOP = 3;

function QuickSearch({
  loadRakutenCredentials,
  busy,
  onResearch,
}: {
  loadRakutenCredentials: () => Promise<RakutenCredentials | null>;
  busy: boolean;
  onResearch: (items: JanItem[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<JanCandidate[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [history, setHistory] = useState<string[]>(() => loadJson<string[]>(QUICK_HISTORY_KEY) ?? []);
  const [photoAi, setPhotoAi] = useState(false);
  useEffect(() => saveJson(QUICK_HISTORY_KEY, history), [history]);
  useEffect(() => {
    fetch("/api/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((s) => setPhotoAi(!!s?.photoAi))
      .catch(() => {});
  }, []);

  const remember = (q: string) => setHistory((prev) => [q, ...prev.filter((h) => h !== q)].slice(0, 10));

  /** 型番・商品名から JAN の候補を探す（Yahoo! はサーバー、楽天はブラウザから。両方の結果をまとめる） */
  async function findCandidates(keyword: string): Promise<{ list: JanCandidate[]; errors: string[] }> {
    const errors: string[] = [];
    const yahoo = fetch("/api/jan-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword }) })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `Yahoo!: 検索に失敗しました（HTTP ${res.status}）。`);
        return body.items as JanCandidate[];
      })
      .catch((e: Error) => {
        errors.push(e.message);
        return [] as JanCandidate[];
      });
    const rakuten = loadRakutenCredentials().then(async (creds) => {
      if (!creds) return [] as JanCandidate[];
      const result = await fetchRakuten({ keyword }, creds, window.location.origin);
      if ("error" in result) {
        errors.push(result.error);
        return [] as JanCandidate[];
      }
      return findJansByKeyword(result.offers, keyword);
    });
    const [y, r] = await Promise.all([yahoo, rakuten]);
    return { list: mergeCandidates(y, r), errors };
  }

  /** 入力（1 行なら候補を出す・複数行ならまとめて調べる） */
  async function search(input = query) {
    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    setWorking(true);
    setCandidates([]);
    try {
      if (lines.length === 1) {
        const line = lines[0];
        remember(line);
        // JAN（文章の中の JAN も）ならすぐ調べる
        const jan = normalizeJan(line) ?? extractJans(line)[0];
        if (jan) {
          setMessage(`JAN ${jan} を調べます。`);
          onResearch([{ jan }]);
          return;
        }
        setMessage(`「${line}」で楽天・Yahoo! を検索しています…`);
        const { list, errors } = await findCandidates(line);
        setCandidates(list);
        setSearchedFor(line);
        setMessage(
          list.length > 0
            ? `「${line}」で JAN が分かる商品 ${list.length} 件。型番が一致する商品・付属品でない商品を上に並べています。`
            : `「${line}」で JAN が分かる新品が見つかりませんでした。${errors.join(" ")}`,
        );
        return;
      }

      // 複数行: JAN はそのまま、型番・商品名は一番それらしい候補を自動で選んでまとめて調べる
      const picked: JanItem[] = [];
      const unresolved: string[] = [];
      for (const [i, line] of lines.entries()) {
        const jan = normalizeJan(line) ?? extractJans(line)[0];
        if (jan) {
          picked.push({ jan });
          continue;
        }
        setMessage(`型番・商品名から JAN を探しています（${i + 1}/${lines.length}）: ${line}`);
        const best = bestCandidate((await findCandidates(line)).list);
        if (best) picked.push({ jan: best.jan, name: line });
        else unresolved.push(line);
        await wait(MIN_GAP_MS);
      }
      const unique = mergeJanItems([], picked);
      setMessage(
        `${unique.length} 件を調べます。` + (unresolved.length > 0 ? ` JAN が見つからなかった行: ${unresolved.join("、")}（1 行ずつ検索すると候補を選べます）` : ""),
      );
      if (unique.length > 0) onResearch(unique);
    } finally {
      setWorking(false);
    }
  }

  /** 写真: バーコードをスマホの中で読み、読めなければ AI で商品名・型番を読み取って検索する */
  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setWorking(true);
    setCandidates([]);
    try {
      setMessage("写真のバーコードを読み取っています…");
      const img = await loadImage(file);
      const jan = await decodeJanFromImage(img);
      if (jan) {
        setQuery(jan);
        remember(jan);
        setMessage(`バーコードから JAN ${jan} を読み取りました。調べます。`);
        onResearch([{ jan }]);
        return;
      }
      if (!photoAi) {
        setMessage(
          "バーコードが見つかりませんでした。バーコードを大きく写して撮り直すか、型番・商品名を入力してください（ANTHROPIC_API_KEY を登録すると、箱やスクショの写真から AI で商品名・型番を読み取れます）。",
        );
        return;
      }
      setMessage("バーコードが見つからないので、AI で商品名・型番を読み取っています…");
      const res = await fetch("/api/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: toUploadDataUrl(img) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessage(body.error ?? `写真を読み取れませんでした（HTTP ${res.status}）。`);
        return;
      }
      const read = body as { jan?: string; model?: string; name?: string; query?: string };
      const found = [read.model && `型番 ${read.model}`, read.name && `商品名 ${read.name}`].filter(Boolean).join("・");
      if (read.jan) {
        setQuery(read.jan);
        remember(read.jan);
        setMessage(`写真から JAN ${read.jan} を読み取りました${found ? `（${found}）` : ""}。調べます。`);
        onResearch([{ jan: read.jan, name: read.name }]);
        return;
      }
      if (!read.query) {
        setMessage("写真から商品を読み取れませんでした。型番・商品名を入力してください。");
        return;
      }
      setQuery(read.query);
      setMessage(`写真から読み取りました（${found}）。検索します…`);
      setWorking(false);
      await search(read.query);
    } catch (err) {
      console.error("photo search failed:", err);
      setMessage("写真を読み込めませんでした。別の写真で試してください。");
    } finally {
      setWorking(false);
    }
  }

  const research = (list: JanCandidate[]) => onResearch(list.map((c) => ({ jan: c.jan, name: c.title.slice(0, 60) })));
  const topPicks = candidates.filter((c) => !c.accessory).slice(0, QUICK_TOP);

  return (
    <section className="space-y-3 rounded-lg border-2 border-foreground/20 p-4">
      <h2 className="font-semibold">かんたん検索</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="space-y-2"
      >
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // 1 行のときは Enter で検索（改行は Shift+Enter）
            if (e.key === "Enter" && !e.shiftKey && !query.includes("\n") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void search();
            }
          }}
          rows={query.includes("\n") ? 4 : 1}
          enterKeyHint="search"
          placeholder="JAN・型番・商品名（例: ZV-E10 / 4902370548495）"
          className="w-full resize-none rounded-lg border border-black/20 bg-transparent p-3 text-base dark:border-white/25"
        />
        <div className="grid grid-cols-2 gap-2">
          <button type="submit" disabled={busy || working || query.trim() === ""} className={PRIMARY}>
            検索
          </button>
          <label className={`${SECONDARY} cursor-pointer ${busy || working ? "pointer-events-none opacity-40" : ""}`}>
            📷 写真で探す
            <input type="file" accept="image/*" onChange={(e) => void handlePhoto(e)} className="sr-only" disabled={busy || working} />
          </label>
        </div>
      </form>
      <p className="text-xs opacity-60">
        JAN はそのまま調べます。型番・商品名は楽天・Yahoo! から JAN の候補を探します（複数行で入れると、それぞれ一番それらしい商品をまとめて調べます）。
        写真はバーコードを読み取ります{photoAi ? "。バーコードがなければ箱・値札・スクショの文字を AI で読み取ります" : ""}。
      </p>

      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="opacity-60">履歴:</span>
          {history.map((h) => (
            <button
              key={h}
              type="button"
              disabled={busy || working}
              onClick={() => {
                setQuery(h);
                void search(h);
              }}
              className="min-h-9 max-w-[12rem] truncate rounded-full border border-black/20 px-3 disabled:opacity-40 dark:border-white/25"
            >
              {h}
            </button>
          ))}
          <button type="button" onClick={() => setHistory([])} className="min-h-9 px-2 underline opacity-50">
            消す
          </button>
        </div>
      )}

      {message && (
        <p className="text-sm" role="status">
          {working && <span className="mr-1 inline-block animate-pulse">●</span>}
          {message}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="space-y-2">
          {topPicks.length > 1 && (
            <button type="button" disabled={busy} onClick={() => research(topPicks)} className={`${SECONDARY} w-full`}>
              上位 {topPicks.length} 件をまとめて調べる
            </button>
          )}
          <ul className="max-h-[28rem] divide-y divide-black/10 overflow-y-auto rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
            {candidates.map((c, i) => (
              <li key={c.jan} className={`flex items-center gap-3 px-3 py-2 ${i === 0 && !c.accessory ? "bg-green-600/10" : ""}`}>
                {c.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded object-contain" />
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <div className="line-clamp-2 break-words">{c.title}</div>
                  <div className="flex flex-wrap gap-x-2 text-xs opacity-80">
                    {c.modelMatch && <span className="font-semibold text-green-700 dark:text-green-400">✓ 型番一致</span>}
                    {c.accessory && <span className="font-semibold text-amber-700 dark:text-amber-400">付属品かも</span>}
                    <span>最安 {yen.format(c.minPriceJpy)}</span>
                    <span className="opacity-70">
                      {[c.malls.rakuten && `楽天 ${c.malls.rakuten}`, c.malls.yahoo && `Yahoo! ${c.malls.yahoo}`].filter(Boolean).join("・")}件
                    </span>
                    <span className="font-mono opacity-60">{c.jan}</span>
                  </div>
                </div>
                <button type="button" disabled={busy} onClick={() => research([c])} className={`${i === 0 && !c.accessory ? PRIMARY : SECONDARY} shrink-0 !text-sm`}>
                  調べる
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs opacity-60">「{searchedFor}」の検索結果（新品・JAN が分かるものだけ）</p>
        </div>
      )}
    </section>
  );
}

// ---- JAN を追加（貼り付け・CSV） ----

function AddJans({ onAdd, onAddAndRun, busy }: { onAdd: (items: JanItem[]) => void; onAddAndRun: (items: JanItem[]) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<JanListParseResult | null>(null);
  const preview = useMemo(() => parseJanList(text), [text]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setParsed(parseJanList(decodeCsvBytes(await file.arrayBuffer())));
  }

  const submit = (run: boolean) => {
    if (preview.items.length === 0) return;
    (run ? onAddAndRun : onAdd)(preview.items);
    setText("");
  };

  return (
    <details className="group rounded-lg border border-black/10 dark:border-white/15">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">まとめて登録（JAN の貼り付け・CSV）</span>
        <span aria-hidden className="text-sm opacity-70 transition-transform group-open:rotate-180">
          ▼
        </span>
      </summary>
      <div className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        inputMode="text"
        placeholder={"1 行に 1 つ。JAN の後ろに商品名（メモ）を書いても OK\n4902370548495 スイッチ本体"}
        className="w-full rounded-lg border border-black/20 bg-transparent p-3 font-mono text-base dark:border-white/25"
      />
      {text.trim() !== "" && (
        <p className="text-xs opacity-70">
          JAN {preview.items.length} 件
          {preview.duplicates > 0 && `（重複 ${preview.duplicates} 件をまとめました）`}
          {preview.errors.length > 0 && (
            <span className="text-red-600">
              {" "}
              ／ 読めない行: {preview.errors.map((e) => `${e.line} 行目（${e.message}）`).join("、")}
            </span>
          )}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => submit(true)} disabled={busy || preview.items.length === 0} className={PRIMARY}>
          追加して調べる
        </button>
        <button type="button" onClick={() => submit(false)} disabled={preview.items.length === 0} className={SECONDARY}>
          追加だけ
        </button>
      </div>

      <label className={`${SECONDARY} cursor-pointer`}>
        CSV ファイルから読み込む（Excel の CSV も可）
        <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={handleFile} className="sr-only" />
      </label>
      {parsed && (
        <div className="space-y-2 rounded-lg border border-black/20 p-3 text-sm dark:border-white/25" role="status">
          <p>
            JAN {parsed.items.length} 件を読み込めます
            {parsed.duplicates > 0 && `（重複 ${parsed.duplicates} 件）`}
            {parsed.errors.length > 0 && <span className="text-red-600"> ／ 読めない行 {parsed.errors.length} 件</span>}
          </p>
          {parsed.errors.length > 0 && (
            <ul className="max-h-32 overflow-y-auto text-xs text-red-600">
              {parsed.errors.map((e) => (
                <li key={e.line}>
                  {e.line} 行目: {e.message}（{e.text}）
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onAdd(parsed.items);
                setParsed(null);
              }}
              disabled={parsed.items.length === 0}
              className={`${PRIMARY} flex-1`}
            >
              登録する
            </button>
            <button type="button" onClick={() => setParsed(null)} className={SECONDARY}>
              やめる
            </button>
          </div>
        </div>
      )}
      </div>
    </details>
  );
}

// ---- 売れ筋ランキングから探す（楽天） ----

type Found = { jan: string; title: string; imageUrl?: string; note: string };

function Discover({
  existing,
  onAdd,
  loadRakutenCredentials,
  busy,
}: {
  existing: JanItem[];
  onAdd: (items: JanItem[]) => void;
  loadRakutenCredentials: () => Promise<RakutenCredentials | null>;
  busy: boolean;
}) {
  const [genreId, setGenreId] = useState(RANKING_GENRES[1].id);
  const [found, setFound] = useState<Found[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const known = new Set(existing.map((i) => i.jan));

  function show(list: Found[], note: string) {
    setFound(list);
    setSelected(new Set(list.filter((f) => !known.has(f.jan)).map((f) => f.jan)));
    setMessage(note);
  }

  async function loadRanking() {
    setLoading(true);
    try {
      const creds = await loadRakutenCredentials();
      if (!creds) {
        show([], "楽天のキー（RAKUTEN_APP_ID・RAKUTEN_ACCESS_KEY）が設定されていないため、ランキングを取得できません。");
        return;
      }
      const ranking = await fetchRakutenRanking({ genreId, period: "realtime", page: 1 }, creds, window.location.origin);
      if ("error" in ranking) {
        show([], ranking.error);
        return;
      }
      // 楽天の商品データには JAN の項目がないので、商品名・説明文に書かれている JAN を使う
      const list: Found[] = [];
      for (const o of ranking.offers) {
        const jan = extractJans(o.searchText)[0];
        if (jan && !list.some((f) => f.jan === jan)) list.push({ jan, title: o.title, imageUrl: o.imageUrl, note: `楽天 ${o.rank}位・${yen.format(o.priceJpy)}` });
      }
      const genre = RANKING_GENRES.find((g) => g.id === genreId)?.label;
      show(list, `楽天リアルタイムランキング（${genre}）${ranking.offers.length} 件のうち、JAN が書かれている商品 ${list.length} 件。`);
    } finally {
      setLoading(false);
    }
  }

  const toggle = (jan: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jan)) next.delete(jan);
      else next.add(jan);
      return next;
    });

  return (
    <details className="group rounded-lg border border-black/10 dark:border-white/15">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">売れ筋ランキングから探す（楽天）</span>
        <span aria-hidden className="text-sm opacity-70 transition-transform group-open:rotate-180">
          ▼
        </span>
      </summary>
      <div className="space-y-3 border-t border-black/10 p-4 text-sm dark:border-white/15">
        <div className="flex gap-2">
          <select value={genreId} onChange={(e) => setGenreId(e.target.value)} className={`${INPUT_CLASS} flex-1`} aria-label="ランキングのジャンル">
            {RANKING_GENRES.map((g) => (
              <option key={g.id} value={g.id}>
                楽天ランキング: {g.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void loadRanking()} disabled={loading} className={SECONDARY}>
            取得
          </button>
        </div>
        {loading && <p role="status">取得中…</p>}
        {message && <p className="text-xs opacity-80">{message}</p>}
        {found.length > 0 && (
          <>
            <ul className="max-h-96 divide-y divide-black/10 overflow-y-auto rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
              {found.map((f) => (
                <li key={f.jan}>
                  <label className="flex min-h-12 items-center gap-3 px-3 py-2">
                    <input type="checkbox" checked={selected.has(f.jan)} onChange={() => toggle(f.jan)} className="h-5 w-5 shrink-0" />
                    {f.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.imageUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 break-words">{f.title}</span>
                      <span className="block text-xs opacity-60">
                        <span className="font-mono">{f.jan}</span> ・ {f.note}
                        {known.has(f.jan) && " ・ 登録済み"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => {
                onAdd(found.filter((f) => selected.has(f.jan)).map((f) => ({ jan: f.jan, name: f.title.slice(0, 60) })));
                setSelected(new Set());
              }}
              className={`${PRIMARY} w-full`}
            >
              選んだ {selected.size} 件を登録
            </button>
          </>
        )}
      </div>
    </details>
  );
}

// ---- 計算の前提 ----

/** 数値の入力欄（入力中は文字列で持ち、0 以上の数値として読めたときだけ反映する） */
function NumberSetting({ label, value, onCommit }: { label: React.ReactNode; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= 0) onCommit(n);
        }}
        className={INPUT_CLASS}
      />
    </label>
  );
}

function SettingsPanel({ settings, onChange }: { settings: ArbitrageSettings; onChange: (s: ArbitrageSettings) => void }) {
  // 「初期値に戻す」で入力欄も作り直す
  const [version, setVersion] = useState(0);
  const set = (patch: Partial<ArbitrageSettings>) => onChange({ ...settings, ...patch });
  const setSell = (mall: Mall, patch: Partial<ArbitrageSettings["sell"][Mall]>) =>
    set({ sell: { ...settings.sell, [mall]: { ...settings.sell[mall], ...patch } } });

  return (
    <details className="group rounded-lg border border-black/10 dark:border-white/15">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">計算の前提・推奨の条件</span>
        <span className="flex items-center gap-2 text-sm opacity-70">
          {yen.format(settings.minProfitJpy)}以上・{settings.minMarginPercent}%以上
          <span aria-hidden className="transition-transform group-open:rotate-180">
            ▼
          </span>
        </span>
      </summary>
      <div key={version} className="space-y-5 border-t border-black/10 p-4 dark:border-white/15">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">推奨ルートの条件</legend>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <NumberSetting label="利益（円以上）" value={settings.minProfitJpy} onCommit={(n) => set({ minProfitJpy: n })} />
            <NumberSetting label="利益率（%以上）" value={settings.minMarginPercent} onCommit={(n) => set({ minMarginPercent: n })} />
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">仕入れ（ポイント・送料）</legend>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {BUY_MALLS.map((m) => (
              <NumberSetting
                key={m}
                label={`${MALL_LABEL[m]} 上乗せポイント（%）`}
                value={settings.extraPointPercent[m]}
                onCommit={(n) => set({ extraPointPercent: { ...settings.extraPointPercent, [m]: n } })}
              />
            ))}
            <NumberSetting label="ポイントの価値（%）" value={settings.pointValuePercent} onCommit={(n) => set({ pointValuePercent: n })} />
            <NumberSetting label="送料別のときの送料（円）" value={settings.buyShippingJpy} onCommit={(n) => set({ buyShippingJpy: n })} />
          </div>
          <p className="text-xs opacity-60">
            各モールが表示しているポイント（楽天: ショップの倍率、Yahoo!: ストアポイント（PayPay ポイント））は自動で計算します。
            楽天 SPU・LYP 会員・キャンペーンなど人によって違う分を「上乗せ」に入れてください（例: 楽天 SPU が 7 倍なら 6）。
            期間限定ポイントを割り引いて考えるときは「ポイントの価値」を下げます。
          </p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">販売先</legend>
          {MALLS.map((m) => (
            <div key={m} className="space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
              <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={settings.sell[m].enabled} onChange={(e) => setSell(m, { enabled: e.target.checked })} className="h-5 w-5" />
                {SELL_LABEL[m]} で販売する
                {m === "amazon" && <span className="text-xs font-normal opacity-60">（Keepa で確認した価格を入れた商品だけ）</span>}
              </label>
              {settings.sell[m].enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <NumberSetting
                    label={m === "amazon" ? "販売手数料（%）" : "販売手数料の合計（%）"}
                    value={settings.sell[m].feePercent}
                    onCommit={(n) => setSell(m, { feePercent: n })}
                  />
                  <NumberSetting
                    label={m === "amazon" ? "FBA への納品送料（円/個）" : "お客様への送料（円/個）"}
                    value={settings.sell[m].shippingJpy}
                    onCommit={(n) => setSell(m, { shippingJpy: n })}
                  />
                  {m === "amazon" && (
                    <NumberSetting
                      label="FBA 配送代行手数料（円/個）"
                      value={settings.amazonFallbackFbaFeeJpy}
                      onCommit={(n) => set({ amazonFallbackFbaFeeJpy: n })}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="text-xs opacity-60">
            Amazon は「販売価格 × 販売手数料 % ＋ FBA 配送代行手数料 ＋ 納品送料」で計算します（カテゴリやサイズで違うので、Keepa の手数料欄を見て合わせてください）。楽天・Yahoo! の手数料は、
            システム利用料・決済手数料・ポイント原資などを合計した割合を入れてください。出店していないモールはチェックを外します。
          </p>
        </fieldset>

        <button
          type="button"
          onClick={() => {
            onChange(DEFAULT_ARBITRAGE_SETTINGS);
            setVersion((v) => v + 1);
          }}
          className="min-h-11 text-sm underline opacity-70"
        >
          初期値に戻す
        </button>
      </div>
    </details>
  );
}

// ---- 結果 ----

function routeLabel(r: Route): string {
  return `${MALL_LABEL[r.buy]}仕入れ ➔ ${SELL_LABEL[r.sell]}販売`;
}

function shippingNote(o: MallOffer, shippingJpy: number): string {
  if (o.shipping === "free") return "送料無料";
  if (o.shippingJpy !== undefined) return `送料 ${yen.format(o.shippingJpy)}`;
  return `送料別（+${yen.format(shippingJpy)}で計算）`;
}

function LinkButton({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex min-h-12 items-center justify-center rounded-lg px-2 text-center text-sm font-medium active:opacity-70 ${
        primary ? "bg-foreground text-background" : "border border-black/25 dark:border-white/30"
      }`}
    >
      {children}
    </a>
  );
}

function BestRoute({ best }: { best: Route }) {
  const good = best.isTreasure;
  const positive = best.profitJpy > 0;
  const heading = good ? "[推奨] 最適ルート" : positive ? "最適ルート（条件未達）" : "最適ルート（利益なし）";
  return (
    <div
      className={`rounded-lg p-3 ${
        good ? "bg-green-600 text-white" : positive ? "border-2 border-amber-500/70" : "border border-black/15 dark:border-white/20"
      }`}
    >
      <div className="text-xs font-semibold opacity-90">{heading}</div>
      <div className="text-base font-bold break-words">{routeLabel(best)}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm">
        <span className={`text-lg font-bold ${good ? "" : positive ? "text-green-600" : "text-red-600"}`}>見込み利益 {yen.format(best.profitJpy)}</span>
        <span>（利益率 {best.marginPercent.toFixed(1)}%）</span>
      </div>
      {best.sell === "amazon" && <div className="mt-1 text-xs opacity-90">回転率・ライバル数は Keepa で確認してください。</div>}
    </div>
  );
}

/** Amazon の確認（API は使わない）: Amazon・Keepa へのリンクと、Keepa で見た販売価格の入力欄 */
function AmazonManual({ jan, priceJpy, onChange }: { jan: string; priceJpy: number | undefined; onChange: (priceJpy: number | undefined) => void }) {
  const [text, setText] = useState(priceJpy ? String(priceJpy) : "");
  return (
    <div className="space-y-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Amazon（Keepa で確認）</span>
        <div className="flex gap-2">
          <a href={amazonSearchUrl(jan)} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center rounded-lg border border-black/25 px-3 text-xs font-medium dark:border-white/30">
            Amazon で見る
          </a>
          <a href={keepaSearchUrl(jan)} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center rounded-lg border border-black/25 px-3 text-xs font-medium dark:border-white/30">
            Keepa で見る
          </a>
        </div>
      </div>
      <label className="flex items-center gap-2">
        <span className="shrink-0 text-xs opacity-80">販売価格（円）</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="カート価格を入れると FBA 利益を計算"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value.replace(/[,，円¥￥\s]/g, ""));
            onChange(Number.isFinite(n) && n > 0 ? Math.round(n) : undefined);
          }}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />
      </label>
    </div>
  );
}

/** 結果の上に出す、利益の出る商品の一覧（タップで各商品へ移動） */
function RouteSummary({ rows }: { rows: Row[] }) {
  const withRoute = rows.filter((r) => r.analysis.best && r.analysis.best.profitJpy > 0);
  if (withRoute.length === 0) return null;
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/15">
      <div className="px-3 pt-2 text-sm font-semibold">利益の出る商品（{withRoute.length}件）</div>
      <ol className="divide-y divide-black/10 dark:divide-white/15">
        {withRoute.map(({ item, lookup, analysis }) => {
          const best = analysis.best!;
          return (
            <li key={item.jan}>
              <a
                href={`#jan-${lookup.jan}`}
                className={`flex min-h-12 items-center gap-2 px-3 py-2 text-sm ${best.isTreasure ? "bg-green-600/10" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{lookup.title || item.name || lookup.jan}</span>
                  <span className={`block text-xs ${best.isTreasure ? "font-semibold text-green-700 dark:text-green-400" : "opacity-70"}`}>
                    {routeLabel(best)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={`block font-bold ${best.isTreasure ? "text-green-600" : ""}`}>{yen.format(best.profitJpy)}</span>
                  <span className="block text-xs opacity-60">{best.marginPercent.toFixed(0)}%</span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ResultCard({
  row,
  settings,
  onRefresh,
  busy,
  amazonPrice,
  onAmazonPrice,
}: {
  row: Row;
  settings: ArbitrageSettings;
  onRefresh: () => void;
  busy: boolean;
  amazonPrice: number | undefined;
  onAmazonPrice: (priceJpy: number | undefined) => void;
}) {
  const { item, lookup, analysis } = row;
  const { best } = analysis;
  // 楽天・Yahoo! の中で、ポイント・送料込みの実質価格が一番安い仕入れ先
  const cheapestBuy = BUY_MALLS.map((m) => bestBuyOption(lookup.offers[m], settings))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .sort((a, b) => a.netJpy - b.netJpy)[0];

  return (
    <li id={`jan-${lookup.jan}`} className={`scroll-mt-4 space-y-3 rounded-lg border p-4 ${best?.isTreasure ? "border-green-600/60" : "border-black/10 dark:border-white/15"}`}>
      <div className="flex gap-3">
        {lookup.imageUrl && (
          // 各モールの画像サーバーの画像をそのまま表示する
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={lookup.imageUrl}
            alt=""
            loading="lazy"
            onError={(e) => (e.currentTarget.style.display = "none")}
            className="h-16 w-16 shrink-0 rounded object-contain"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-medium break-words">{lookup.title || item.name || "（商品名不明）"}</div>
          <div className="text-xs opacity-60">
            JAN <span className="font-mono">{lookup.jan}</span>
            {item.name && lookup.title && item.name !== lookup.title && ` ・ ${item.name}`} ・ {dateTime.format(new Date(lookup.fetchedAt))}
          </div>
        </div>
      </div>

      {cheapestBuy ? (
        <div className="rounded-lg bg-black/[.04] p-3 text-sm dark:bg-white/[.06]">
          <div className="text-xs opacity-70">最安仕入れ（ポイント・送料込みの実質価格）</div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-lg font-bold">{yen.format(cheapestBuy.netJpy)}</span>
            <span className="text-xs opacity-80">
              {MALL_LABEL[cheapestBuy.offer.mall]} {cheapestBuy.offer.shopName} ・ {yen.format(cheapestBuy.offer.priceJpy)} ・{" "}
              {shippingNote(cheapestBuy.offer, settings.buyShippingJpy)}
              {cheapestBuy.pointsJpy > 0 && ` ・ ポイント −${yen.format(cheapestBuy.pointsJpy)}`}
            </span>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-black/15 p-3 text-sm opacity-80 dark:border-white/20">楽天・Yahoo! に新品・在庫ありの出品がありませんでした。</p>
      )}

      {/* Amazon は API を使わず、Keepa で確認した販売価格を入れてもらう */}
      <AmazonManual jan={lookup.jan} priceJpy={amazonPrice} onChange={onAmazonPrice} />

      {best && <BestRoute best={best} />}

      {best && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="opacity-70">仕入れ</dt>
          <dd className="text-right">
            {yen.format(best.buyOption.netJpy)}
            <span className="block text-xs opacity-60">
              {MALL_LABEL[best.buy]} {best.buyOption.offer.shopName} ・ {yen.format(best.buyOption.offer.priceJpy)} ・{" "}
              {shippingNote(best.buyOption.offer, settings.buyShippingJpy)}
              {best.buyOption.pointsJpy > 0 && ` ・ ポイント −${yen.format(best.buyOption.pointsJpy)}`}
            </span>
          </dd>
          <dt className="opacity-70">販売</dt>
          <dd className="text-right">
            {yen.format(best.sellPriceJpy)}
            <span className="block text-xs opacity-60">
              {best.sell === "amazon" ? "入力した Amazon の販売価格" : `${SELL_LABEL[best.sell]}の最安値`} ・ 手数料 −{yen.format(best.sellFeesJpy)}
              {best.sell === "amazon" && "（販売手数料＋FBA 配送代行手数料）"} ・ 送料 −{yen.format(best.sellShippingJpy)}
            </span>
          </dd>
        </dl>
      )}

      {/* 楽天・Yahoo! の価格と在庫 */}
      <div className="divide-y divide-black/10 rounded-lg border border-black/10 text-sm dark:divide-white/15 dark:border-white/15">
        {BUY_MALLS.map((m) => {
          const offers = lookup.offers[m];
          const cheapest = offers[0];
          const isBuy = best?.buy === m;
          const isSell = best?.sell === m;
          return (
            <div key={m} className="flex items-center gap-2 px-3 py-2">
              <div className="w-16 shrink-0 font-medium">
                {MALL_LABEL[m]}
                {(isBuy || isSell) && <span className="block text-xs font-semibold text-green-700 dark:text-green-400">{isBuy ? "仕入れ" : "販売"}</span>}
              </div>
              <div className="min-w-0 flex-1 text-xs">
                {offers.length === 0 ? (
                  <span className="opacity-60">在庫なし・出品なし</span>
                ) : (
                  <>
                    <span className="text-sm font-semibold">{yen.format(cheapest.priceJpy)}</span>
                    {cheapest.pointsJpy > 0 && <span className="opacity-70"> （{cheapest.pointsJpy}pt）</span>}
                    <span className="block opacity-60">在庫あり {offers.length}件</span>
                  </>
                )}
              </div>
              {cheapest?.url && (
                <a
                  href={cheapest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex min-h-11 shrink-0 items-center rounded-lg px-3 text-xs font-medium ${
                    isBuy ? "bg-foreground text-background" : "border border-black/25 dark:border-white/30"
                  }`}
                >
                  開く
                </a>
              )}
            </div>
          );
        })}
      </div>

      {cheapestBuy && (
        <LinkButton href={cheapestBuy.offer.url} primary>
          {MALL_LABEL[cheapestBuy.offer.mall]}で仕入れる（{yen.format(cheapestBuy.offer.priceJpy)}）
        </LinkButton>
      )}

      {analysis.routes.length > 1 && (
        <details className="text-xs">
          <summary className="flex min-h-11 cursor-pointer items-center opacity-70">すべてのルート（{analysis.routes.length}）</summary>
          <table className="w-full">
            <tbody>
              {analysis.routes.map((r) => (
                <tr key={`${r.buy}-${r.sell}`} className="border-t border-black/10 dark:border-white/15">
                  <td className="py-2">
                    {routeLabel(r)}
                  </td>
                  <td className={`py-2 text-right font-semibold ${r.profitJpy >= 0 ? "text-green-600" : "text-red-600"}`}>{yen.format(r.profitJpy)}</td>
                  <td className="py-2 text-right opacity-70">{r.marginPercent.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {(lookup.excludedSets > 0 || (lookup.excludedUsed ?? 0) > 0 || lookup.warnings.length > 0) && (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
          {(lookup.excludedUsed ?? 0) > 0 && <li>中古・開封品・訳ありなど新品ではない出品 {lookup.excludedUsed} 件を除きました。</li>}
          {lookup.excludedSets > 0 && <li>複数個セットの出品 {lookup.excludedSets} 件は 1 個の値段ではないため除きました。</li>}
          {lookup.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <button type="button" onClick={onRefresh} disabled={busy} className="min-h-11 text-sm underline opacity-70 disabled:opacity-40">
        調べ直す
      </button>
    </li>
  );
}
