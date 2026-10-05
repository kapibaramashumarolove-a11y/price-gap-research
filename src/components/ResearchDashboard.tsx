"use client";

// 自動リサーチの画面。保存した検索条件（プリセット）で楽天・Yahoo! と eBay を調べ、
// 利益の条件を満たす「お宝商品」を一覧にする。
// 検索条件・お宝の条件・最後の結果はブラウザの localStorage に保存する。

import { useEffect, useMemo, useRef, useState } from "react";
import { loadJson, saveJson, SETTINGS_KEY } from "@/lib/browserStorage";
import {
  applyImportedPresets,
  CSV_TEMPLATE,
  decodeCsvBytes,
  presetsFromCsv,
  presetsToCsv,
  type CsvImportResult,
  type CsvMode,
} from "@/lib/presetCsv";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/profit";
import { parseQuickInput, type QuickLine } from "@/lib/quickInput";
import { fetchRakuten, fetchRakutenRanking, type RakutenCredentials, type RakutenResult, type RankingPeriod } from "@/lib/rakuten";
import {
  DEFAULT_CRITERIA,
  evaluateCandidate,
  MIN_RANKS,
  PRICE_BASES,
  RANK_INFO,
  type Evaluation,
  type MinRank,
  type PriceBasis,
  type TreasureCriteria,
  type TurnoverRank,
} from "@/lib/researchProfit";
import {
  DEFAULT_MAX_LOOKUPS,
  DEFAULT_PRESETS,
  ITEM_CONDITIONS,
  MAX_LOOKUPS_LIMIT,
  RANKING_GENRES,
  RESEARCH_KINDS,
  type Candidate,
  type DomesticOffer,
  type ItemCondition,
  type ResearchKind,
  type ResearchPreset,
  type ResearchResponse,
} from "@/lib/researchTypes";
import { parseResearchRequest } from "@/lib/researchRequest";
import { INPUT_CLASS, NumberField, TextField } from "./Fields";

const PRESETS_KEY = "price-gap:research-presets";
const CRITERIA_KEY = "price-gap:research-criteria";
const RESULTS_KEY = "price-gap:research-results";
const ONLY_TREASURES_KEY = "price-gap:research-only-treasures";
const GENRE_FILTER_KEY = "price-gap:research-genre";
const DISCOVER_KEY = "price-gap:discover-options";

type DiscoverOptions = { genreIds: string[]; period: RankingPeriod; pages: number };
const DEFAULT_DISCOVER: DiscoverOptions = { genreIds: ["100212", "111961", "112493"], period: "realtime", pages: 1 };

/** /api/discover の結果の集計 */
type DiscoverStats = { received: number; noIdentifier: number; excluded: number; duplicates: number; checked: number; salesChecked: number };
/** 検索条件の一覧で最初に表示する件数（多いときは「残りを表示」で開く） */
const PRESET_PREVIEW_COUNT = 5;

