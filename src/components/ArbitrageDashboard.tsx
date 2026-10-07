"use client";

// 国内 3 モール（Amazon・楽天市場・Yahoo!ショッピング）の価格差リサーチ画面。
// 登録した JAN を 1 つずつ 3 モールで調べ、「どこで仕入れてどこで売ると一番得か」を計算して表示する。
// JAN の一覧・計算の前提・最後の結果はブラウザの localStorage に保存する。

import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeJan, monthlySalesEstimate, type Analysis, type Route } from "@/lib/arbitrage";
import { loadJson, saveJson } from "@/lib/browserStorage";
import { containsJan, extractJans, normalizeJan } from "@/lib/jan";
import { decodeCsvBytes, janListToCsv, mergeJanItems, parseJanList, type JanItem, type JanListParseResult } from "@/lib/janList";
import type { JanCandidate } from "@/lib/janSearch";
import {
  DEFAULT_ARBITRAGE_SETTINGS,
  MALL_LABEL,
  MALLS,
  MIN_RANKS,
  RANK_INFO,
  SELL_LABEL,
  type ArbitrageSettings,
  type JanLookup,
  type Mall,
  type MallOffer,
  type MinRank,
  type TurnoverRank,
} from "@/lib/malls";
import { fetchRakuten, fetchRakutenRanking, type RakutenCredentials, type RakutenResult } from "@/lib/rakuten";
import { INPUT_CLASS } from "./Fields";

const ITEMS_KEY = "price-gap:jan-items";
const SETTINGS_KEY = "price-gap:arbitrage-settings";
const RESULTS_KEY = "price-gap:jan-results";
const ONLY_TREASURES_KEY = "price-gap:only-treasures";

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

const RANK_STYLE: Record<TurnoverRank, string> = {
  S: "bg-green-600 text-white",
  A: "bg-sky-600 text-white",
  B: "bg-amber-500 text-black",
  C: "bg-red-600 text-white",
  unknown: "border border-black/30 dark:border-white/40",
};
const RANK_WORD: Record<TurnoverRank, string> = { S: "即売れ", A: "高回転", B: "中回転", C: "低回転", unknown: "回転率不明" };

const BUTTON = "flex min-h-12 items-center justify-center rounded-lg px-3 text-center text-sm active:opacity-70 disabled:opacity-40";
const PRIMARY = `${BUTTON} bg-foreground text-base font-medium text-background`;
const SECONDARY = `${BUTTON} border border-black/25 dark:border-white/30`;