/** 文字列をファイルとしてダウンロードさせる（Excel で文字化けしないよう BOM を付ける） */
function downloadCsv(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


type PresetResult = {
  presetName: string;
  response: ResearchResponse;
  /** 商品指定で、付属品を除くため eBay 相場から自動で決めた国内の最低価格 [円] */
  autoMinPriceJpy?: number;
};

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateTime = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const SETTING_FIELDS: { key: keyof Settings; label: string }[] = [
  { key: "usdJpy", label: "為替（円/USD）" },
  { key: "ebayFeeRate", label: "eBay 落札手数料（%）" },
  { key: "internationalFeeRate", label: "海外取引手数料（%）" },
  { key: "perOrderFeeUsd", label: "1注文の固定手数料（USD）" },
  { key: "internationalShippingJpy", label: "国際送料の初期値（円）" },
];

const BASIS_SHORT: Record<PriceBasis, string> = { sold: "売れている出品", p25: "安い方25%", median: "中央値", min: "最安値" };

const RANK_STYLE: Record<TurnoverRank, string> = {
  S: "bg-green-600 text-white",
  A: "bg-sky-600 text-white",
  B: "bg-amber-500 text-black",
  C: "bg-red-600 text-white",
  unknown: "border border-black/30 dark:border-white/40",
};
const SOURCE_LABEL: Record<DomesticOffer["source"], string> = { rakuten: "楽天", yahoo: "Yahoo!" };

/** 0 以上の数値として読めれば数値、読めなければ null */
function toNonNegativeNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function kindLabel(kind: ResearchKind): string {
  return RESEARCH_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

// ---- 検索条件の編集フォーム（入力中は文字列で持つ） ----

type PresetForm = {
  name: string;
  genre: string;
  kind: ResearchKind;
  keyword: string;
  jan: string;
  condition: ItemCondition;
  ngWords: string;
  minPriceJpy: string;
  maxPriceJpy: string;
  ebayKeyword: string;
  internationalShippingJpy: string;
  maxLookups: string;
};

function toForm(p: ResearchPreset): PresetForm {
  const str = (n: number | undefined) => (n === undefined ? "" : String(n));
  return {
    name: p.name,
    genre: p.genre ?? "",
    kind: p.kind,
    keyword: p.keyword,
    jan: p.jan ?? "",
    condition: p.condition ?? "new",
    ngWords: p.ngWords.join(" "),
    minPriceJpy: str(p.minPriceJpy),
    maxPriceJpy: str(p.maxPriceJpy),
    ebayKeyword: p.ebayKeyword ?? "",
    internationalShippingJpy: str(p.internationalShippingJpy),
    maxLookups: str(p.maxLookups),
  };
}

/** フォームの内容を検索条件にする（/api/research・CSV 読み込みと同じ規則で検査）。おかしければエラーメッセージ */
function fromForm(id: string, f: PresetForm): ResearchPreset | string {
  if (f.name.trim() === "") return "名前を入力してください。";
  const intl = f.internationalShippingJpy.trim() === "" ? undefined : toNonNegativeNumber(f.internationalShippingJpy);
  if (intl === null) return "国際送料には 0 以上の数値を入力してください。";
  const parsed = parseResearchRequest({
    kind: f.kind,
    keyword: f.keyword,
    ngWords: f.ngWords.split(/[\s,、]+/),
    minPriceJpy: f.minPriceJpy.trim(),
    maxPriceJpy: f.maxPriceJpy.trim(),
    ebayKeyword: f.ebayKeyword,
    maxLookups: f.maxLookups.trim(),
    jan: f.jan,
    condition: f.condition,
  });
  if (typeof parsed === "string") return parsed;
  return { ...parsed, id, name: f.name.trim(), genre: f.genre.trim() || undefined, internationalShippingJpy: intl };
}

type Row = { candidate: Candidate; presetName: string; genre?: string; evaluation: Evaluation };

export default function ResearchDashboard() {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...loadJson<Partial<Settings>>(SETTINGS_KEY) }));
  // 計算条件の入力中の文字列（入力途中の空欄なども表示できるように文字列で持つ）
  const [settingInputs, setSettingInputs] = useState<Record<keyof Settings, string>>(
    () => Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])) as Record<keyof Settings, string>,
  );
  const [presets, setPresets] = useState<ResearchPreset[]>(() => loadJson<ResearchPreset[]>(PRESETS_KEY) ?? DEFAULT_PRESETS);
  const [criteria, setCriteria] = useState<TreasureCriteria>(() => {
    const saved = loadJson<Partial<TreasureCriteria>>(CRITERIA_KEY);
    // 回転率ランクの追加前に保存した条件は、売価の初期値（安い方から25%）を新しい初期値（売れている出品の価格）に切り替える
    if (saved && saved.minRank === undefined && saved.basis === "p25") saved.basis = DEFAULT_CRITERIA.basis;
    return { ...DEFAULT_CRITERIA, ...saved };
  });
  const [criteriaInputs, setCriteriaInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, String(v)])),
  );
  const [results, setResults] = useState<Record<string, PresetResult>>(() => loadJson(RESULTS_KEY) ?? {});
  const [onlyTreasures, setOnlyTreasures] = useState<boolean>(() => loadJson<boolean>(ONLY_TREASURES_KEY) ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<{ name: string; index: number; total: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; form: PresetForm; error?: string } | null>(null);
  const [genreFilter, setGenreFilter] = useState<string>(() => loadJson<string>(GENRE_FILTER_KEY) ?? "");
  const [showAllPresets, setShowAllPresets] = useState(false);
  const [csvMode, setCsvMode] = useState<CsvMode>("merge");
  const [csvText, setCsvText] = useState("");
  const [csvImport, setCsvImport] = useState<CsvImportResult | null>(null);
  const stopRequested = useRef(false);
  const rakutenCredentials = useRef<Promise<RakutenCredentials | null> | null>(null);
  const [quickText, setQuickText] = useState("");
  const [quickCondition, setQuickCondition] = useState<ItemCondition>("new");
  const [quickGenre, setQuickGenre] = useState("");
  const [quickSave, setQuickSave] = useState(true);
  const [discover, setDiscover] = useState<DiscoverOptions>(() => ({ ...DEFAULT_DISCOVER, ...loadJson<Partial<DiscoverOptions>>(DISCOVER_KEY) }));
  const [discoverLog, setDiscoverLog] = useState<string[]>([]);
  const quickLines = useMemo(
    () => parseQuickInput(quickText, { condition: quickCondition, genre: quickGenre }, () => crypto.randomUUID()),
    [quickText, quickCondition, quickGenre],
  );
  const quickPresets = quickLines.flatMap((l) => (l.preset ? [l.preset] : []));

  useEffect(() => saveJson(PRESETS_KEY, presets), [presets]);
  useEffect(() => saveJson(CRITERIA_KEY, criteria), [criteria]);
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings]);
  useEffect(() => saveJson(RESULTS_KEY, results), [results]);
  useEffect(() => saveJson(ONLY_TREASURES_KEY, onlyTreasures), [onlyTreasures]);
  useEffect(() => saveJson(GENRE_FILTER_KEY, genreFilter), [genreFilter]);
  useEffect(() => saveJson(DISCOVER_KEY, discover), [discover]);

  // ジャンルの一覧と、選んだジャンルの検索条件（ジャンルが消えていたら「すべて」に戻す）
  const genres = useMemo(
    () => [...new Set(presets.map((p) => p.genre).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ja")),
    [presets],
  );
  const activeGenre = genres.includes(genreFilter) ? genreFilter : "";
  const visiblePresets = activeGenre ? presets.filter((p) => p.genre === activeGenre) : presets;
  const listedPresets = showAllPresets ? visiblePresets : visiblePresets.slice(0, PRESET_PREVIEW_COUNT);

  // 全プリセットの結果を評価し、利益の大きい順に並べる（同じ商品は利益の大きい方だけ残す）
  const { rows, noMarket, total } = useMemo(() => {
    const byKey = new Map<string, Row>();
    let noMarket = 0;
    for (const [presetId, result] of Object.entries(results)) {
      const preset = presets.find((p) => p.id === presetId);
      // ジャンルで絞っているときは、そのジャンルの検索条件の結果だけ
      if (activeGenre && preset?.genre !== activeGenre) continue;
      for (const candidate of result.response.candidates) {
        const evaluation = evaluateCandidate(candidate, settings, criteria, preset?.internationalShippingJpy);
        if (!evaluation) {
          noMarket++;
          continue;
        }
        const prev = byKey.get(candidate.key);
        if (!prev || evaluation.profit.profitJpy > prev.evaluation.profit.profitJpy) {
          byKey.set(candidate.key, { candidate, presetName: result.presetName, genre: preset?.genre, evaluation });
        }
      }
    }
    const all = [...byKey.values()].sort((a, b) => b.evaluation.profit.profitJpy - a.evaluation.profit.profitJpy);
    return { rows: all, noMarket, total: all.length };
  }, [results, presets, settings, criteria, activeGenre]);

  const treasures = rows.filter((r) => r.evaluation.isTreasure);
  const visibleRows = onlyTreasures ? treasures : rows;

  /** 楽天のキー（ログイン済みのときだけサーバーから受け取る。未設定なら null）。1 回だけ取りに行く */
  function loadRakutenCredentials(): Promise<RakutenCredentials | null> {
    rakutenCredentials.current ??= fetch("/api/rakuten/credentials", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body?.configured ? { appId: body.appId, accessKey: body.accessKey, affiliateId: body.affiliateId } : null))
      .catch(() => null);
    return rakutenCredentials.current;
  }

  /**
   * 商品指定のとき、先に eBay 相場を調べて「これより安い国内商品は付属品」という最低価格を決める。
   * 楽天・Yahoo! の検索にこの最低価格を付けると、保護フィルムやケースなどの安い付属品で検索結果の枠が埋まらない。
   * 相場が取れないときや判定を無効（0%）にしているときは undefined
   */
  async function itemMinPrice(preset: ResearchPreset): Promise<number | undefined> {
    if (preset.kind !== "item" || criteria.minPriceRatioPercent <= 0) return undefined;
    try {
      const res = await fetch("/api/research/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preset),
      });
      if (!res.ok) return undefined;
      const median = (await res.json()).market?.medianUsd;
      return typeof median === "number" ? Math.floor((median * settings.usdJpy * criteria.minPriceRatioPercent) / 100) : undefined;
    } catch {
      return undefined;
    }
  }

  async function runPreset(preset: ResearchPreset): Promise<void> {
    setErrors((prev) => ({ ...prev, [preset.id]: "" }));
    try {
      // 楽天はブラウザから直接検索する（楽天が「許可されたWebサイト」をブラウザの送る URL で確認するため）。
      // 結果（またはエラー）をサーバーに渡し、サーバーは Yahoo! と eBay を調べる
      const autoMinPriceJpy = await itemMinPrice(preset);
      const target =
        autoMinPriceJpy !== undefined && autoMinPriceJpy > (preset.minPriceJpy ?? 0) ? { ...preset, minPriceJpy: autoMinPriceJpy } : preset;
      const creds = await loadRakutenCredentials();
      const rakuten: RakutenResult | undefined = creds ? await fetchRakuten(target, creds, window.location.origin) : undefined;
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, rakuten }),
      });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [preset.id]: body.error ?? `取得に失敗しました（HTTP ${res.status}）。` }));
        return;
      }
      setResults((prev) => ({
        ...prev,
        [preset.id]: { presetName: preset.name, response: body as ResearchResponse, autoMinPriceJpy: target === preset ? undefined : autoMinPriceJpy },
      }));
    } catch {
      setErrors((prev) => ({ ...prev, [preset.id]: "サーバーに接続できませんでした。" }));
    }
  }

  async function runPresets(targets: ResearchPreset[]) {
    stopRequested.current = false;
    for (const [index, preset] of targets.entries()) {
      // 「中止」が押されたら、今の検索条件が終わったところで止める
      if (stopRequested.current) break;
      setRunning({ name: preset.name, index: index + 1, total: targets.length });
      await runPreset(preset);
    }
    setRunning(null);
  }

  /** 直接入力した商品を調べる（保存するなら検索条件に追加・上書きしてから） */
  /**
   * 売れ筋から探す。選んだジャンルの楽天ランキングをブラウザから取得し（楽天の「許可されたWebサイト」の確認のため）、
   * サーバーで型番・JAN を取り出して eBay と比べる。結果はジャンルごとに通常の結果一覧へ入れる
   */
  async function handleDiscover() {
    const genres = RANKING_GENRES.filter((g) => discover.genreIds.includes(g.id));
    if (genres.length === 0) return;
    stopRequested.current = false;
    setDiscoverLog([]);
    const creds = await loadRakutenCredentials();
    if (!creds) {
      setDiscoverLog(["楽天のキー（RAKUTEN_APP_ID・RAKUTEN_ACCESS_KEY）が設定されていないため、ランキングを取得できません。"]);
      return;
    }
    const periodLabel = discover.period === "realtime" ? "リアルタイム" : "デイリー";
    for (const [index, genre] of genres.entries()) {
      if (stopRequested.current) break;
      setRunning({ name: `楽天ランキング ${genre.label}`, index: index + 1, total: genres.length });
      const candidates: Candidate[] = [];
      const warnings: string[] = [];
      const total: DiscoverStats = { received: 0, noIdentifier: 0, excluded: 0, duplicates: 0, checked: 0, salesChecked: 0 };
      for (let page = 1; page <= discover.pages && !stopRequested.current; page++) {
        const ranking = await fetchRakutenRanking({ genreId: genre.id, period: discover.period, page }, creds, window.location.origin);
        if ("error" in ranking) {
          warnings.push(ranking.error);
          break;
        }
        try {
          const res = await fetch("/api/discover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: ranking.offers, settings, criteria }),
          });
          if (res.status === 401) {
            window.location.reload();
            return;
          }
          const body = await res.json();
          if (!res.ok) {
            warnings.push(body.error ?? `売れ筋の調査に失敗しました（HTTP ${res.status}）。`);
            break;
          }
          candidates.push(...(body.candidates as Candidate[]));
          for (const k of Object.keys(total) as (keyof DiscoverStats)[]) total[k] += body.stats[k];
        } catch {
          warnings.push("サーバーに接続できませんでした。");
          break;
        }
      }
      const name = `楽天ランキング ${genre.label}（${periodLabel}）`;
      setDiscoverLog((prev) => [
        ...prev,
        `${genre.label}: ${total.received}件 → 型番なし ${total.noIdentifier}・付属品など ${total.excluded}・重複 ${total.duplicates} → eBay ${total.checked}件を調査（お宝候補 ${total.salesChecked}件は売れ行きも調査）`,
      ]);
      setResults((prev) => ({
        ...prev,
        [`rank-${genre.id}`]: {
          presetName: name,
          response: {
            candidates,
            skippedLookups: 0,
            stats: { rakuten: total.received, yahoo: null, excluded: total.excluded, unidentified: total.noIdentifier },
            warnings,
            fetchedAt: new Date().toISOString(),
          },
        },
      }));
    }
    setRunning(null);
  }

  async function handleQuickRun() {
    if (quickPresets.length === 0) return;
    let targets = quickPresets;
    if (quickSave) {
      const next = applyImportedPresets(presets, quickPresets, "merge");
      setPresets(next);
      // 同じ名前の条件があれば、その ID で実行する（結果が同じ条件にまとまるように）
      targets = quickPresets.map((q) => next.find((p) => p.name === q.name) ?? q);
    }
    await runPresets(targets);
  }

  function handleSettingChange(key: keyof Settings, value: string) {
    setSettingInputs((prev) => ({ ...prev, [key]: value }));
    const n = toNonNegativeNumber(value);
    if (n !== null) setSettings((prev) => ({ ...prev, [key]: n }));
  }

  function handleCriteriaChange(key: keyof TreasureCriteria, value: string) {
    setCriteriaInputs((prev) => ({ ...prev, [key]: value }));
    if (key === "basis") {
      setCriteria((prev) => ({ ...prev, basis: value as PriceBasis }));
      return;
    }
    if (key === "minRank") {
      setCriteria((prev) => ({ ...prev, minRank: value as MinRank }));
      return;
    }
    const n = toNonNegativeNumber(value);
    if (n !== null) setCriteria((prev) => ({ ...prev, [key]: n }));
  }

  function handleSavePreset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const preset = fromForm(editing.id, editing.form);
    if (typeof preset === "string") {
      setEditing({ ...editing, error: preset });
      return;
    }
    setPresets((prev) =>
      prev.some((p) => p.id === preset.id) ? prev.map((p) => (p.id === preset.id ? preset : p)) : [...prev, preset],
    );
    setEditing(null);
  }

  async function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCsvImport(presetsFromCsv(decodeCsvBytes(await file.arrayBuffer()), () => crypto.randomUUID()));
  }

  function handleApplyCsv() {
    if (!csvImport) return;
    if (csvMode === "replace" && !window.confirm(`今の検索条件 ${presets.length} 件を、読み込んだ ${csvImport.presets.length} 件に置き換えますか？`)) {
      return;
    }
    const next = applyImportedPresets(presets, csvImport.presets, csvMode);
    const ids = new Set(next.map((p) => p.id));
    setPresets(next);
    // 消えた検索条件の結果は消す
    setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
    setCsvImport(null);
    setCsvText("");
    setShowAllPresets(false);
  }

  function handleDeletePreset(preset: ResearchPreset) {
    if (!window.confirm(`検索条件「${preset.name}」を削除しますか？`)) return;
    setPresets((prev) => prev.filter((p) => p.id !== preset.id));
    setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== preset.id)));
  }

  const busy = running !== null;
  // 同じ注意はまとめて、どの検索条件で出たかを添える
  const allWarnings = [
    ...Object.values(results)
      .flatMap((r) => r.response.warnings.map((w) => [w, r.presetName] as const))
      .reduce((map, [w, name]) => map.set(w, [...(map.get(w) ?? []), name]), new Map<string, string[]>()),
  ];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 pt-2 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:pt-4">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">国内仕入れ × eBay 自動リサーチ</h1>
          <form method="post" action="/api/logout" className="shrink-0">
            <button type="submit" className="min-h-11 px-2 text-sm underline opacity-70 active:opacity-100">
              ログアウト
            </button>
          </form>
        </div>
        <p className="text-sm opacity-80">
          楽天・Yahoo!ショッピングの商品を JAN コードやカード番号で識別し、eBay の出品中価格と比べて利益を計算します。
        </p>
      </header>

      {/* お宝の条件 */}
      <details className="group rounded-lg border border-black/10 dark:border-white/15">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
          <span className="font-semibold">お宝の条件</span>
          <span className="flex items-center gap-2 text-sm opacity-70">
            {yen.format(criteria.minProfitJpy)}以上・{criteria.minMarginPercent}%以上
            <span aria-hidden className="transition-transform group-open:rotate-180">
              ▼
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <NumberField label="利益（円以上）" value={criteriaInputs.minProfitJpy} onChange={(v) => handleCriteriaChange("minProfitJpy", v)} />
            <NumberField label="利益率（%以上）" value={criteriaInputs.minMarginPercent} onChange={(v) => handleCriteriaChange("minMarginPercent", v)} />
            <NumberField
              label="eBay の比較件数（件以上）"
              value={criteriaInputs.minEbayListings}
              onChange={(v) => handleCriteriaChange("minEbayListings", v)}
            />
            <NumberField
              label="付属品とみなす価格（eBay 相場の%未満）"
              value={criteriaInputs.minPriceRatioPercent}
              onChange={(v) => handleCriteriaChange("minPriceRatioPercent", v)}
            />
            <NumberField
              label="送料別のときの国内送料（円）"
              value={criteriaInputs.domesticShippingJpy}
              onChange={(v) => handleCriteriaChange("domesticShippingJpy", v)}
            />
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-sm lg:col-span-1">
              <span>eBay 売価として使う値</span>
              <select value={criteria.basis} onChange={(e) => handleCriteriaChange("basis", e.target.value)} className={INPUT_CLASS}>
                {PRICE_BASES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-sm lg:col-span-1">
              <span>回転率ランク（推定）</span>
              <select value={criteria.minRank} onChange={(e) => handleCriteriaChange("minRank", e.target.value)} className={INPUT_CLASS}>
                {MIN_RANKS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs opacity-60">
            eBay の落札データ（Sold）は API で取得できないため、複数個まとめて出品されている商品の「売れた数」から実売価格と回転率を推定しています。
            中古の 1 点ものは販売数が分からず「?（不明）」になるので、「eBay 落札済み」で確認してください。
          </p>
        </div>
      </details>

      {/* 計算条件（為替・手数料・国際送料） */}
      <details className="group rounded-lg border border-black/10 dark:border-white/15">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
          <span className="font-semibold">計算条件</span>
          <span className="flex items-center gap-2 text-sm opacity-70">
            為替 {settings.usdJpy} 円/USD
            <span aria-hidden className="transition-transform group-open:rotate-180">
              ▼
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {SETTING_FIELDS.map(({ key, label }) => (
              <NumberField key={key} label={label} value={settingInputs[key]} onChange={(v) => handleSettingChange(key, v)} />
            ))}
          </div>
          <p className="text-xs opacity-60">
            利益 =（eBay 売価 − eBay 手数料）× 為替 −（国内の仕入れ値 + 国内送料）− 国際送料。
            国際送料は検索条件ごとに設定でき、未設定の条件にはここの値を使います。手数料率は目安なので、最新の eBay 手数料に合わせて変更してください。
          </p>
        </div>
      </details>

      <DiscoverSection
        options={discover}
        onChange={setDiscover}
        onRun={handleDiscover}
        log={discoverLog}
        busy={busy}
      />

      <QuickInput
        text={quickText}
        onTextChange={setQuickText}
        condition={quickCondition}
        onConditionChange={setQuickCondition}
        genre={quickGenre}
        onGenreChange={setQuickGenre}
        save={quickSave}
        onSaveChange={setQuickSave}
        lines={quickLines}
        onRun={handleQuickRun}
        busy={busy}
      />

      {/* 検索条件（プリセット） */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">
            検索条件 <span className="text-sm font-normal opacity-60">{visiblePresets.length}件</span>
          </h2>
          <button
            type="button"
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                form: toForm({ id: "", name: "", kind: "item", keyword: "", ngWords: [], condition: "new", genre: activeGenre || undefined }),
              })
            }
            disabled={busy}
            className="min-h-11 px-2 text-sm underline active:opacity-70 disabled:opacity-40"
          >
            ＋ 追加
          </button>
        </div>
        {genres.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0">ジャンル</span>
            <select
              value={activeGenre}
              onChange={(e) => {
                setGenreFilter(e.target.value);
                setShowAllPresets(false);
              }}
              className={INPUT_CLASS}
            >
              <option value="">すべて（{presets.length}件）</option>
              {genres.map((g) => (
                <option key={g} value={g}>
                  {g}（{presets.filter((p) => p.genre === g).length}件）
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="space-y-2">
          {listedPresets.map((preset) => {
            const result = results[preset.id];
            return (
              <li key={preset.id} className="rounded-lg border border-black/10 p-3 dark:border-white/15">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{preset.name}</div>
                    <div className="truncate text-xs opacity-60">
                      {preset.genre && `${preset.genre} ・ `}
                      {kindLabel(preset.kind)}
                      {preset.kind === "item" && `（${ITEM_CONDITIONS.find((c) => c.id === (preset.condition ?? "new"))?.label}）`} ・「
                      {preset.keyword || `JAN ${preset.jan}`}」
                      {result && ` ・ ${dateTime.format(new Date(result.response.fetchedAt))} 取得`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => runPresets([preset])}
                    disabled={busy}
                    className="min-h-11 shrink-0 rounded-lg border border-black/30 px-4 text-sm active:bg-black/5 disabled:opacity-40 dark:border-white/30"
                  >
                    実行
                  </button>
                </div>
                <div className="mt-1 flex gap-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: preset.id, form: toForm(preset) })}
                    disabled={busy}
                    className="min-h-11 px-2 underline opacity-70 disabled:opacity-40"
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePreset(preset)}
                    disabled={busy}
                    className="min-h-11 px-2 text-red-600 underline opacity-80 disabled:opacity-40"
                  >
                    削除
                  </button>
                </div>
                {errors[preset.id] && <p className="text-sm text-red-600">{errors[preset.id]}</p>}
                {result && <ResultStats response={result.response} autoMinPriceJpy={result.autoMinPriceJpy} />}
              </li>
            );
          })}
        </ul>
        {visiblePresets.length > PRESET_PREVIEW_COUNT && (
          <button type="button" onClick={() => setShowAllPresets(!showAllPresets)} className="min-h-11 px-2 text-sm underline opacity-80">
            {showAllPresets ? "折りたたむ" : `残り ${visiblePresets.length - PRESET_PREVIEW_COUNT} 件を表示`}
          </button>
        )}

        {editing && (
          <PresetEditor
            form={editing.form}
            error={editing.error}
            onChange={(form) => setEditing({ ...editing, form, error: undefined })}
            onSubmit={handleSavePreset}
            onCancel={() => setEditing(null)}
          />
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => runPresets(visiblePresets)}
            disabled={busy || visiblePresets.length === 0}
            className="min-h-12 w-full rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 disabled:opacity-50 sm:w-auto"
          >
            {running
              ? `「${running.name}」を検索中…（${running.index}/${running.total}）`
              : `${activeGenre ? `「${activeGenre}」の` : "すべての"}条件でリサーチ（${visiblePresets.length}件）`}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => (stopRequested.current = true)}
              className="min-h-12 rounded-lg border border-red-600/60 px-6 text-base text-red-600 active:opacity-70"
            >
              中止
            </button>
          )}
        </div>
        <p className="text-xs opacity-60">
          1 つの条件につき 5〜30 秒ほどかかります（商品指定は 1 商品なので速め）。eBay の相場は出品中（即決）の価格です（落札履歴は eBay の API の制限で取得できないため、各商品の「eBay 落札済み」から確認できます）。
        </p>

        <CsvTools
          presets={presets}
          mode={csvMode}
          onModeChange={setCsvMode}
          text={csvText}
          onTextChange={setCsvText}
          onParseText={() => setCsvImport(presetsFromCsv(csvText, () => crypto.randomUUID()))}
          onFile={handleCsvFile}
          preview={csvImport}
          onApply={handleApplyCsv}
          onCancel={() => setCsvImport(null)}
          disabled={busy}
        />
      </section>

      {allWarnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          {allWarnings.map(([w, names]) => (
            <li key={w}>
              ⚠ {w}
              <span className="block text-xs opacity-70">対象の検索条件: {names.join("、")}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 結果 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            お宝 {treasures.length} 件 <span className="text-sm font-normal opacity-60">/ 相場の取れた商品 {total} 件</span>
          </h2>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyTreasures} onChange={(e) => setOnlyTreasures(e.target.checked)} className="h-5 w-5" />
            お宝だけ表示
          </label>
        </div>

        {Object.keys(results).length === 0 ? (
          <p className="text-sm opacity-70">まだ結果がありません。「すべての条件でリサーチ」を押してください。</p>
        ) : visibleRows.length === 0 ? (
          <p className="text-sm opacity-70">
            条件を満たす商品はありませんでした。「お宝だけ表示」を外すと、調べたすべての商品を利益の大きい順に見られます。
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {visibleRows.map((row) => (
              <CandidateCard key={row.candidate.key} row={row} criteria={criteria} />
            ))}
          </ul>
        )}
        {noMarket > 0 && <p className="text-xs opacity-60">eBay の相場が取れなかった商品が {noMarket} 件あります（一覧には出していません）。</p>}
      </section>

      <footer className="space-y-1 border-t border-black/10 pt-4 text-xs opacity-70 dark:border-white/15">
        <p>※ 利益は出品中価格にもとづく目安です。関税・消費税還付・返品リスク・価格の変動は含みません。仕入れ前に各サイトで確認してください。</p>
        <p className="flex flex-wrap gap-x-4">
          {/* 各 API の利用規約で求められているクレジット表記 */}
          <a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener noreferrer" className="underline">
            Supported by Rakuten Developers
          </a>
          <a href="https://developer.yahoo.co.jp/sitemap/" target="_blank" rel="noopener noreferrer" className="underline">
            Webサービス by Yahoo! JAPAN
          </a>
        </p>
      </footer>
    </main>
  );
}

function ResultStats({ response, autoMinPriceJpy }: { response: ResearchResponse; autoMinPriceJpy?: number }) {
  const { stats } = response;
  const count = (n: number | null) => (n === null ? "—" : `${n}件`);
  return (
    <p className="mt-1 text-xs opacity-60">
      楽天 {count(stats.rakuten)}・Yahoo! {count(stats.yahoo)} → 除外 {stats.excluded}件・識別できず {stats.unidentified}件 → 商品{" "}
      {response.candidates.length}件を eBay で調査
      {response.skippedLookups > 0 && `（上限のため ${response.skippedLookups}件は未調査）`}
      {autoMinPriceJpy !== undefined && `・付属品を除くため ${yen.format(autoMinPriceJpy)} 以上で検索`}
    </p>
  );
}

function PresetEditor({
  form,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: PresetForm;
  error?: string;
  onChange: (form: PresetForm) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const set = (key: keyof PresetForm) => (value: string) => onChange({ ...form, [key]: value });
  const kindHint = RESEARCH_KINDS.find((k) => k.id === form.kind)?.hint;
  const isItem = form.kind === "item";
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-black/20 p-4 dark:border-white/25">
      <h3 className="font-semibold">検索条件の編集</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="名前 *" value={form.name} onChange={set("name")} />
        <TextField label="ジャンル（例: カメラ・釣具）" value={form.genre} onChange={set("genre")} />
        <label className="flex min-w-0 flex-col gap-1 text-sm sm:col-span-2">
          <span>種類</span>
          <select value={form.kind} onChange={(e) => set("kind")(e.target.value)} className={INPUT_CLASS}>
            {RESEARCH_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          {kindHint && <span className="text-xs opacity-60">{kindHint}</span>}
        </label>
        <div className="sm:col-span-2">
          <TextField
            label={isItem ? "楽天・Yahoo! の検索キーワード（JAN があれば省略可）" : "楽天・Yahoo! の検索キーワード *"}
            value={form.keyword}
            onChange={set("keyword")}
          />
          {isItem && (
            <p className="mt-1 text-xs opacity-60">
              タイトルにキーワードの単語がすべて含まれる商品だけを比べます（例:「ニコン F3 ボディ」）。
            </p>
          )}
        </div>
        {isItem && (
          <>
            <div className="sm:col-span-2">
              <TextField label="eBay 用の英語キーワード（JAN がなければ必須）" value={form.ebayKeyword} onChange={set("ebayKeyword")} />
              <p className="mt-1 text-xs opacity-60">
                eBay の出品タイトルに単語がすべて含まれるものだけを比べます（例: Nikon F3 body）。JAN があるときは、JAN で見つからなかったときに使います。
              </p>
            </div>
            <TextField label="JAN コード（任意）" value={form.jan} onChange={set("jan")} />
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span>状態</span>
              <select value={form.condition} onChange={(e) => set("condition")(e.target.value)} className={INPUT_CLASS}>
                {ITEM_CONDITIONS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="sm:col-span-2">
          <TextField label="除外ワード（スペース区切り）" value={form.ngWords} onChange={set("ngWords")} />
          <p className="mt-1 text-xs opacity-60">
            {isItem
              ? "ジャンク・部品取り・故障・難あり・予約品などは最初から除外しています。"
              : "オリパ・くじ・スリーブなどの周辺グッズ・予約品は最初から除外しています。"}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <NumberField label="最低価格（円）" value={form.minPriceJpy} onChange={set("minPriceJpy")} />
          <NumberField label="最高価格（円）" value={form.maxPriceJpy} onChange={set("maxPriceJpy")} />
          <NumberField label="国際送料（円）" value={form.internationalShippingJpy} onChange={set("internationalShippingJpy")} />
          {!isItem && (
            <NumberField label={`eBay で調べる件数（最大 ${MAX_LOOKUPS_LIMIT}）`} value={form.maxLookups} onChange={set("maxLookups")} />
          )}
        </div>
        {(form.kind === "sealed" || form.kind === "other") && (
          <div className="sm:col-span-2">
            <TextField label="eBay 用の英語キーワード（任意）" value={form.ebayKeyword} onChange={set("ebayKeyword")} />
            <p className="mt-1 text-xs opacity-60">
              JAN で eBay に見つからないときに使います。1 つの商品に絞った検索条件のときだけ入れてください（例: Terastal Festival booster box japanese）。
            </p>
          </div>
        )}
      </div>
      {!isItem && <p className="text-xs opacity-60">未入力の eBay 調査件数は {DEFAULT_MAX_LOOKUPS} 件です。</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="min-h-12 flex-1 rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 sm:flex-none">
          保存
        </button>
        <button type="button" onClick={onCancel} className="min-h-12 rounded-lg border border-black/30 px-6 text-base dark:border-white/30">
          やめる
        </button>
      </div>
    </form>
  );
}

function DiscoverSection({
  options,
  onChange,
  onRun,
  log,
  busy,
}: {
  options: DiscoverOptions;
  onChange: (options: DiscoverOptions) => void;
  onRun: () => void;
  log: string[];
  busy: boolean;
}) {
  const toggle = (id: string) =>
    onChange({
      ...options,
      genreIds: options.genreIds.includes(id) ? options.genreIds.filter((g) => g !== id) : [...options.genreIds, id],
    });
  return (
    <section className="space-y-3 rounded-lg border border-black/20 p-4 dark:border-white/25">
      <h2 className="font-semibold">売れ筋から探す（楽天ランキング）</h2>
      <p className="text-xs opacity-70">
        選んだジャンルの楽天ランキングから型番・JAN を自動で取り出し、eBay の相場と比べます。型番を入力する必要はありません。
      </p>
      <div className="flex flex-wrap gap-2">
        {RANKING_GENRES.map((g) => {
          const on = options.genreIds.includes(g.id);
          return (
            <button
              key={g.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(g.id)}
              className={`min-h-11 rounded-full border px-3 text-sm ${
                on ? "border-foreground bg-foreground text-background" : "border-black/25 dark:border-white/30"
              }`}
            >
              {g.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span>ランキング</span>
          <select
            value={options.period}
            onChange={(e) => onChange({ ...options, period: e.target.value as RankingPeriod })}
            className={INPUT_CLASS}
          >
            <option value="realtime">リアルタイム</option>
            <option value="daily">デイリー</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span>調べる順位</span>
          <select value={options.pages} onChange={(e) => onChange({ ...options, pages: Number(e.target.value) })} className={INPUT_CLASS}>
            <option value={1}>上位 30 位</option>
            <option value={2}>上位 60 位</option>
            <option value={3}>上位 90 位</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={busy || options.genreIds.length === 0}
        className="min-h-12 w-full rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 disabled:opacity-50 sm:w-auto"
      >
        ランキングから探す（{options.genreIds.length} ジャンル）
      </button>
      <p className="text-xs opacity-60">
        1 ジャンル（30 位まで）につき 20〜40 秒ほどかかります。eBay の利用回数を抑えるため、売れ行き（回転率）はお宝候補だけ調べます。
      </p>
      {log.length > 0 && (
        <ul className="space-y-0.5 text-xs opacity-80">
          {log.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QuickInput({
  text,
  onTextChange,
  condition,
  onConditionChange,
  genre,
  onGenreChange,
  save,
  onSaveChange,
  lines,
  onRun,
  busy,
}: {
  text: string;
  onTextChange: (text: string) => void;
  condition: ItemCondition;
  onConditionChange: (condition: ItemCondition) => void;
  genre: string;
  onGenreChange: (genre: string) => void;
  save: boolean;
  onSaveChange: (save: boolean) => void;
  lines: QuickLine[];
  onRun: () => void;
  busy: boolean;
}) {
  const valid = lines.filter((l) => l.preset).length;
  return (
    <section className="space-y-3 rounded-lg border border-black/20 p-4 dark:border-white/25">
      <h2 className="font-semibold">型番・商品名で調べる</h2>
      <label className="flex flex-col gap-1 text-sm">
        <span>1 行に 1 商品（型番・商品名・JAN）</span>
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          rows={4}
          placeholder={"BOSS DS-1\nキヤノン AE-1\nニコン F3 ボディ | Nikon F3 body\n4521329362342"}
          className="w-full rounded-lg border border-black/20 bg-transparent p-3 text-base dark:border-white/25"
        />
      </label>
      <p className="text-xs opacity-60">
        eBay は英語で検索します。型番が入っていればそのまま使います。日本語の商品名だけのときは「ニコン F3 ボディ | Nikon F3 body」のように、| の後に英語を書いてください。
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span>状態</span>
          <select value={condition} onChange={(e) => onConditionChange(e.target.value as ItemCondition)} className={INPUT_CLASS}>
            {ITEM_CONDITIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <TextField label="ジャンル（任意）" value={genre} onChange={onGenreChange} />
      </div>

      {lines.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="入力の確認">
          {lines.map((l) => (
            <li key={l.line} className={l.error ? "text-red-600" : "opacity-80"}>
              {l.preset ? (
                <>
                  ✓ {l.line}行目 国内「{l.preset.keyword || `JAN ${l.preset.jan}`}」→ eBay「{l.preset.ebayKeyword ?? `JAN ${l.preset.jan}`}」
                  {l.preset.ebayKeyword && !l.text.includes("|") && l.preset.ebayKeyword !== l.preset.keyword && "（自動）"}
                </>
              ) : (
                <>
                  ✗ {l.line}行目「{l.text}」: {l.error}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={save} onChange={(e) => onSaveChange(e.target.checked)} className="h-5 w-5" />
        検索条件として保存する（次から「実行」だけで調べ直せます）
      </label>
      <button
        type="button"
        onClick={onRun}
        disabled={busy || valid === 0}
        className="min-h-12 w-full rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 disabled:opacity-50 sm:w-auto"
      >
        {valid > 0 ? `調べる（${valid}件）` : "調べる"}
      </button>
    </section>
  );
}

function CsvTools({
  presets,
  mode,
  onModeChange,
  text,
  onTextChange,
  onParseText,
  onFile,
  preview,
  onApply,
  onCancel,
  disabled,
}: {
  presets: ResearchPreset[];
  mode: CsvMode;
  onModeChange: (mode: CsvMode) => void;
  text: string;
  onTextChange: (text: string) => void;
  onParseText: () => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  preview: CsvImportResult | null;
  onApply: () => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const existingNames = new Set(presets.map((p) => p.name));
  const updates = preview && mode === "merge" ? preview.presets.filter((p) => existingNames.has(p.name)).length : 0;
  const secondaryButton =
    "flex min-h-12 items-center justify-center rounded-lg border border-black/25 px-3 text-center text-sm active:opacity-70 dark:border-white/30";

  return (
    <details className="group rounded-lg border border-black/10 dark:border-white/15">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">CSV でまとめて登録・書き出し</span>
        <span aria-hidden className="text-sm opacity-70 transition-transform group-open:rotate-180">
          ▼
        </span>
      </summary>
      <div className="space-y-3 border-t border-black/10 p-4 text-sm dark:border-white/15">
        <p className="text-xs opacity-70">
          1 行 = 1 つの検索条件です。見出しは「名前・ジャンル・種類・検索キーワード・JAN・eBayキーワード・状態・除外ワード・最低価格・最高価格・国際送料・eBay調査件数」（名前以外は省略可）。
          Excel で保存した CSV（Shift_JIS）もそのまま読めます。まずテンプレートをダウンロードして書き換えるのがおすすめです。
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => downloadCsv("research-template.csv", CSV_TEMPLATE)} className={secondaryButton}>
            テンプレート
          </button>
          <button
            type="button"
            onClick={() => downloadCsv(`research-presets-${new Date().toISOString().slice(0, 10)}.csv`, presetsToCsv(presets))}
            disabled={presets.length === 0}
            className={`${secondaryButton} disabled:opacity-40`}
          >
            今の条件を書き出す（{presets.length}件）
          </button>
        </div>

        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs opacity-70">読み込み方</legend>
          {(
            [
              ["merge", "追加（同じ名前の条件は上書き）"],
              ["replace", "すべて置き換え"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="csv-mode" checked={mode === value} onChange={() => onModeChange(value)} className="h-5 w-5" />
              {label}
            </label>
          ))}
        </fieldset>

        <label className={`${secondaryButton} cursor-pointer bg-foreground font-medium text-background ${disabled ? "pointer-events-none opacity-40" : ""}`}>
          CSV ファイルを選んで読み込む
          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" onChange={onFile} className="sr-only" disabled={disabled} />
        </label>

        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-xs underline opacity-70">または、表を貼り付けて読み込む</summary>
          <textarea
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            rows={5}
            placeholder={"名前,ジャンル,検索キーワード,eBayキーワード,状態\nBOSS DS-1,エフェクター,BOSS DS-1,Boss DS-1,中古"}
            className="mt-1 w-full rounded-lg border border-black/20 bg-transparent p-3 font-mono text-base dark:border-white/25"
          />
          <button type="button" onClick={onParseText} disabled={disabled || text.trim() === ""} className={`${secondaryButton} mt-2 w-full disabled:opacity-40`}>
            貼り付けた内容を読み込む
          </button>
        </details>

        {preview && (
          <div className="space-y-2 rounded-lg border border-black/20 p-3 dark:border-white/25" role="status">
            <p className="font-medium">
              読み込める条件 {preview.presets.length} 件
              {mode === "merge" && `（新規 ${preview.presets.length - updates} 件・上書き ${updates} 件）`}
              {preview.errors.length > 0 && <span className="text-red-600"> ／ 読み込めない行 {preview.errors.length} 件</span>}
            </p>
            {preview.errors.length > 0 && (
              <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-red-600">
                {preview.errors.map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    {e.line} 行目: {e.message}
                  </li>
                ))}
              </ul>
            )}
            {preview.ignoredColumns.length > 0 && (
              <p className="text-xs opacity-70">知らない列は読み飛ばしました: {preview.ignoredColumns.join("、")}</p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onApply}
                disabled={preview.presets.length === 0}
                className="min-h-12 flex-1 rounded-lg bg-foreground px-4 text-base font-medium text-background active:opacity-80 disabled:opacity-40"
              >
                {mode === "replace" ? "置き換える" : "登録する"}
              </button>
              <button type="button" onClick={onCancel} className="min-h-12 rounded-lg border border-black/30 px-4 text-base dark:border-white/30">
                やめる
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function shippingNote(offer: DomesticOffer, criteria: TreasureCriteria): string {
  if (offer.shipping === "free") return "送料無料";
  const label = offer.shipping === "extra" ? "送料別" : "送料条件あり";
  return `${label}（+${yen.format(criteria.domesticShippingJpy)}で計算）`;
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

function CandidateCard({ row, criteria }: { row: Row; criteria: TreasureCriteria }) {
  const { candidate, presetName, evaluation } = row;
  const { offer, profit } = evaluation;
  const ebay = candidate.ebay!;
  const cheapestBy = (source: DomesticOffer["source"]) => candidate.offers.find((o) => o.source === source);
  const rakuten = cheapestBy("rakuten");
  const yahoo = cheapestBy("yahoo");

  return (
    <li className={`rounded-lg border p-4 ${evaluation.isTreasure ? "border-green-600/60" : "border-black/10 dark:border-white/15"}`}>
      <div className="flex gap-3">
        {offer.imageUrl && (
          // 楽天・Yahoo! の画像サーバーの画像をそのまま表示する
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={offer.imageUrl}
            alt=""
            loading="lazy"
            onError={(e) => (e.currentTarget.style.display = "none")}
            className="h-16 w-16 shrink-0 rounded object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs opacity-60">
            {evaluation.isTreasure && <span className="mr-1 rounded bg-green-600 px-1 font-semibold text-white">お宝</span>}
            {[candidate.label, row.genre, presetName].filter(Boolean).join(" ・ ")}
          </div>
          <div className="line-clamp-2 text-sm font-medium break-words">{offer.title}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-lg font-bold ${profit.profitJpy >= 0 ? "text-green-600" : "text-red-600"}`}>{yen.format(profit.profitJpy)}</div>
          <div className="text-xs opacity-70">利益率 {profit.marginPercent.toFixed(1)}%</div>
          <div
            className={`mt-1 inline-block rounded px-1.5 text-xs font-bold ${RANK_STYLE[evaluation.rank]}`}
            title={RANK_INFO[evaluation.rank].hint}
          >
            回転 {RANK_INFO[evaluation.rank].label}
          </div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="opacity-70">仕入れ</dt>
        <dd className="text-right">
          {yen.format(evaluation.purchaseJpy)}
          <span className="block text-xs opacity-60">
            {SOURCE_LABEL[offer.source]} {offer.shopName} ・ {shippingNote(offer, criteria)}
          </span>
        </dd>
        <dt className="opacity-70">eBay 売価</dt>
        <dd className="text-right">
          {usd.format(evaluation.ebayPriceUsd)}
          <span className="block text-xs opacity-60">
            {BASIS_SHORT[evaluation.usedBasis]}・比較 {ebay.count}件（ヒット {ebay.total}件）
            {ebay.locations && ` ・ 発送元 日本 ${ebay.locations.jp}件／海外 ${ebay.locations.other}件`}
          </span>
        </dd>
        <dt className="opacity-70">売れ行き</dt>
        <dd className="text-right">
          {RANK_INFO[evaluation.rank].hint}
          {ebay.sales && ebay.sales.multiQuantityListings > 0 && (
            <span className="block text-xs opacity-60">
              推定 月 {ebay.sales.estimatedMonthlySales} 個・まとめ出品 {ebay.sales.multiQuantityListings}/{ebay.sales.checkedListings} 件で計 {ebay.sales.soldTotal} 個販売
            </span>
          )}
        </dd>
        <dt className="opacity-70">手数料・送料</dt>
        <dd className="text-right">
          {usd.format(profit.ebayFeesUsd)} ＋ 国際送料 {yen.format(profit.totalCostJpy - evaluation.purchaseJpy)}
        </dd>
      </dl>

      {evaluation.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
          {evaluation.notes.map((n) => (
            <li key={n}>⚠ {n}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {rakuten && (
          <LinkButton href={rakuten.url} primary={offer === rakuten}>
            楽天 {yen.format(rakuten.priceJpy)}
          </LinkButton>
        )}
        {yahoo && (
          <LinkButton href={yahoo.url} primary={offer === yahoo}>
            Yahoo! {yen.format(yahoo.priceJpy)}
          </LinkButton>
        )}
        <LinkButton href={ebay.activeUrl}>eBay 出品中</LinkButton>
        <LinkButton href={ebay.soldUrl}>eBay 落札済み</LinkButton>
      </div>

      {ebay.samples.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="flex min-h-11 cursor-pointer items-center opacity-70">比較した eBay の出品（安い順）</summary>
          <ul>
            {ebay.samples.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="block min-h-11 py-2 underline">
                  {usd.format(s.priceUsd)} {s.title}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