function loadSettings(): ArbitrageSettings {
  const d = DEFAULT_ARBITRAGE_SETTINGS;
  const saved = loadJson<Partial<ArbitrageSettings>>(SETTINGS_KEY) ?? {};
  return {
    ...d,
    ...saved,
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
  const [running, setRunning] = useState<{ jan: string; index: number; total: number } | null>(null);
  const [showAllItems, setShowAllItems] = useState(false);
  const stopRequested = useRef(false);
  const rakutenCredentials = useRef<Promise<RakutenCredentials | null> | null>(null);

  useEffect(() => saveJson(ITEMS_KEY, items), [items]);
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings]);
  useEffect(() => saveJson(RESULTS_KEY, results), [results]);
  useEffect(() => saveJson(ONLY_TREASURES_KEY, onlyTreasures), [onlyTreasures]);

  // 調べた JAN ごとに、今の設定で全ルートを計算し、一番利益の大きいルートの順に並べる
  const rows = useMemo(() => {
    const list: Row[] = items.flatMap((item) => {
      const lookup = results[item.jan];
      return lookup ? [{ item, lookup, analysis: analyzeJan(lookup, settings) }] : [];
    });
    return list.sort((a, b) => (b.analysis.best?.profitJpy ?? -Infinity) - (a.analysis.best?.profitJpy ?? -Infinity));
  }, [items, results, settings]);
  const treasureCount = rows.filter((r) => r.analysis.best?.isTreasure).length;
  const visibleRows = onlyTreasures ? rows.filter((r) => r.analysis.best?.isTreasure) : rows;

  /** 楽天のキー（ログイン済みのときだけサーバーから受け取る。未設定なら null）。1 回だけ取りに行く */
  function loadRakutenCredentials(): Promise<RakutenCredentials | null> {
    rakutenCredentials.current ??= fetch("/api/rakuten/credentials", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body?.configured ? { appId: body.appId, accessKey: body.accessKey, affiliateId: body.affiliateId } : null))
      .catch(() => null);
    return rakutenCredentials.current;
  }

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

  async function runAll(jans: string[]) {
    stopRequested.current = false;
    for (const [index, jan] of jans.entries()) {
      // 「中止」が押されたら、今の JAN が終わったところで止める
      if (stopRequested.current) break;
      setRunning({ jan, index: index + 1, total: jans.length });
      const started = Date.now();
      await lookup(jan);
      const rest = MIN_GAP_MS - (Date.now() - started);
      if (rest > 0 && index < jans.length - 1) await wait(rest);
    }
    setRunning(null);
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
          <h1 className="text-xl font-bold sm:text-2xl">国内 3 モール 価格差リサーチ</h1>
          <form method="post" action="/api/logout" className="shrink-0">
            <button type="submit" className="min-h-11 px-2 text-sm underline opacity-70 active:opacity-100">
              ログアウト
            </button>
          </form>
        </div>
        <p className="text-sm opacity-80">
          JAN コードで Amazon・楽天市場・Yahoo!ショッピングの同じ商品だけを照合し、ポイント還元と FBA 手数料を含めた利益が一番大きい「仕入れ先 ➔ 販売先」を自動で選びます。
        </p>
      </header>

      <AddJans onAdd={addItems} onAddAndRun={(added) => {
        addItems(added);
        void runAll(added.map((i) => i.jan));
      }} busy={busy} />

      <Discover existing={items} onAdd={addItems} loadRakutenCredentials={loadRakutenCredentials} busy={busy} />

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
          <p className="text-sm opacity-70">上の「JAN を追加」か「JAN を探す」から登録してください。</p>
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
            {busy ? (
              <div className="flex items-center gap-3" role="status">
                <span className="flex-1 text-sm">
                  調査中 {running.index}/{running.total}: <span className="font-mono">{running.jan}</span>
                </span>
                <button type="button" onClick={() => (stopRequested.current = true)} className={SECONDARY}>
                  中止
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => void runAll(items.map((i) => i.jan))} className={`${PRIMARY} w-full sm:w-auto sm:px-8`}>
                すべて調べる（{items.length}件）
              </button>
            )}
            <p className="text-xs opacity-60">
              1 件ずつ順番に調べます（Keepa はトークンを 1 件あたり 1 つ使います）。画面を開いたままにしてください。
            </p>
          </>
        )}
      </section>

      <SettingsPanel settings={settings} onChange={setSettings} />

      {/* 結果 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">
            結果 <span className="text-sm font-normal opacity-70">推奨 {treasureCount} 件 ／ 調査済み {rows.length} 件</span>
          </h2>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyTreasures} onChange={(e) => setOnlyTreasures(e.target.checked)} className="h-5 w-5" />
            条件を満たす商品だけ
          </label>
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
            {rows.length === 0 ? "まだ調べていません。" : "条件を満たす商品はありません（チェックを外すとすべて表示します）。"}
          </p>
        ) : (
          <ul className="space-y-4">
            {visibleRows.map((row) => (
              <ResultCard key={row.item.jan} row={row} settings={settings} onRefresh={() => void runAll([row.item.jan])} busy={busy} />
            ))}
          </ul>
        )}
      </section>
    </main>
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
    <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
      <h2 className="font-semibold">JAN を追加</h2>
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
    </section>
  );
}

// ---- JAN を探す（キーワード・楽天ランキング） ----

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
  const [keyword, setKeyword] = useState("");
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

  async function searchKeyword(e: React.FormEvent) {
    e.preventDefault();
    const direct = normalizeJan(keyword);
    if (direct) {
      onAdd([{ jan: direct }]);
      setKeyword("");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/jan-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword }) });
      const body = await res.json();
      if (!res.ok) {
        show([], body.error ?? `検索に失敗しました（HTTP ${res.status}）。`);
        return;
      }
      const items = body.items as JanCandidate[];
      show(
        items.map((c) => ({ jan: c.jan, title: c.title, imageUrl: c.imageUrl, note: `Yahoo! ${c.count}件・最安 ${yen.format(c.minPriceJpy)}` })),
        `Yahoo!ショッピングで「${keyword}」の新品を探し、JAN が分かる商品 ${items.length} 件が見つかりました。`,
      );
    } catch {
      show([], "サーバーに接続できませんでした。");
    } finally {
      setLoading(false);
    }
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
        <span className="font-semibold">JAN を探す（キーワード・売れ筋ランキング）</span>
        <span aria-hidden className="text-sm opacity-70 transition-transform group-open:rotate-180">
          ▼
        </span>
      </summary>
      <div className="space-y-3 border-t border-black/10 p-4 text-sm dark:border-white/15">
        <form onSubmit={searchKeyword} className="flex gap-2">
          <input
            type="search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="商品名・型番（JAN ならそのまま追加）"
            className={`${INPUT_CLASS} flex-1`}
          />
          <button type="submit" disabled={loading || keyword.trim() === ""} className={SECONDARY}>
            探す
          </button>
        </form>
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
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-sm lg:col-span-1">
              <span>回転率（Amazon の月の販売回数）</span>
              <select value={settings.minRank} onChange={(e) => set({ minRank: e.target.value as MinRank })} className={INPUT_CLASS}>
                {MIN_RANKS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">仕入れ（ポイント・送料）</legend>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {MALLS.map((m) => (
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
            各モールが表示しているポイント（楽天: ショップの倍率、Yahoo!: ストアのボーナス、Amazon: 出品のポイント）は自動で計算します。
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
              </label>
              {settings.sell[m].enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <NumberSetting
                    label={m === "amazon" ? "販売手数料（%・見積もれないとき）" : "販売手数料の合計（%）"}
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
                      label="FBA 配送代行手数料（円・見積もれないとき）"
                      value={settings.amazonFallbackFbaFeeJpy}
                      onCommit={(n) => set({ amazonFallbackFbaFeeJpy: n })}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="text-xs opacity-60">
            Amazon の手数料（販売手数料＋FBA 配送代行手数料）は SP-API で商品ごとに見積もります。楽天・Yahoo! の手数料は、
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

function BestRoute({ best }: { best: Route | undefined }) {
  if (!best) {
    return (
      <div className="rounded-lg border border-black/15 p-3 text-sm opacity-80 dark:border-white/20">
        比べられるルートがありません（出品が見つかったモールが 1 つ以下か、販売先をすべてオフにしています）。
      </div>
    );
  }
  const good = best.isTreasure;
  const positive = best.profitJpy > 0;
  return (
    <div
      className={`rounded-lg p-3 ${
        good ? "bg-green-600 text-white" : positive ? "border-2 border-amber-500/70" : "border border-black/15 dark:border-white/20"
      }`}
    >
      <div className="text-xs font-semibold opacity-90">{good ? "★ 最適ルート（条件クリア）" : positive ? "最適ルート（条件未達）" : "最適ルート（利益なし）"}</div>
      <div className="text-base font-bold break-words">{routeLabel(best)}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm">
        <span className={`text-lg font-bold ${good ? "" : positive ? "text-green-600" : "text-red-600"}`}>利益 {yen.format(best.profitJpy)}</span>
        <span>（{best.marginPercent.toFixed(1)}%）</span>
        <span>／ {RANK_WORD[best.rank]}</span>
        <span className={`rounded px-1.5 text-xs font-bold ${good ? "bg-white text-green-700" : RANK_STYLE[best.rank]}`} title={RANK_INFO[best.rank].hint}>
          {RANK_INFO[best.rank].label}
        </span>
      </div>
    </div>
  );
}

function ResultCard({ row, settings, onRefresh, busy }: { row: Row; settings: ArbitrageSettings; onRefresh: () => void; busy: boolean }) {
  const { item, lookup, analysis } = row;
  const { best } = analysis;
  const amazon = lookup.amazon;

  return (
    <li className={`space-y-3 rounded-lg border p-4 ${best?.isTreasure ? "border-green-600/60" : "border-black/10 dark:border-white/15"}`}>
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

      <BestRoute best={best} />

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
              {SELL_LABEL[best.sell]}の最安値 ・ 手数料 −{yen.format(best.sellFeesJpy)}
              {best.sell === "amazon" && (best.feesFromApi ? "（SP-API 見積もり）" : "（設定の割合）")} ・ 送料 −{yen.format(best.sellShippingJpy)}
            </span>
          </dd>
        </dl>
      )}

      {/* 3 モールの価格と在庫 */}
      <div className="divide-y divide-black/10 rounded-lg border border-black/10 text-sm dark:divide-white/15 dark:border-white/15">
        {MALLS.map((m) => {
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
                {m === "amazon" && !amazon ? (
                  <span className="opacity-60">データなし</span>
                ) : offers.length === 0 && !(m === "amazon" && amazon?.lowestPriceJpy) ? (
                  <span className="opacity-60">在庫なし・出品なし</span>
                ) : (
                  <>
                    <span className="text-sm font-semibold">
                      {cheapest ? yen.format(cheapest.priceJpy) : amazon?.lowestPriceJpy !== undefined && yen.format(amazon.lowestPriceJpy)}
                    </span>
                    {cheapest && cheapest.pointsJpy > 0 && <span className="opacity-70"> （{cheapest.pointsJpy}pt）</span>}
                    <span className="block opacity-60">
                      在庫あり {m === "amazon" ? (amazon?.offerCount ?? offers.length) : offers.length}件
                      {m === "amazon" && amazon?.lowestFbaPriceJpy !== undefined && ` ・ FBA 最安 ${yen.format(amazon.lowestFbaPriceJpy)}`}
                      {m === "amazon" && amazon?.salesRank !== undefined && ` ・ ${amazon.salesRankCategory ?? ""} ${amazon.salesRank.toLocaleString()}位`}
                      {m === "amazon" && monthlySalesEstimate(amazon) !== undefined && ` ・ 月 ${monthlySalesEstimate(amazon)} 回販売`}
                    </span>
                  </>
                )}
              </div>
              {(cheapest?.url ?? (m === "amazon" ? amazon?.url : undefined)) && (
                <a
                  href={cheapest?.url ?? amazon!.url}
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

      {best && (
        <div className="grid grid-cols-2 gap-2">
          <LinkButton href={best.buyOption.offer.url} primary>
            {MALL_LABEL[best.buy]}で仕入れる
          </LinkButton>
          {amazon ? <LinkButton href={amazon.url}>Amazon 商品ページ</LinkButton> : <span />}
        </div>
      )}

      {analysis.routes.length > 1 && (
        <details className="text-xs">
          <summary className="flex min-h-11 cursor-pointer items-center opacity-70">すべてのルート（{analysis.routes.length}）</summary>
          <table className="w-full">
            <tbody>
              {analysis.routes.map((r) => (
                <tr key={`${r.buy}-${r.sell}`} className="border-t border-black/10 dark:border-white/15">
                  <td className="py-2">{routeLabel(r)}</td>
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
